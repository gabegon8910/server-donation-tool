import {
    CapturePaymentRequest,
    CreatePaymentOrderRequest,
    Payment,
    PaymentCapture,
    PaymentOrder,
    PendingSubscription,
    Reference,
    SaleCompleted,
    Subscription,
    SubscriptionCancelled,
    SubscriptionPlan
} from '../domain/payment';
import {AppConfig} from '../domain/app-config';
import {inject, singleton} from 'tsyringe';
import {Package} from '../domain/package';
import {translate} from '../translations';
import querystring from 'querystring';
import {User} from '../domain/user';
import {v4} from 'uuid';

const paypal = require('@paypal/checkout-server-sdk');

export enum Environment {
    PRODUCTION = 'production', SANDBOX = 'sandbox'
}

@singleton()
export class PaypalPayment implements Payment {
    private readonly client: any;

    constructor(@inject('AppConfig') private readonly config: AppConfig, @inject('packages') private readonly packages: Package[]) {
        this.client = paypalClient(config);
    }

    async capturePayment(request: CapturePaymentRequest): Promise<PaymentCapture> {
        const r = new paypal.orders.OrdersCaptureRequest(request.orderId);
        r.requestBody({});

        const capture = await this.client.execute(r);
        return {
            orderId: capture.result.id,
            transactionId: capture.result.purchase_units[0]?.payments?.captures[0]?.id,
        };
    }

    async createPaymentOrder(request: CreatePaymentOrderRequest): Promise<PaymentOrder> {
        const communityTitle = this.config.app.community?.title || translate('PAYPAL_DEFAULT_COMMUNITY_NAME');
        const r = new paypal.orders.OrdersCreateRequest();
        r.prefer('return=representation');
        r.requestBody({
            intent: 'CAPTURE',
            application_context: {
                brand_name: communityTitle,
                shipping_preference: 'NO_SHIPPING',
                user_action: 'PAY_NOW',
            },
            purchase_units: [{
                custom_id: new Reference(request.steamId, request.discordId, request.forPackage).asString(),
                description: translate('PAYPAL_ORDER_DESCRIPTION', {
                    params: {
                        communityName: communityTitle,
                    }
                }),
                amount: {
                    currency_code: request.forPackage.price.currency,
                    value: request.forPackage.price.amount,
                    breakdown: {
                        item_total: {
                            currency_code: request.forPackage.price.currency,
                            value: request.forPackage.price.amount
                        },
                    },
                },
                items: [{
                    name: request.forPackage.name,
                    category: 'DONATION',
                    unit_amount: {
                        currency_code: request.forPackage.price.currency,
                        value: request.forPackage.price.amount
                    },
                    quantity: 1,
                }],
            }],
        });

        const order: OrderResult = await this.client.execute(r);
        return {
            created: new Date(order.result.create_time),
            id: order.result.id,
            transactionId: order.result.purchase_units[0]?.payments?.captures[0]?.id,
        };
    }

    async webhookEvent<T extends SaleCompleted | SubscriptionCancelled>(id: string): Promise<T | null> {
        const r = new GetWebhookEvent(id);
        const event: WebhookEventResult = await this.client.execute(r);

        if (event.statusCode !== 200) {
            return null;
        }
        return event.result.resource as T;
    }

    async persistSubscription(p: Package, sp?: SubscriptionPlan): Promise<SubscriptionPlan> {
        let product: ProductResult;
        product = await this.product(p);
        if (product.statusCode === 200) {
            product = await this.updateProduct(product, p);
        } else {
            product = await this.createProduct(p);
        }

        let plan: PlanResult;
        if (sp?.payment.planId) {
            plan = await this.updatePlan(await this.plan(sp.payment.planId), p);
            return new SubscriptionPlan(sp.id, p, {
                productId: product.result.id,
                planId: plan.result.id,
            });
        } else {
            plan = await this.createPlan(p);
            return SubscriptionPlan.create(p, product.result.id, plan.result.id);
        }
    }

    async subscribe(sub: Subscription, plan: SubscriptionPlan, user: User): Promise<PendingSubscription> {
        const communityTitle = this.config.app.community?.title || translate('PAYPAL_DEFAULT_COMMUNITY_NAME');
        const r = new CreateSubscriptionRequest();
        r.requestBody({
            plan_id: plan.payment.planId,
            custom_id: new Reference(user.steam.id, user.discord.id, plan.basePackage).asString(),
            application_context: {
                brand_name: communityTitle,
                shipping_preference: 'NO_SHIPPING',
                user_action: 'SUBSCRIBE_NOW',
                return_url: sub.asLink(this.config).toString(),
                cancel_url: sub.abortLink(this.config).toString(),
            },
        });
        const result: SubscriptionResult = await this.client.execute(r);

        return {
            id: result.result.id,
            approvalLink: result.result.links.find((l) => l.rel === 'approve').href,
        };
    }

