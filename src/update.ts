import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cacheDir, type Env, readJsonFile, writePrivateJsonFile } from './config.js';
import { type Fetch, send } from './http.js';

export const PACKAGE_NAME = 'stellarium-cli';
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 2_000;

export interface UpdateInfo {
    current: string;
    latest: string;
}

interface UpdateCache {
    checkedAt: number;
    latest: string;
}

/** This CLI's version. `package.json` sits one level above both `src/` and `dist/`. */
export async function currentVersion(): Promise<string> {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    return pkg.version;
}

interface SemVer {
    core: [number, number, number];
    prerelease: string[];
}

function parseVersion(version: string): SemVer | undefined {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim());
    if (!match) return undefined;
    return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] ? match[4].split('.') : [] };
}

/** Semver precedence: negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: string, b: string): number {
    const left = parseVersion(a);
    const right = parseVersion(b);
    if (!left || !right) return 0;
    for (let i = 0; i < 3; i++) {
        if (left.core[i] !== right.core[i]) return left.core[i] - right.core[i];
    }
    // A release outranks its prereleases.
    if (left.prerelease.length === 0 || right.prerelease.length === 0) return right.prerelease.length - left.prerelease.length;
    for (let i = 0; i < Math.min(left.prerelease.length, right.prerelease.length); i++) {
        const x = left.prerelease[i];
        const y = right.prerelease[i];
        if (x === y) continue;
        const xNumeric = /^\d+$/.test(x);
        const yNumeric = /^\d+$/.test(y);
        if (xNumeric && yNumeric) return Number(x) - Number(y);
        if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
        return x < y ? -1 : 1;
    }
    return left.prerelease.length - right.prerelease.length;
}

/** Whether `latest` should be offered to someone on `current`. Prereleases are offered only to prerelease users. */
export function isUpdate(current: string, latest: string): boolean {
    const latestVersion = parseVersion(latest);
    const currentVersion = parseVersion(current);
    if (!latestVersion || !currentVersion) return false;
    if (latestVersion.prerelease.length > 0 && currentVersion.prerelease.length === 0) return false;
    return compareVersions(latest, current) > 0;
}

export function updateCheckDisabled(env: Env, flag: boolean | undefined): boolean {
    return flag === false || Boolean(env.STELLARIUM_NO_UPDATE_CHECK) || Boolean(env.CI);
}

export interface UpdateCheckerOptions {
    env?: Env;
    fetch?: Fetch;
    now?: () => number;
}

export class UpdateChecker {
    private readonly cachePath: string;
    private readonly now: () => number;

    constructor(private readonly current: string, private readonly options: UpdateCheckerOptions = {}) {
        this.cachePath = join(cacheDir(options.env), 'update-check.json');
        this.now = options.now ?? Date.now;
    }

    /** Asks the registry for the latest version. Undefined when the registry can't be reached. */
    async fetchLatest(signal?: AbortSignal): Promise<string | undefined> {
        try {
            const response = await send(REGISTRY_URL, { headers: { Accept: 'application/json' } }, { fetch: this.options.fetch, timeoutMs: CHECK_TIMEOUT_MS, signal });
            const version = (response.body as { version?: unknown } | undefined)?.version;
            if (!response.ok || typeof version !== 'string') return undefined;
            await writePrivateJsonFile(this.cachePath, { checkedAt: this.now(), latest: version } satisfies UpdateCache).catch(() => undefined);
            return version;
        } catch {
            return undefined;
        }
    }

    /**
     * Starts a check that never delays a command: a fresh cache answers at once, otherwise the
     * registry is asked in the background. The returned promise never rejects.
     */
    start(signal?: AbortSignal): Promise<UpdateInfo | undefined> {
        return this.check(signal).catch(() => undefined);
    }

    private async check(signal?: AbortSignal): Promise<UpdateInfo | undefined> {
        const cache = await readJsonFile<UpdateCache>(this.cachePath).catch(() => undefined);
        const fresh = cache && typeof cache.latest === 'string' && this.now() - cache.checkedAt < CHECK_INTERVAL_MS;
        const latest = fresh ? cache.latest : ((await this.fetchLatest(signal)) ?? cache?.latest);
        return latest && isUpdate(this.current, latest) ? { current: this.current, latest } : undefined;
    }
}

/** Resolves to the promise's value, or undefined if it isn't settled within `ms`. */
export function settleWithin<T>(promise: Promise<T | undefined>, ms: number): Promise<T | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
        timer.unref();
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
