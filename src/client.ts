import type { TokenProvider } from './auth.js';
import { CliError } from './errors.js';
import { errorMessage, type HttpOptions, type HttpResponse, send } from './http.js';

export interface Parameter {
    name: string;
    type: string;
    description?: string;
}

export interface PaymentManifest {
    costMicroUsd?: number;
    inputCostMicroUsdPerMillionTokens?: number;
    outputCostMicroUsdPerMillionTokens?: number;
    recipientOrganizationId?: string;
}

export interface ResourceFunction {
    name: string;
    returnType: string;
    description?: string;
    parameters: Parameter[];
    paymentManifest?: PaymentManifest;
    restricted?: boolean;
    kind?: 'inference';
}

export interface Resource {
    path: string;
    name: string;
    baseUrl: string;
    website?: string;
    description?: string;
    functions: ResourceFunction[];
}

export interface NodeSelf {
    baseUrl: string;
    publicKey: string;
    name?: string;
}

export interface RunResult {
    returnValue: unknown;
    usage?: { tokens?: number };
}

const PAGE_LIMIT = 500;

export class NodeClient {
    constructor(
        private readonly nodeUrl: string,
        private readonly tokens: TokenProvider | undefined,
        private readonly http: HttpOptions = {},
    ) {}

    async self(): Promise<NodeSelf> {
        const response = await this.get('/v1/self');
        return this.expectOk(response, 'GET /v1/self') as NodeSelf;
    }

    /** Every resource the node knows, following `nextOffset` until the last page or `max` resources. */
    async listResources(max = Number.POSITIVE_INFINITY): Promise<Resource[]> {
        const resources: Resource[] = [];
        let offset: number | null = 0;
        while (offset !== null && resources.length < max) {
            const response = await this.get(`/v1/resources?offset=${offset}&limit=${PAGE_LIMIT}`);
            const page = this.expectOk(response, 'GET /v1/resources') as { resources?: Resource[], nextOffset?: number | null };
            const items = page.resources ?? [];
            resources.push(...items);
            offset = items.length === 0 ? null : (page.nextOffset ?? null);
        }
        return resources.slice(0, max);
    }

    async run(source: string): Promise<RunResult> {
        const response = await this.authorized((token) => send(`${this.nodeUrl}/v1/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ source }),
        }, this.http));

        const body = response.body as { error?: string, details?: unknown, usage?: unknown } | undefined;
        switch (response.status) {
            case 400:
                throw new CliError('invalid_script', 'The node rejected the script: it does not parse, or is not a request', {
                    status: 400,
                    details: body?.details,
                    hint: 'A script must contain exactly one "request Name { ... }" declaration. List callable resources with "stellarium resources list".',
                });
            case 402:
                throw new CliError('payment_required', `The operator refused to pay for this run: ${errorMessage(response) ?? 'payment required'}`, {
                    status: 402,
                    hint: "Top up your organization's balance or raise its monthly cap on platform.stellarium.sh.",
                });
            case 422:
                throw new CliError('script_failed', `The script failed while running${typeof body?.details === 'string' ? `: ${body.details}` : ''}`, {
                    status: 422,
                    details: { details: body?.details, usage: body?.usage },
                });
        }
        return this.expectOk(response, 'POST /v1/run') as RunResult;
    }

    private get(path: string): Promise<HttpResponse> {
        return send(`${this.nodeUrl}${path}`, { headers: { Accept: 'application/json' } }, this.http);
    }

    /** Sends with a run token. A rejected token may be stale or revoked early, so one fresh token is tried. */
    private async authorized(request: (token: string) => Promise<HttpResponse>): Promise<HttpResponse> {
        if (!this.tokens) throw new CliError('config_missing', 'This command needs API client credentials');
        let response = await request(await this.tokens.token());
        if (response.status !== 401) return response;
        await this.tokens.invalidate();
        response = await request(await this.tokens.token());
        if (response.status === 401) {
            throw new CliError('auth_failed', `The node rejected the run token: ${errorMessage(response) ?? 'unauthorized'}`, {
                status: 401,
                hint: 'An API client is issued for one node. Check that nodeUrl is the node the client was created for, and that the node has OPERATOR_URL set.',
            });
        }
        return response;
    }

    private expectOk(response: HttpResponse, what: string): unknown {
        if (response.ok && response.body !== undefined) return response.body;
        const message = errorMessage(response);
        if (response.ok) throw new CliError('server_error', `${what} answered without a JSON body`, { status: response.status });
        if (response.status === 403) throw new CliError('forbidden', `${what} was refused: ${message ?? 'forbidden'}`, { status: 403 });
        if (response.status === 404) {
            throw new CliError('not_found', `${what} was not found on ${this.nodeUrl}`, { status: 404, hint: 'Is nodeUrl a Stellarium node? Leave /v1 off the URL.' });
        }
        if (response.status === 429) throw new CliError('rate_limited', `${what} was rate limited`, { status: 429, hint: 'Wait a minute and try again.' });
        throw new CliError(response.status >= 500 ? 'server_error' : 'unexpected', `${what} failed with HTTP ${response.status}${message ? `: ${message}` : ''}`, { status: response.status });
    }
}
