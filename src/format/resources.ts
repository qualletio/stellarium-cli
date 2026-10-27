import type { PaymentManifest, Resource, ResourceFunction } from '../client.js';
import type { RenderContext, Style } from '../output.js';
import { table } from '../output.js';

export function qualifiedName(resource: Resource): string {
    return resource.path ? `${resource.path}.${resource.name}` : resource.name;
}

export function signature(fn: ResourceFunction): string {
    return `${fn.name}(${fn.parameters.map((parameter) => `${parameter.name}: ${parameter.type}`).join(', ')}): ${fn.returnType}`;
}

export function formatUsd(microUsd: number): string {
    const usd = microUsd / 1_000_000;
    const digits = Math.max(2, Math.min(6, (usd.toString().split('.')[1] ?? '').length));
    return `$${usd.toFixed(digits)}`;
}

export function price(manifest: PaymentManifest | undefined): string | undefined {
    if (!manifest) return undefined;
    if (manifest.costMicroUsd !== undefined) return `${formatUsd(manifest.costMicroUsd)}/call`;
    const input = manifest.inputCostMicroUsdPerMillionTokens;
    const output = manifest.outputCostMicroUsdPerMillionTokens;
    if (input !== undefined || output !== undefined) return `${formatUsd(input ?? 0)}/M in, ${formatUsd(output ?? 0)}/M out`;
    return 'paid';
}

/** Short labels for how a function is called: its price, grant requirement and kind. */
export function badges(fn: ResourceFunction): string[] {
    const labels: string[] = [];
    const cost = price(fn.paymentManifest);
    if (cost) labels.push(`paid ${cost}`);
    if (fn.restricted) labels.push('restricted');
    if (fn.kind === 'inference') labels.push('inference');
    return labels;
}

const isPaid = (resource: Resource) => resource.functions.some((fn) => fn.paymentManifest);

/** A value of `type` to fill in, valid RequestScript so the example parses as is. */
function placeholder(type: string): string {
    const normalized = type.trim();
    if (normalized === 'string') return '"..."';
    if (/^(int32|int64|decimal)\b/.test(normalized)) return '0';
    if (normalized === 'boolean') return 'false';
    if (normalized.startsWith('[]')) return '[]';
    return 'null';
}

function variableName(resource: Resource): string {
    return resource.name.charAt(0).toLowerCase() + resource.name.slice(1);
}

/** A RequestScript request that calls `fn`, ready to fill in and pass to "stellarium run". */
export function exampleScript(resource: Resource, fn: ResourceFunction | undefined = resource.functions[0]): string {
    const variable = variableName(resource);
    const call = fn ? `${variable}.${fn.name}(${fn.parameters.map((parameter) => `${parameter.name}: ${placeholder(parameter.type)}`).join(', ')})` : variable;
    return [
        `request Example {`,
        `    const ${variable}: ${qualifiedName(resource)}`,
        ``,
        `    return ${call}`,
        `}`,
    ].join('\n');
}

/** Resources whose names, descriptions or functions mention every term, best matches first. */
export function searchResources(resources: Resource[], query: string): Resource[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return resources;
    const scored = resources.map((resource) => {
        const fqn = qualifiedName(resource).toLowerCase();
        const fields: [string, number][] = [
            [resource.name.toLowerCase(), 40],
            [fqn, 30],
            [(resource.description ?? '').toLowerCase(), 10],
            ...resource.functions.flatMap((fn): [string, number][] => [
                [fn.name.toLowerCase(), 20],
                [(fn.description ?? '').toLowerCase(), 5],
                ...fn.parameters.map((parameter): [string, number] => [`${parameter.name} ${parameter.description ?? ''}`.toLowerCase(), 2]),
            ]),
        ];
        let score = fqn === query.toLowerCase() ? 100 : 0;
        for (const term of terms) {
            const termScore = fields.reduce((sum, [text, weight]) => sum + (text.includes(term) ? weight : 0), 0);
            if (termScore === 0) return { resource, score: 0 };
            score += termScore;
        }
        return { resource, score };
    });
    return scored
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score || qualifiedName(a.resource).localeCompare(qualifiedName(b.resource)))
        .map(({ resource }) => resource);
}