    async cancelSubscription(subscription: Subscription): Promise<void> {
        const r = new CancelSubscriptionRequest(subscription.payment.id);
        r.reason('Requested by user');

        await this.client.execute(r);
    }

    private homeUrl(): string | undefined {
        let homeUrl = this.config.app.publicUrl.toString();
        if (homeUrl.includes('localhost')) {
            return undefined;
        }
        return homeUrl;
    }

    private async createPlan(p: Package): Promise<PlanResult> {
        const planRequest = new CreatePlanRequest();
        planRequest.requestBody({
            product_id: this.asProductId(p),
            payment_preferences: {
                auto_bill_outstanding: true,
                payment_failure_threshold: 1,
            },
            status: PlanState.ACTIVE,
            description: translate('PAYPAL_SUBSCRIPTION_MONTHLY_DESCRIPTION'),
            name: translate('PAYPAL_SUBSCRIPTION_MONTHLY_NAME'),
            quantity_supported: false,
            billing_cycles: [{
                frequency: {
                    interval_unit: 'MONTH',
                    interval_count: 1,
                },
                pricing_scheme: {
                    fixed_price: {
                        currency_code: p.price.currency,
                        value: p.price.amount,
                    }
                },
                sequence: 1,
                tenure_type: 'REGULAR',
                total_cycles: 0,
            }]
        } as CreatePlanRequest);
        return await this.client.execute(planRequest);
    }

    private asProductId(p: Package): string {
        return `DONATE-${p.id}`;
    }

    private async product(p: Package): Promise<ProductResult> {
        const r = new GetProductRequest(this.asProductId(p));

        return await this.client.execute(r);
    }

    private async plan(id: string): Promise<PlanResult> {
        const r = new GetPlanRequest(id);

        return await this.client.execute(r);
    }

    private async createProduct(p: Package): Promise<ProductResult> {
        const productRequest = new CreateProductRequest();
        productRequest.requestBody({
            id: this.asProductId(p),
            category: 'ONLINE_GAMING',
            description: p.description,
            name: p.name,
            type: 'DIGITAL',
            home_url: this.homeUrl(),
        });

        return await this.client.execute(productRequest);
    }

    private async updateProduct(product: ProductResult, p: Package): Promise<ProductResult> {
        const productRequest = new UpdateProductRequest(this.asProductId(p));
        productRequest.requestBody(product.result, {
            category: 'ONLINE_GAMING',
            description: p.description,
            name: p.name,
            home_url: this.homeUrl(),
        });

        await this.client.execute(productRequest);
        return await this.product(p);
    }

    private async updatePlan(plan: PlanResult, p: Package): Promise<PlanResult> {
        const request = new UpdatePlanRequest(plan.result.id);
        request.requestBody(plan.result, {
            description: translate('PAYPAL_SUBSCRIPTION_MONTHLY_DESCRIPTION'),
            name: translate('PAYPAL_SUBSCRIPTION_MONTHLY_NAME', {params: {package: p.name}}),
        });
        await this.client.execute(request);

        const pricing = new UpdatePricingPlanRequest(plan.result.id);
        pricing.requestBody({
            pricing_schemes: [{
                billing_cycle_sequence: 1,
                pricing_scheme: {
                    fixed_price: {
                        currency_code: p.price.currency,
                        value: p.price.amount,
                    },
                },
            }],
        });
        await this.client.execute(pricing);
        return await this.plan(plan.result.id);
    }
}

interface OrderResult {
    result: {
        id: string,
        status: string,
        create_time?: string,
        update_time: string,
        purchase_units: {
            custom_id: string,
            payments?: {
                captures: {
                    id: string
                }[]
            }
        }[]
    }
}

interface ProductResult {
    statusCode: number;
    result: {
        id: string;
        name: string;
        description: string;
        type: ProductType;
        category: ProductCategory;
        image_url?: string;
        home_url: string;
        create_time: string;
        update_time: string;
    }
}

interface Plan {
    id: string;
    product_id: string;
    name: string;
    description: string;
    status: PlanState;
    billing_cycles: BillingCycle[];
    payment_preferences: PaymentPreferences;
    create_time: string;
    update_time: string;
}

interface PlanResult {
    result: Plan;
}

interface SubscriptionResult {
    result: {
        status: 'APPROVAL_PENDING' | 'APPROVED' | 'ACTIVE' | 'SUSPENDED' | 'CANCELLED' | 'EXPIRED';
        id: string;
        plan_id: string;
        subscriber: {
            name: {
                given_name: string;
                surname: string;
                email_address: string;
                payer_id: string;
            };
        };
        links: HATEOASLink[]
    }
}

interface HATEOASLink {
    href: string;
    rel: string;
    method: string;
}

