import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { DeployedField, DeployKind, NodeClient } from '../client.js';
import type { Context } from '../context.js';
import { type Declaration, fieldReferences, parseDeclaration } from '../declaration.js';
import { CliError } from '../errors.js';
import { renderDeploy } from '../format/deploy.js';
import type { CommandResult } from '../output.js';
import type { Runner } from './types.js';

interface DeployOptions {
    dryRun?: boolean;
}

export type DeployStatus = 'deployed' | 'would_deploy' | 'unchanged' | 'skipped';

export interface DeployItem {
    file: string;
    kind: Declaration['kind'];
    ref: string;
    status: DeployStatus;
    feeMicroUsd?: number;
}

export interface DeploySummary {
    dryRun: boolean;
    items: DeployItem[];
    feeMicroUsd: number;
}

interface Script {
    file: string;
    source: string;
    declaration: Declaration;
    ref: string;
}

/** What a declaration is compared with: a contract's source, or an event type's or struct's fields. */
type Known = { source: string } | { fields: DeployedField[], restricted: boolean };

const IGNORED_DIRECTORIES = new Set(['node_modules']);

async function walk(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return entry.name.startsWith('.') || IGNORED_DIRECTORIES.has(entry.name) ? [] : walk(path);
        return entry.isFile() && entry.name.endsWith('.req') ? [path] : [];
    }));
    return nested.flat();
}

/** Scripts named on the command line, and `.req` files found under directories. Requests are only allowed in the latter. */
async function collect(paths: string[]): Promise<{ scripts: Script[], skipped: DeployItem[] }> {
    const files = new Map<string, { file: string, explicit: boolean }>();
    for (const path of paths) {
        let isDirectory: boolean;
        try {
            isDirectory = (await stat(path)).isDirectory();
        } catch (error) {
            throw new CliError('usage', `Couldn't read ${path}: ${(error as Error).message}`, { cause: error });
        }
        for (const file of isDirectory ? await walk(path) : [path]) {
            const explicit = !isDirectory;
            const entry = files.get(resolve(file));
            files.set(resolve(file), { file: entry?.file ?? file, explicit: explicit || Boolean(entry?.explicit) });
        }
    }
    if (files.size === 0) throw new CliError('usage', `No .req files found in ${paths.join(', ')}`);

    const scripts: Script[] = [];
    const skipped: DeployItem[] = [];
    for (const { file, explicit } of [...files.values()].sort((a, b) => a.file.localeCompare(b.file))) {
        const source = await readFile(file, 'utf8').catch((error: Error) => {
            throw new CliError('usage', `Couldn't read ${file}: ${error.message}`, { cause: error });
        });
        const declaration = declarationOf(file, source);
        const ref = declaration.kind === 'request' ? declaration.name : `${declaration.path}.${declaration.name}@${declaration.version}`;
        if (declaration.kind === 'request') {
            if (explicit) throw new CliError('usage', `${file} is a request, which can't be deployed`, { hint: `Run it with "stellarium run ${file}".` });
            skipped.push({ file, kind: 'request', ref, status: 'skipped' });
        } else {
            scripts.push({ file, source, declaration, ref });
        }
    }
    const seen = new Map<string, string>();
    for (const { file, ref } of scripts) {
        const other = seen.get(ref);
        if (other) throw new CliError('usage', `${ref} is declared by both ${other} and ${file}`);
        seen.set(ref, file);
    }
    return { scripts, skipped };
}

function declarationOf(file: string, source: string): Declaration {
    try {
        return parseDeclaration(source);
    } catch (error) {
        if (error instanceof CliError) throw new CliError(error.code, `${file}: ${error.message}`, { hint: error.hint, cause: error });
        throw error;
    }
}

/** Structs before what names them, including other structs, then event types, then the contracts that use both. */
export function deployOrder<T extends { declaration: Declaration, ref: string }>(scripts: T[]): T[] {
    const structs = new Map(scripts.filter((script) => script.declaration.kind === 'struct').map((script) => [script.ref, script]));
    const ordered: T[] = [];
    const visited = new Set<string>();
    const visit = (script: T) => {
        if (visited.has(script.ref)) return;
        visited.add(script.ref);
        for (const reference of fieldReferences(script.declaration.fields)) {
            const dependency = structs.get(reference);
            if (dependency) visit(dependency);
        }
        ordered.push(script);
    };
    for (const script of structs.values()) visit(script);
    return [
        ...ordered,
        ...scripts.filter((script) => script.declaration.kind === 'event'),
        ...scripts.filter((script) => script.declaration.kind === 'contract'),
    ];
}

function key(item: { path: string, name: string, version: string }): string {
    return `${item.path}.${item.name}@${item.version}`;
}

