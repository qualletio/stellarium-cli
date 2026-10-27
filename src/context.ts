import { TokenProvider } from './auth.js';
import { NodeClient } from './client.js';
import { type ConfigFile, type Env, loadConfig, type ResolvedConfig, resolveConfig, resolveNodeUrl } from './config.js';
import { CliError } from './errors.js';
import type { Fetch, HttpOptions } from './http.js';
import type { Output } from './output.js';

export interface GlobalOptions {
    profile?: string;
    node?: string;
    json?: boolean;
    output?: string;
    color?: boolean;
    timeout?: string;
    verbose?: boolean;
    updateCheck?: boolean;
}

/** What every command gets: global flags, output, and lazily built config and clients. */
export class Context {
    readonly http: HttpOptions;
    private configFile?: Promise<ConfigFile>;

    constructor(
        readonly globals: GlobalOptions,
        readonly output: Output,
        readonly env: Env = process.env,
        fetchImpl?: Fetch,
    ) {
        this.http = {
            fetch: fetchImpl,
            timeoutMs: parseTimeout(globals.timeout),
            log: globals.verbose ? (line) => output.note(line) : undefined,
        };
    }

    config(): Promise<ConfigFile> {
        this.configFile ??= loadConfig(this.env);
        return this.configFile;
    }

    async resolved(): Promise<ResolvedConfig> {
        return resolveConfig(await this.config(), this.globals, this.env);
    }

    tokenProvider(config: ResolvedConfig): TokenProvider {
        return new TokenProvider(config, { ...this.http, env: this.env });
    }

    /** A client for reading public node routes. Needs only a node URL. */
    async publicClient(): Promise<NodeClient> {
        return new NodeClient(resolveNodeUrl(await this.config(), this.globals, this.env), undefined, this.http);
    }

    /** A client that runs scripts with run tokens. Needs the full profile. */
    async authorizedClient(): Promise<NodeClient> {
        const config = await this.resolved();
        return new NodeClient(config.nodeUrl, this.tokenProvider(config), this.http);
    }
}

function parseTimeout(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const ms = Number(value);
    if (!Number.isInteger(ms) || ms <= 0) throw new CliError('usage', `--timeout must be a positive number of milliseconds, got "${value}"`);
    return ms;
}