type ProductType = 'DIGITAL' | 'SERVICE' | 'PHYSICAL';
type ProductCategory = 'ONLINE_GAMING';

interface Product {
    id: string;
    name: string;
    description: string;
    type: ProductType;
    category: 'ONLINE_GAMING';
    image_url?: string;
    home_url: string;
}

interface UpdateProduct {
    name: string;
    description: string;
    category: ProductCategory;
    image_url?: string;
    home_url?: string;
}

interface UpdatePlan {
    name: string;
    description: string;
}

enum PlanState {
    CREATED = 'CREATED', ACTIVE = 'ACTIVE', INACTIVE = 'INACTIVE'
}

interface BillingCycle {
    pricing_scheme: {
        fixed_price: {
            currency_code: string;
            value: string;
        }
    };
    frequency: {
        interval_unit: 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';
        interval_count: number;
    };
    tenure_type: 'TRIAL' | 'REGULAR';
    sequence: number;
    total_cycles: number;
}

interface PaymentPreferences {
    auto_bill_outstanding: boolean;
    payment_failure_threshold: number;
}

interface CreatePlanRequest {
    product_id: string;
    name: string;
    status: Exclude<PlanState, 'INACTIVE'>;
    description: string;
    billing_cycles: BillingCycle[];
    payment_preferences: PaymentPreferences;
    quantity_supported: boolean;
}

class CreateProductRequest {
    path: string;
    verb: string;
    body: null | object;
    headers: { [key: string]: string };

    constructor() {
        this.path = '/v1/catalogs/products?';
        this.verb = 'POST';
        this.body = null;
        this.headers = {
            'Content-Type': 'application/json'
        };
    }

    requestBody(product: Product) {
        this.body = product;
        return this;
    }
}

class UpdateProductRequest {
    path: string;
    verb: string;
    body: null | object | object[];
    headers: { [key: string]: string };

    constructor(productId: string) {
        this.path = '/v1/catalogs/products/{product_id}?'.replace('{product_id}', querystring.escape(productId));
        this.verb = 'PATCH';
        this.body = null;
        this.headers = {
            'Content-Type': 'application/json'
        };
    }

    requestBody(original: Product, product: UpdateProduct) {
        const ops = [];
        for (let entry of Object.entries(product) as [string, string][]) {
            const oldValue = this.getProperty(original, entry[0] as keyof Product);
            if (entry[1] !== undefined) {
                if (oldValue === undefined) {
                    ops.push({op: 'add', path: `/${entry[0]}`, value: entry[1]});
                } else {
                    ops.push({op: 'replace', path: `/${entry[0]}`, value: entry[1]});
                }
            } else if (oldValue !== undefined) {
                ops.push({op: 'remove', path: `/${entry[0]}`});
            }
        }
        this.body = ops;
        return this;
    }

    private getProperty<T, K extends keyof T>(o: T, propertyName: K): T[K] {
        return o[propertyName];
    }
}

class UpdatePlanRequest {
    path: string;
    verb: string;
    body: null | object | object[];
    headers: { [key: string]: string };

    constructor(id: string) {
        this.path = '/v1/billing/plans/{id}?'.replace('{id}', querystring.escape(id));
        this.verb = 'PATCH';
        this.body = null;
        this.headers = {
            'Content-Type': 'application/json'
        };
    }

    requestBody(original: Plan, product: UpdatePlan) {
        const ops = [];
        for (let entry of Object.entries(product) as [string, string][]) {
            const oldValue = this.getProperty(original, entry[0] as keyof Plan);
            if (entry[1] !== undefined) {
                if (oldValue === undefined) {
                    ops.push({op: 'add', path: `/${entry[0]}`, value: entry[1]});
                } else {
                    ops.push({op: 'replace', path: `/${entry[0]}`, value: entry[1]});
                }
            } else if (oldValue !== undefined) {
                ops.push({op: 'remove', path: `/${entry[0]}`});
            }
        }
        this.body = ops;
        return this;
    }

    private getProperty<T, K extends keyof T>(o: T, propertyName: K): T[K] {
        return o[propertyName];
    }
}

interface UpdatePricingPlan {
    pricing_schemes: {
        billing_cycle_sequence: number,
        pricing_scheme: {
            fixed_price: {
                value: string,
                currency_code: string,
            },
        },
    }[],
}

class UpdatePricingPlanRequest {
    path: string;
    verb: string;
    body: null | object | object[];
    headers: { [key: string]: string };

    constructor(id: string) {
        this.path = '/v1/billing/plans/{id}/update-pricing-schemes?'.replace('{id}', querystring.escape(id));
        this.verb = 'POST';
        this.body = null;
        this.headers = {
            'Content-Type': 'application/json'
        };
    }

    requestBody(r: UpdatePricingPlan) {
        this.body = r;
        return this;
    }
}

