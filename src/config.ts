import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError } from './errors.js';

export type Env = Record<string, string | undefined>;

export interface Profile {
    /** Node origin, without `/v1`. */
    nodeUrl?: string;
    /** Operator base URL, including `/v1`. */
    operatorUrl?: string;
    clientId?: string;
    clientSecret?: string;
}

export const profileKeys = ['nodeUrl', 'operatorUrl', 'clientId', 'clientSecret'] as const satisfies readonly (keyof Profile)[];
export type ProfileKey = (typeof profileKeys)[number];

export interface ConfigFile {
    currentProfile?: string;
    profiles: Record<string, Profile>;
}

/** Everything a command needs to reach a node, after flags, env and the profile are merged. */
export interface ResolvedConfig {
    profile: string;
    nodeUrl: string;
    operatorUrl: string;
    clientId: string;
    clientSecret: string;
}

export const DEFAULT_PROFILE = 'default';

export function configDir(env: Env = process.env): string {
    if (env.STELLARIUM_CONFIG_DIR) return env.STELLARIUM_CONFIG_DIR;
    return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'stellarium');
}

export function cacheDir(env: Env = process.env): string {
    if (env.STELLARIUM_CACHE_DIR) return env.STELLARIUM_CACHE_DIR;
    return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'stellarium');
}

export function configPath(env: Env = process.env): string {
    return join(configDir(env), 'config.json');
}

export async function readJsonFile<T>(path: string): Promise<T | undefined> {
    let text: string;
    try {
        text = await readFile(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
    try {
        return JSON.parse(text) as T;
    } catch {
        throw new CliError('usage', `${path} is not valid JSON`, { hint: 'Fix or delete the file.' });
    }
}

/** Writes a file only the current user can read, atomically. */
export async function writePrivateJsonFile(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, path);
}

export async function loadConfig(env: Env = process.env): Promise<ConfigFile> {
    const file = await readJsonFile<ConfigFile>(configPath(env));
    return { currentProfile: file?.currentProfile, profiles: file?.profiles ?? {} };
}

export async function saveConfig(config: ConfigFile, env: Env = process.env): Promise<void> {
    await writePrivateJsonFile(configPath(env), config);
}

/** Strips trailing slashes. Node URLs also lose a trailing `/v1`, which the CLI adds itself. */
export function normalizeUrl(url: string, key: ProfileKey): string {
    let normalized = url.trim().replace(/\/+$/, '');
    if (key === 'nodeUrl') normalized = normalized.replace(/\/v1$/, '');
    try {
        const parsed = new URL(normalized);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
    } catch {
        throw new CliError('usage', `${key} must be an http or https URL, got "${url}"`);
    }
    return normalized;
}

export function normalizeValue(key: ProfileKey, value: string): string {
    if (key === 'nodeUrl' || key === 'operatorUrl') return normalizeUrl(value, key);
    const trimmed = value.trim();
    if (!trimmed) throw new CliError('usage', `${key} can't be empty`);
    return trimmed;
}

export function isProfileKey(key: string): key is ProfileKey {
    return (profileKeys as readonly string[]).includes(key);
}

export function activeProfileName(config: ConfigFile, flag: string | undefined, env: Env): string {
    return flag || env.STELLARIUM_PROFILE || config.currentProfile || DEFAULT_PROFILE;
}

export interface ResolveOptions {
    profile?: string;
    node?: string;
}

const envKeys: Record<ProfileKey, string> = {
    nodeUrl: 'STELLARIUM_NODE_URL',
    operatorUrl: 'STELLARIUM_OPERATOR_URL',
    clientId: 'STELLARIUM_CLIENT_ID',
    clientSecret: 'STELLARIUM_CLIENT_SECRET',
};

/** Merges flags over environment variables over the selected profile. */
export function mergeProfile(config: ConfigFile, options: ResolveOptions, env: Env = process.env): { profile: string, values: Profile } {
    const profile = activeProfileName(config, options.profile, env);
    const stored = config.profiles[profile];
    if (options.profile && !stored) {
        throw new CliError('config_missing', `Profile "${options.profile}" doesn't exist`, { hint: 'List profiles with "stellarium config list".' });
    }
    const values: Profile = { ...stored };
    for (const key of profileKeys) {
        const value = env[envKeys[key]];
        if (value) values[key] = value;
    }
    if (options.node) values.nodeUrl = options.node;
    return { profile, values };
}

function requireKeys(profile: string, values: Profile, keys: readonly ProfileKey[]): void {
    const missing = keys.filter((key) => !values[key]);
    if (missing.length > 0) {
        throw new CliError('config_missing', `Missing ${missing.join(', ')} for profile "${profile}"`, {
            hint: `Run "stellarium config init" or set ${missing.map((key) => envKeys[key]).join(', ')}.`,
        });
    }
}

/** The node to talk to, for commands that don't need credentials. */
export function resolveNodeUrl(config: ConfigFile, options: ResolveOptions, env: Env = process.env): string {
    const { profile, values } = mergeProfile(config, options, env);
    requireKeys(profile, values, ['nodeUrl']);
    return normalizeValue('nodeUrl', values.nodeUrl as string);
}

/** Everything needed to run scripts with a run token. */
export function resolveConfig(config: ConfigFile, options: ResolveOptions, env: Env = process.env): ResolvedConfig {
    const { profile, values } = mergeProfile(config, options, env);
    requireKeys(profile, values, profileKeys);
    return {
        profile,
        nodeUrl: normalizeValue('nodeUrl', values.nodeUrl as string),
        operatorUrl: normalizeValue('operatorUrl', values.operatorUrl as string),
        clientId: (values.clientId as string).trim(),
        clientSecret: (values.clientSecret as string).trim(),
    };
}

export function maskSecret(secret: string | undefined): string | undefined {
    if (!secret) return secret;
    return secret.length <= 8 ? '********' : `${secret.slice(0, 4)}…${secret.slice(-2)}`;
}