const fieldsKey = (fields: { name: string, type: string }[]) => JSON.stringify(fields.map(({ name, type }) => [name, type.replace(/\s/g, '')]));

/** What the node already has at the versions being deployed, read from its public routes. */
async function loadKnown(client: NodeClient, scripts: Script[]): Promise<Map<string, Known>> {
    const has = (kind: DeployKind) => scripts.some((script) => script.declaration.kind === kind);
    const [contracts, eventTypes, structs] = await Promise.all([
        has('contract') ? client.listContracts() : [],
        has('event') ? client.listEventTypes() : [],
        has('struct') ? client.listStructs() : [],
    ]);
    const known = new Map<string, Known>();
    for (const contract of contracts) known.set(`contract ${key(contract)}`, { source: contract.source });
    for (const eventType of eventTypes) known.set(`event ${key(eventType)}`, { fields: eventType.fields, restricted: eventType.restricted });
    for (const struct of structs) known.set(`struct ${key(struct)}`, { fields: struct.fields, restricted: false });
    return known;
}

function isUnchanged(script: Script, known: Known): boolean {
    if ('source' in known) return known.source === script.source;
    return known.restricted === script.declaration.restricted && fieldsKey(known.fields) === fieldsKey(script.declaration.fields);
}

async function deploy(context: Context, paths: string[], options: DeployOptions): Promise<CommandResult<DeploySummary>> {
    const { scripts, skipped } = await collect(paths);
    const ordered = deployOrder(scripts);

    const known = await loadKnown(await context.publicClient(), ordered);
    const unchanged = new Set<Script>();
    const changed: Script[] = [];
    for (const script of ordered) {
        const existing = known.get(`${script.declaration.kind} ${script.ref}`);
        if (!existing) continue;
        (isUnchanged(script, existing) ? unchanged.add(script) : changed.push(script));
    }
    // Checked before anything is sent, so a forgotten version bump can't leave a half-finished deploy.
    if (changed.length > 0) {
        throw new CliError('conflict', `Changed without a new version: ${changed.map((script) => `${script.ref} (${script.file})`).join(', ')}`, {
            status: 409,
            hint: 'Deployed versions are immutable. Give each changed declaration a new version, such as @2.',
        });
    }

    const items: DeployItem[] = [];
    let feeMicroUsd = 0;
    const pending = ordered.filter((script) => !unchanged.has(script));
    const client = options.dryRun || pending.length === 0 ? undefined : await context.authorizedClient();
    for (const script of ordered) {
        const { file, ref, declaration } = script;
        const kind = declaration.kind as DeployKind;
        if (unchanged.has(script)) {
            items.push({ file, kind, ref, status: 'unchanged' });
        } else if (!client) {
            items.push({ file, kind, ref, status: 'would_deploy' });
        } else {
            const result = await deployOne(client, kind, script, items);
            feeMicroUsd += result.feeMicroUsd ?? 0;
            items.push({ file, kind, ref, status: result.created ? 'deployed' : 'unchanged', ...(result.feeMicroUsd !== undefined && { feeMicroUsd: result.feeMicroUsd }) });
        }
    }
    items.push(...skipped);

    const summary: DeploySummary = { dryRun: Boolean(options.dryRun), items, feeMicroUsd };
    return { data: summary, render: (style, renderContext) => renderDeploy(summary, style, renderContext) };
}

async function deployOne(client: NodeClient, kind: DeployKind, script: Script, done: DeployItem[]) {
    try {
        return await client.deploy(kind, script.source);
    } catch (error) {
        if (!(error instanceof CliError)) throw error;
        const deployed = done.filter((item) => item.status === 'deployed').map((item) => item.ref);
        throw new CliError(error.code, `${script.file}: ${error.message}`, {
            status: error.status,
            hint: error.hint ?? (deployed.length > 0 ? 'What deployed before this stays deployed. Fix this file and deploy again: those versions will be left unchanged.' : undefined),
            details: { failed: script.ref, deployed, ...(error.details !== undefined && { details: error.details }) },
            cause: error,
        });
    }
}

export function registerDeploy(program: Command, runner: Runner): void {
    program
        .command('deploy')
        .description('Deploy contracts, event types and structs from .req files')
        .argument('<paths...>', '.req files, or directories to search for them')
        .option('--dry-run', "compare with the node and report what would deploy, without deploying (needs only a node URL)")
        .addHelpText('after', `
Structs deploy first, then event types, then contracts. Versions the node already
has with the same content are left alone, so deploying again is safe and free.
Requests found in a directory are skipped.

Examples:
  $ stellarium deploy contracts/
  $ stellarium deploy structs/Address.req contracts/Outlook.req
  $ stellarium deploy --dry-run contracts/`)
        .action(runner((context, paths: string[], options: DeployOptions) => deploy(context, paths, options)));
}