class GetProductRequest {
    path: string;
    verb: string;
    body: null | object;
    headers: { [key: string]: string };

    constructor(productId: string) {
        this.path = '/v1/catalogs/products/{product_id}?'.replace('{product_id}', querystring.escape(productId));
        this.verb = 'GET';
        this.body = null;
        this.headers = {
            'Content-Type': 'application/json'
        };
    }
}

class GetPlanRequest {
    path: string;
    verb: string;
    body: null | object;
    headers: { [key: string]: string };

    constructor(planId: string) {
        this.path = '/v1/billing/plans/{plan_id}?'.replace('{plan_id}', querystring.escape(planId));
        this.verb = 'GET';
        this.body = null;
        this.headers = {
            'Content-Type': 'application/json'
        };
    }
}

class CreatePlanRequest {
    path: string;
    verb: string;
    body: null | object;
    headers: { [key: string]: string };

    constructor() {
        this.path = '/v1/billing/plans?';
        this.verb = 'POST';
        this.body = null;
        this.headers = {
            'Content-Type': 'application/json'
        };
    }

    requestBody(plan: CreatePlanRequest) {
        this.body = plan;
        return this;
    }
}

class CancelSubscriptionRequest {
    path: string;
    verb: string;
    body: null | object;
    headers: { [key: string]: string };

    constructor(subscriptionId: string) {
        this.path = '/v1/billing/subscriptions/{subscription_id}/cancel?'.replace('{subscription_id}', querystring.escape(subscriptionId));
        this.verb = 'POST';
        this.body = null;
        this.headers = {
            'Content-Type': 'application/json'
        };
    }

    reason(reason: string) {
        this.body = {
            reason: reason,
        };
        return this;
    }
}

class GetWebhookEvent {
    path: string;
    verb: string;
    body: null | object;
    headers: { [key: string]: string };

    constructor(eventId: string) {
        this.path = '/v1/notifications/webhooks-events/{event_id}?'.replace('{event_id}', querystring.escape(eventId));
        this.verb = 'GET';
        this.body = null;
        this.headers = {
            'Content-Type': 'application/json'
        };
    }
}

interface WebhookEventResult {
    statusCode: number;
    result: {
        resource: SaleCompleted | SubscriptionCancelled;
    };
}

interface PayPalSubscription {
    plan_id: string;
    application_context: {
        brand_name: string;
        shipping_preference: 'NO_SHIPPING';
        user_action: 'SUBSCRIBE_NOW';
        return_url: string;
        cancel_url: string;
    };
    custom_id: string;
}

class CreateSubscriptionRequest {
    path: string;
    verb: string;
    body: null | object;
    headers: { [key: string]: string };

    constructor() {
        this.path = '/v1/billing/subscriptions?';
        this.verb = 'POST';
        this.body = null;
        this.headers = {
            'Content-Type': 'application/json'
        };
    }

    requestBody(s: PayPalSubscription) {
        this.body = s;
        return this;
    }
}

/**
 *
 * Returns PayPal HTTP client instance with environment that has access
 * credentials context. Use this instance to invoke PayPal APIs, provided the
 * credentials have access.
 */
function paypalClient(config: AppConfig) {
    return new paypal.core.PayPalHttpClient(environment(config));
}

/**
 *
 * Set up and return PayPal JavaScript SDK environment with PayPal access credentials.
 * This sample uses SandboxEnvironment. In production, use LiveEnvironment.
 */
function environment(config: AppConfig) {
    if (config.paypal.environment === Environment.PRODUCTION) {
        return new paypal.core.LiveEnvironment(config.paypal.clientId, config.paypal.clientSecret);
    } else {
        return new paypal.core.SandboxEnvironment(config.paypal.clientId, config.paypal.clientSecret);
    }
}

export class FakePayment implements Payment {
    webhookEvent<T extends SaleCompleted | SubscriptionCancelled>(id: string): Promise<T | null> {
        return null;
    }

    capturePayment(request: CapturePaymentRequest): Promise<PaymentCapture> {
        return Promise.resolve({
            orderId: v4(),
            transactionId: v4(),
        });
    }

    createPaymentOrder(request: CreatePaymentOrderRequest): Promise<PaymentOrder> {
        return Promise.resolve({
            id: v4(),
            created: new Date(),
            transactionId: v4(),
        });
    }

    persistSubscription(p: Package, plan?: SubscriptionPlan): Promise<SubscriptionPlan> {
        return Promise.resolve(SubscriptionPlan.create(p, v4(), v4()));
    }

    subscribe(sub: Subscription, plan: SubscriptionPlan, user: User): Promise<PendingSubscription> {
        return Promise.resolve({
            id: v4(),
            approvalLink: 'https://example.com/approveSubscription',
        });
    }

    cancelSubscription(subscription: Subscription): Promise<void> {
        return Promise.resolve(undefined);
    }
}
