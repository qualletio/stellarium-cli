import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import {
    activeProfileName,
    type ConfigFile,
    configPath,
    isProfileKey,
    maskSecret,
    normalizeValue,
    type Profile,
    type ProfileKey,
    profileKeys,
    resolveConfig,
    saveConfig,
} from '../config.js';
import { NodeClient } from '../client.js';
import type { Context } from '../context.js';
import { CliError, toCliError } from '../errors.js';
import type { CommandResult, Style } from '../output.js';
import type { Runner } from './types.js';

const labels: Record<ProfileKey, string> = {
    nodeUrl: 'Node URL (without /v1)',
    operatorUrl: 'Operator URL (with /v1)',
    clientId: 'API client id',
    clientSecret: 'API client secret',
};

function maskProfile(profile: Profile): Profile {
    return { ...profile, clientSecret: maskSecret(profile.clientSecret) };
}

/** Prompts on stderr, so stdout stays clean. A secret prompt doesn't echo what's typed. */
async function prompt(question: string, options: { secret?: boolean, current?: string } = {}): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    const suffix = options.current ? ` [${options.secret ? maskSecret(options.current) : options.current}]` : '';
    const query = `${question}${suffix}: `;
    if (options.secret) {
        // readline echoes typed characters through _writeToOutput; drop them after the question.
        const internal = rl as unknown as { _writeToOutput(text: string): void };
        const write = internal._writeToOutput.bind(rl);
        internal._writeToOutput = (text: string) => write(text.startsWith(query) ? query : text.includes('\n') ? '\n' : '');
    }
    try {
        const answer = (await rl.question(query)).trim();
        return answer || options.current || '';
    } finally {
        rl.close();
    }
}

function profileName(context: Context, config: ConfigFile): string {
    return activeProfileName(config, context.globals.profile, context.env);
}

interface InitOptions {
    nodeUrl?: string;
    operatorUrl?: string;
    clientId?: string;
    clientSecret?: string;
    input?: boolean;
    verify?: boolean;
}

async function init(context: Context, options: InitOptions): Promise<CommandResult> {
    const config = await context.config();
    const name = profileName(context, config);
    const profile: Profile = { ...config.profiles[name] };
    const interactive = options.input !== false && process.stdin.isTTY;

    for (const key of profileKeys) {
        let value = options[key];
        if (value === undefined && interactive) value = await prompt(labels[key], { secret: key === 'clientSecret', current: profile[key] });
        if (value) profile[key] = normalizeValue(key, value);
    }
    const missing = profileKeys.filter((key) => !profile[key]);
    if (missing.length > 0) {
        throw new CliError('usage', `Missing ${missing.join(', ')}`, {
            hint: `Pass ${missing.map((key) => `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`).join(', ')}, or run in a terminal to be prompted.`,
        });
    }

    config.profiles[name] = profile;
    config.currentProfile ??= name;
    await saveConfig(config, context.env);

    const verification = options.verify === false ? undefined : await verify(context);
    const data = { profile: name, path: configPath(context.env), values: maskProfile(profile), ...(verification && { verification }) };
    return {
        data,
        render: (style) => [
            `${style.green('✓')} Saved profile ${style.bold(name)} to ${style.dim(data.path)}`,
            ...(verification ? [renderVerification(verification, style)] : []),
        ].join('\n'),
    };
}

interface Verification {
    ok: boolean;
    node?: { baseUrl: string, publicKey: string, name?: string };
    error?: ReturnType<ReturnType<typeof toCliError>['toJSON']>;
}

/** Checks the node answers and the client credentials get a run token. */
async function verify(context: Context): Promise<Verification> {
    try {
        const resolved = resolveConfig(await context.config(), context.globals, context.env);
        const node = await new NodeClient(resolved.nodeUrl, undefined, context.http).self();
        await context.tokenProvider(resolved).token();
        return { ok: true, node };
    } catch (error) {
        return { ok: false, error: toCliError(error).toJSON() };
    }
}

function renderVerification(verification: Verification, style: Style): string {
    if (verification.ok) {
        const node = verification.node;
        return `${style.green('✓')} Reached node ${style.bold(node?.name ?? node?.baseUrl ?? '')} and got a run token`;
    }
    const error = verification.error;
    return [
        `${style.red('✗')} ${error?.message}`,
        ...(error?.hint ? [`  ${style.cyan('Hint:')} ${error.hint}`] : []),
    ].join('\n');
}

async function test(context: Context): Promise<CommandResult> {
    const verification = await verify(context);
    if (!verification.ok && verification.error) {
        const { code, message, hint, status } = verification.error;
        throw new CliError(code, message, { hint, status });
    }
    return { data: verification, render: (style) => renderVerification(verification, style) };
}

function requireKey(key: string): ProfileKey {
    if (!isProfileKey(key)) throw new CliError('usage', `Unknown key "${key}"`, { hint: `Keys: ${profileKeys.join(', ')}.` });
    return key;
}