export function filterResources(resources: Resource[], options: { path?: string, paid?: boolean }): Resource[] {
    return resources.filter((resource) => {
        if (options.path && !qualifiedName(resource).startsWith(options.path)) return false;
        if (options.paid && !isPaid(resource)) return false;
        return true;
    });
}

export function findResource(resources: Resource[], name: string): Resource | undefined {
    return resources.find((resource) => qualifiedName(resource) === name)
        ?? resources.find((resource) => qualifiedName(resource).toLowerCase() === name.toLowerCase());
}

export function renderResourceList(resources: Resource[], style: Style, context: RenderContext, empty: string): string {
    if (resources.length === 0) return context.agent ? empty : style.dim(empty);
    if (context.agent) {
        // Agents get signatures inline, so one listing is enough to write a script.
        return resources.map((resource) => {
            const header = `${qualifiedName(resource)}${resource.description ? ` - ${resource.description}` : ''}`;
            const functions = resource.functions.map((fn) => {
                const labels = badges(fn);
                return `  ${signature(fn)}${labels.length ? ` [${labels.join(', ')}]` : ''}${fn.description ? ` - ${fn.description}` : ''}`;
            });
            return [header, ...functions].join('\n');
        }).join('\n');
    }
    const rows = resources.map((resource) => [
        qualifiedName(resource),
        String(resource.functions.length),
        isPaid(resource) ? 'paid' : 'free',
        hostOf(resource.baseUrl),
        resource.description ?? '',
    ]);
    const body = table(['RESOURCE', 'FUNCS', 'PRICE', 'HOST', 'DESCRIPTION'], rows, {
        width: context.width,
        style,
        color: (column, text) => (column === 0 ? style.cyan(text) : column === 2 && text.startsWith('paid') ? style.yellow(text) : column === 4 ? style.dim(text) : text),
    });
    const count = `${resources.length} resource${resources.length === 1 ? '' : 's'}`;
    return `${body}\n\n${style.dim(`${count}. Details: stellarium resources show <resource>`)}`;
}

export function renderResource(resource: Resource, style: Style, context: RenderContext): string {
    const lines: string[] = [];
    if (context.agent) {
        lines.push(`resource: ${qualifiedName(resource)}`);
        if (resource.description) lines.push(`description: ${resource.description}`);
        lines.push(`host: ${resource.baseUrl}`);
        if (resource.website) lines.push(`website: ${resource.website}`);
        lines.push('functions:');
        for (const fn of resource.functions) {
            const labels = badges(fn);
            lines.push(`  ${signature(fn)}${labels.length ? ` [${labels.join(', ')}]` : ''}`);
            if (fn.description) lines.push(`    ${fn.description}`);
            for (const parameter of fn.parameters) {
                if (parameter.description) lines.push(`    ${parameter.name}: ${parameter.description}`);
            }
        }
        lines.push('example:', exampleScript(resource));
        return lines.join('\n');
    }

    lines.push(style.bold(style.cyan(qualifiedName(resource))));
    if (resource.description) lines.push(resource.description);
    lines.push('');
    lines.push(`${style.dim('Host')}     ${resource.baseUrl}`);
    if (resource.website) lines.push(`${style.dim('Website')}  ${resource.website}`);
    lines.push('', style.bold('Functions'));
    if (resource.functions.length === 0) lines.push(style.dim('  none'));
    for (const fn of resource.functions) {
        const labels = badges(fn).map((label) => (label.startsWith('paid') ? style.yellow(label) : style.magenta(label)));
        lines.push(`  ${style.green(signature(fn))}${labels.length ? `  ${labels.join(style.dim(' · '))}` : ''}`);
        if (fn.description) lines.push(`    ${fn.description}`);
        const width = Math.max(0, ...fn.parameters.map((parameter) => parameter.name.length));
        for (const parameter of fn.parameters) {
            lines.push(`    ${style.dim('•')} ${parameter.name.padEnd(width)}  ${style.dim(parameter.type)}${parameter.description ? `  ${parameter.description}` : ''}`);
        }
    }
    lines.push('', style.bold('Example'));
    lines.push(...exampleScript(resource).split('\n').map((line) => (line ? `  ${style.dim(line)}` : '')));
    return lines.join('\n');
}

function hostOf(baseUrl: string): string {
    try {
        return new URL(baseUrl).host;
    } catch {
        return baseUrl;
    }
}
