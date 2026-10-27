import { join } from 'node:path';
import { cacheDir, type Env, readJsonFile, type ResolvedConfig, writePrivateJsonFile } from './config.js';
import { CliError } from './errors.js';
import { errorMessage, type HttpOptions, send } from './http.js';

interface CachedToken {
    accessToken: string;
    /** Unix milliseconds. */
    expiresAt: number;
}

type TokenCache = Record<string, CachedToken>;

/** Tokens this close to expiry are replaced before use. */
const EXPIRY_MARGIN_MS = 60_000;

export interface TokenProviderOptions extends HttpOptions {
    env?: Env;
    now?: () => number;
}

/**
 * Exchanges an API client's credentials for run tokens at the operator, and caches them on disk
 * so consecutive commands reuse one token until it nears expiry.
 */
export class TokenProvider {
    private readonly cachePath: string;
    private readonly now: () => number;

    constructor(private readonly config: ResolvedConfig, private readonly options: TokenProviderOptions = {}) {
        this.cachePath = join(cacheDir(options.env), 'tokens.json');
        this.now = options.now ?? Date.now;
    }

    /** Tokens are per client and operator. The node isn't part of the key: a client is issued for one node. */
    private get cacheKey(): string {
        return `${this.config.operatorUrl}|${this.config.clientId}`;
    }

    async token(): Promise<string> {
        const cache = await this.readCache();
        const cached = cache[this.cacheKey];
        if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > this.now()) return cached.accessToken;
        return this.refresh(cache);
    }

    /** Forgets the cached token, for when the node rejected it. */
    async invalidate(): Promise<void> {
        const cache = await this.readCache();
        if (!(this.cacheKey in cache)) return;
        delete cache[this.cacheKey];
        await this.writeCache(cache);
    }

    private async refresh(cache: TokenCache): Promise<string> {
        const { operatorUrl, clientId, clientSecret } = this.config;
        const response = await send(`${operatorUrl}/oauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
            body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString(),
        }, this.options);

        const body = response.body as { access_token?: unknown, expires_in?: unknown, error?: unknown } | undefined;
        if (!response.ok) {
            const message = errorMessage(response) ?? `HTTP ${response.status}`;
            if (body?.error === 'invalid_client') {
                throw new CliError('invalid_client', `The operator rejected the client credentials: ${message}`, {
                    status: response.status,
                    hint: 'Check clientId and clientSecret with "stellarium config list", or create a new API client on platform.stellarium.sh.',
                });
            }
            if (body?.error === 'unauthorized_client') {
                throw new CliError('unauthorized_client', `This client can't get run tokens: ${message}`, {
                    status: response.status,
                    hint: 'The client may be revoked, or its node unlisted. Check it on platform.stellarium.sh.',
                });
            }
            if (response.status === 404) {
                throw new CliError('config_missing', `No token endpoint at ${operatorUrl}/oauth/token`, {
                    status: 404,
                    hint: 'operatorUrl must include /v1, for example https://operator.example.com/v1.',
                });
            }
            throw new CliError(response.status >= 500 ? 'server_error' : 'auth_failed', `Couldn't get a run token: ${message}`, { status: response.status });
        }
        if (typeof body?.access_token !== 'string') {
            throw new CliError('server_error', `The operator answered ${operatorUrl}/oauth/token without an access token`, { status: response.status });
        }
        const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 900;
        cache[this.cacheKey] = { accessToken: body.access_token, expiresAt: this.now() + expiresIn * 1000 };
        this.pruneExpired(cache);
        await this.writeCache(cache);
        return body.access_token;
    }

    private pruneExpired(cache: TokenCache): void {
        for (const [key, token] of Object.entries(cache)) {
            if (token.expiresAt <= this.now()) delete cache[key];
        }
    }

    private async readCache(): Promise<TokenCache> {
        try {
            return (await readJsonFile<TokenCache>(this.cachePath)) ?? {};
        } catch {
            // A corrupt cache only costs a token request.
            return {};
        }
    }

    private async writeCache(cache: TokenCache): Promise<void> {
        try {
            await writePrivateJsonFile(this.cachePath, cache);
        } catch {
            // Caching is an optimization; a read-only home directory shouldn't fail the command.
        }
    }
}