async function set(context: Context, key: string, value: string): Promise<CommandResult> {
    const profileKey = requireKey(key);
    const config = await context.config();
    const name = profileName(context, config);
    const normalized = normalizeValue(profileKey, value);
    config.profiles[name] = { ...config.profiles[name], [profileKey]: normalized };
    config.currentProfile ??= name;
    await saveConfig(config, context.env);
    const shown = profileKey === 'clientSecret' ? maskSecret(normalized) : normalized;
    return { data: { profile: name, key: profileKey, value: shown }, render: (style) => `${style.green('✓')} ${name}.${profileKey} = ${shown}` };
}

async function get(context: Context, key: string, options: { reveal?: boolean }): Promise<CommandResult> {
    const profileKey = requireKey(key);
    const config = await context.config();
    const name = profileName(context, config);
    const stored = config.profiles[name]?.[profileKey];
    if (stored === undefined) throw new CliError('config_missing', `${profileKey} isn't set for profile "${name}"`);
    const value = profileKey === 'clientSecret' && !options.reveal ? maskSecret(stored) : stored;
    return { data: { profile: name, key: profileKey, value }, render: () => value ?? '' };
}

async function list(context: Context): Promise<CommandResult> {
    const config = await context.config();
    const active = profileName(context, config);
    const profiles = Object.entries(config.profiles).map(([name, profile]) => ({ name, active: name === active, ...maskProfile(profile) }));
    return {
        data: { path: configPath(context.env), activeProfile: active, profiles },
        render: (style, { agent }) => {
            if (profiles.length === 0) return 'No profiles. Create one with "stellarium config init".';
            return profiles.map((profile) => {
                const header = agent ? `profile: ${profile.name}${profile.active ? ' (active)' : ''}` : `${profile.active ? style.green('●') : ' '} ${style.bold(profile.name)}`;
                const values = profileKeys.map((key) => `    ${agent ? `${key}:` : style.dim(key.padEnd(12))} ${profile[key] ?? (agent ? 'unset' : style.dim('unset'))}`);
                return [header, ...values].join('\n');
            }).join('\n\n');
        },
    };
}

async function use(context: Context, name: string): Promise<CommandResult> {
    const config = await context.config();
    if (!config.profiles[name]) throw new CliError('config_missing', `Profile "${name}" doesn't exist`, { hint: `Create it with "stellarium --profile ${name} config init".` });
    config.currentProfile = name;
    await saveConfig(config, context.env);
    return { data: { activeProfile: name }, render: (style) => `${style.green('✓')} Using profile ${style.bold(name)}` };
}

async function remove(context: Context, name: string): Promise<CommandResult> {
    const config = await context.config();
    if (!config.profiles[name]) throw new CliError('config_missing', `Profile "${name}" doesn't exist`);
    delete config.profiles[name];
    if (config.currentProfile === name) config.currentProfile = Object.keys(config.profiles)[0];
    await saveConfig(config, context.env);
    return { data: { removed: name, activeProfile: config.currentProfile ?? null }, render: (style) => `${style.green('✓')} Removed profile ${style.bold(name)}` };
}

export function registerConfig(program: Command, runner: Runner): void {
    const config = program
        .command('config')
        .description('Manage profiles: which node to query and the API client to authenticate with')
        .addHelpText('after', `
Profiles live in ${configPath()} (mode 0600).
Select one with --profile or STELLARIUM_PROFILE. These variables override its values:
  STELLARIUM_NODE_URL, STELLARIUM_OPERATOR_URL, STELLARIUM_CLIENT_ID, STELLARIUM_CLIENT_SECRET`);

    config
        .command('init')
        .description('Create or update a profile, prompting for missing values, then verify it')
        .option('--node-url <url>', 'node origin, such as https://node.example.com')
        .option('--operator-url <url>', 'operator base URL including /v1')
        .option('--client-id <id>', 'API client id from platform.stellarium.sh')
        .option('--client-secret <secret>', 'API client secret')
        .option('--no-input', 'never prompt; fail if a value is missing')
        .option('--no-verify', 'skip checking the node and credentials')
        .action(runner((context, options: InitOptions) => init(context, options)));

    config
        .command('test')
        .description('Check the node answers and the API client gets a run token')
        .action(runner((context) => test(context)));

    config
        .command('set')
        .description(`Set a profile value (${profileKeys.join(', ')})`)
        .argument('<key>')
        .argument('<value>')
        .action(runner((context, key: string, value: string) => set(context, key, value)));

    config
        .command('get')
        .description('Print a profile value')
        .argument('<key>')
        .option('--reveal', 'print clientSecret unmasked')
        .action(runner((context, key: string, options: { reveal?: boolean }) => get(context, key, options)));

    config
        .command('list')
        .alias('ls')
        .description('List profiles, secrets masked')
        .action(runner((context) => list(context)));

    config
        .command('use')
        .description('Make a profile the default')
        .argument('<profile>')
        .action(runner((context, name: string) => use(context, name)));

    config
        .command('remove')
        .alias('rm')
        .description('Delete a profile')
        .argument('<profile>')
        .action(runner((context, name: string) => remove(context, name)));

    config
        .command('path')
        .description('Print the config file path')
        .action(runner(async (context) => {
            const path = configPath(context.env);
            return { data: { path }, render: () => path };
        }));
}
