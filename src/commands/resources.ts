import type { Command } from 'commander';
import type { Resource } from '../client.js';
import type { Context } from '../context.js';
import { CliError } from '../errors.js';
import { filterResources, findResource, qualifiedName, renderResource, renderResourceList, searchResources } from '../format/resources.js';
import type { CommandResult } from '../output.js';
import type { Runner } from './types.js';

interface ListOptions {
    path?: string;
    paid?: boolean;
    limit?: string;
}

function parseLimit(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const limit = Number(value);
    if (!Number.isInteger(limit) || limit <= 0) throw new CliError('usage', `--limit must be a positive integer, got "${value}"`);
    return limit;
}

async function allResources(context: Context): Promise<Resource[]> {
    return (await context.publicClient()).listResources();
}

function listResult(resources: Resource[], empty: string): CommandResult<Resource[]> {
    return { data: resources, render: (style, renderContext) => renderResourceList(resources, style, renderContext, empty) };
}

async function list(context: Context, options: ListOptions): Promise<CommandResult> {
    const limit = parseLimit(options.limit);
    const resources = filterResources(await allResources(context), options).slice(0, limit);
    return listResult(resources, 'No resources found.');
}

async function search(context: Context, query: string, options: ListOptions): Promise<CommandResult> {
    const limit = parseLimit(options.limit);
    const resources = searchResources(filterResources(await allResources(context), options), query).slice(0, limit);
    return listResult(resources, `No resources match "${query}".`);
}

async function show(context: Context, name: string): Promise<CommandResult> {
    const resources = await allResources(context);
    const resource = findResource(resources, name);
    if (!resource) {
        const suggestions = searchResources(resources, name.split('.').pop() ?? name).slice(0, 3).map(qualifiedName);
        throw new CliError('not_found', `No resource named ${name} on this node`, {
            hint: suggestions.length > 0 ? `Did you mean ${suggestions.join(', ')}?` : 'List resources with "stellarium resources list".',
        });
    }
    return { data: resource, render: (style, renderContext) => renderResource(resource, style, renderContext) };
}

export function registerResources(program: Command, runner: Runner): void {
    const resources = program.command('resources').description('Discover the resources a node can call');

    resources
        .command('list')
        .alias('ls')
        .description('List resources hosted on or learned by the node')
        .option('--path <prefix>', 'only resources whose qualified name starts with this prefix')
        .option('--paid', 'only resources with paid functions')
        .option('--limit <n>', 'show at most n resources')
        .action(runner((context, options: ListOptions) => list(context, options)));

    resources
        .command('search')
        .description('Search resource names, descriptions and functions')
        .argument('<query>', 'words to match; every word must match')
        .option('--path <prefix>', 'only resources whose qualified name starts with this prefix')
        .option('--paid', 'only resources with paid functions')
        .option('--limit <n>', 'show at most n resources')
        .action(runner((context, query: string, options: ListOptions) => search(context, query, options)));

    resources
        .command('show')
        .description('Show a resource\'s functions and an example script')
        .argument('<resource>', 'qualified name, such as com.example.Weather')
        .action(runner((context, name: string) => show(context, name)));
}
