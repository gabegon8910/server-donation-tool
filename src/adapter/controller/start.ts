import {NextFunction, Request, Response, Router} from 'express';
import {requireAuthentication} from '../../auth';
import {PriorityQueueItem, ServerApiId, SteamId64} from 'cftools-sdk';
import {Constants, DiscordAPIError} from 'discord.js';
import {AppConfig} from '../../domain/app-config';
import {PriorityQueue} from '../../domain/user';
import {Package, Perk, Price, PriceType} from '../../domain/package';
import {PriorityQueuePerk} from '../perk/priority-queue-perk';
import {DiscordRolePerk} from '../perk/discord-role-perk';
import {Logger} from 'winston';

export class StartController {
    public readonly router: Router = Router();

    constructor(private readonly config: AppConfig, private readonly log: Logger) {
        this.router.post('/selectPackage', requireAuthentication, this.selectPackage.bind(this));
        this.router.get('/', requireAuthentication, this.populatePriorityQueue.bind(this), this.populateDiscordRoles.bind(this), this.startPage.bind(this));
    }

    private async startPage(req: Request, res: Response) {
        const serversWithPrio = Object.entries(req.user.priorityQueue).filter((s: [string, PriorityQueue]) => s[1].active);

        res.render('index', {
            user: req.user,
            serversWithPrio: serversWithPrio,
            availablePackages: this.config.packages,
            step: 'PACKAGE_SELECTION',
        });
    }

    private price(req: Request, pack: Package): Price {
        const price = pack.price;
        if (req.body[`price-${pack.id}`]) {
            if (pack.price.type === PriceType.FIXED) {
                throw Error('VariablePriceForFixedPackage');
            }
            let amount = req.body[`price-${pack.id}`].replace(',', '.');
            if (Math.sign(amount) !== 1) {
                throw new Error('Invalid variable price detected: ' + amount);
            }
            price.amount = amount;
        }
        return price;
    }

    private async selectPackage(req: Request, res: Response) {
        const selectedPackage = this.config.packages.find((p) => p.id === parseInt(req.body.package));
        if (!selectedPackage) {
            res.redirect('/');
        }

        try {
            req.session.selectedPackage = {
                id: selectedPackage.id,
                price: this.price(req, selectedPackage),
            };
            res.redirect('/donate');
        } catch (e) {
            if (e.message === 'VariablePriceForFixedPackage') {
                this.log.warn(`Discord user ${req.user.discord.id} requested variable price for fixed package.`);
                res.redirect('/');
            } else {
                throw e;
            }
        }
    }

    private perks(): Perk[] {
        return this.config.packages.map((p) => p.perks).reduce((l, p) => l.concat(p));
    }

    private async fetchPriorityQueue(req: Request, server: string): Promise<PriorityQueue> {
        try {
            const entry = await this.config.cfToolscClient().getPriorityQueue({
                playerId: SteamId64.of(req.user.steam.id),
                serverApiId: ServerApiId.of(server),
            });
            if (entry === null) {
                return {
                    active: false,
                };
            }
            return {
                active: !this.isExpired(entry),
                expires: entry.expiration,
            }
        } catch (e) {
            this.log.error(`Could not request Priority queue information for server API ID: ${server}. Error: ` + e);
            throw e;
        }
    }

    private async populatePriorityQueue(req: Request, res: Response, next: NextFunction): Promise<void> {
        const priority: { [key: string]: PriorityQueue } = {};
        await Promise.all(this.perks()
            .filter((p) => p instanceof PriorityQueuePerk)
            .map((p: PriorityQueuePerk) => p.cftools.serverApiId)
            .map(async (server) => {
                priority[server] = await this.fetchPriorityQueue(req, server);
            }));

        req.user.priorityQueue = priority;
        next();
    }

    private isExpired(p: PriorityQueueItem): boolean {
        if (p.expiration === 'Permanent') {
            return false;
        }
        return p.expiration.getTime() <= new Date().getTime();
    }

    private async populateDiscordRoles(req: Request, res: Response, next: NextFunction): Promise<void> {
        const client = await this.config.discordClient();
        const guild = await client.guilds.fetch(this.config.discord.bot.guildId);

        let guildMember;
        try {
            guildMember = await guild.members.fetch(req.user.discord.id);
        } catch (e) {
            if (e instanceof DiscordAPIError && e.code === Constants.APIErrors.UNKNOWN_MEMBER && this.config.app.community?.discord) {
                res.redirect(this.config.app.community.discord);
                return;
            }
            throw e;
        }

        const perkRoles = this.perks()
            .filter((p) => p instanceof DiscordRolePerk)
            .map((p) => (p as DiscordRolePerk).roles)
            .reduce((l, p) => l.concat(p));

        req.user.discordRoles = guildMember.roles.cache.filter((r) => perkRoles.includes(r.id)).map((r) => r.name);
        next();
    }
}
