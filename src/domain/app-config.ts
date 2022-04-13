import {DiscordNotification} from '../adapter/discord/discord-notifier';
import {PathLike} from 'fs';

export interface Properties {
    find(context: string, key: string): Promise<any | null>

    set(context: string, key: string, value: any): Promise<void>

    delete(context: string, key: string): Promise<void>
}

export type ServerNames = {
    [serverApiId: string]: string
};

export type LbAgPgServer = {
    apiUrl: string;
    apiKey: string;
    serverName: string;
}

export interface AppConfig {
    app: {
        port: number,
        publicUrl: URL,
        sessionSecret: string,
        sessionStore: {
            filename: string,
        },
        language?: string,
        compressResponse: boolean,
        community?: {
            title?: string,
            logo?: string,
            discord?: string,
            donationTarget?: {
                discordChannelId: string,
                monthly?: number,
            },
        },
        googleAnalytics?: {
            trackingId: string,
        },
        privacyPolicy: {
            partials: PathLike[]
        },
    },
    discord: {
        clientId: string,
        clientSecret: string,
        redirectUrl: string,
        bot?: {
            token: string,
            guildId: string,
            expireRolesEvery?: number,
        },
        notifications?: DiscordNotification[],
        commands?: {
            donate?: {
                disabled: boolean;
                guildId: string;
            }
        },
    },
    steam?: {
        realm: string,
        redirectUrl: string,
        apiKey: string,
    },
    paypal: {
        environment: string,
        clientId: string,
        clientSecret: string,
        manageWebhook: boolean,
    },
    stripe?: {
        secretKey: string,
    },
    battlemetrics: {
        access_token: string,
    },
    cftools: {
        applicationId: string,
        secret: string,
    },
    lb_ag_pg: { [serverId: string]: LbAgPgServer }
    serverNames: ServerNames,

    logoUrl(absolute?: boolean): string;
}
