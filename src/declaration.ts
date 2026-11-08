import { CliError } from './errors.js';

export type DeclarationKind = 'request' | 'contract' | 'event' | 'struct';

export interface DeclaredField {
    name: string;
    /** The type without whitespace, so it compares equal to the node's spelling of it. */
    type: string;
}

export interface Declaration {
    kind: DeclarationKind;
    path: string;
    name: string;
    version: string;
    restricted: boolean;
    fields: DeclaredField[];
}

const HEAD = /^\s*(?:(restricted)\s+(?=event\b))?(request|contract|event|struct)\s+(\w+(?:\s*\.\s*\w+)*)(?:\s*@\s*(\d+(?:\.\d+)*))?/;

/**
 * Reads what a script declares from its first line or so: enough to name it, order it, and compare it with what
 * the node has. Everything after the header is left for the node, whose parser decides whether the script is valid.
 */
export function parseDeclaration(source: string): Declaration {
    const text = source.replace(/\/\/[^\n]*/g, '');
    const head = HEAD.exec(text);
    if (!head) throw new CliError('invalid_script', "It doesn't start with a contract, event, struct or request declaration");
    const kind = head[2] as DeclarationKind;
    const segments = head[3].split('.').map((segment) => segment.trim());
    const name = segments.pop() as string;
    const path = segments.join('.');
    if (kind !== 'request' && !path) {
        throw new CliError('invalid_script', `The ${kind} ${name} has no path`, { hint: `Give it one, such as ${kind} com.example.${name}.` });
    }
    if (kind === 'struct' && head[4] === undefined) {
        throw new CliError('invalid_script', `The struct ${path}.${name} has no version`, { hint: `Declare one, such as struct ${path}.${name}@1(...).` });
    }
    const fields = kind === 'event' || kind === 'struct' ? parseFields(text.slice(head[0].length)) : [];
    return { kind, path, name, version: head[4] ?? '1', restricted: head[1] !== undefined, fields };
}

/** Splits `(a: string, b: decimal(10, 2),)` at its top-level commas. */
function parseFields(rest: string): DeclaredField[] {
    const trimmed = rest.trimStart();
    if (!trimmed.startsWith('(')) return [];
    const parts: string[] = [];
    let depth = 0;
    let current = '';
    for (const char of trimmed) {
        if (char === '(') depth++;
        if (char === ')') depth--;
        if (depth === 0 && char === ')') break;
        if (depth === 1 && char === ',') {
            parts.push(current);
            current = '';
        } else if (depth > 1 || char !== '(') {
            current += char;
        }
    }
    parts.push(current);
    return parts.filter((part) => part.trim()).map((part) => {
        const colon = part.indexOf(':');
        return { name: part.slice(0, colon).trim(), type: part.slice(colon + 1).replace(/\s/g, '') };
    });
}

/** The structs a list of fields names, such as `com.example.Address@1` in `[]com.example.Address@1`. */
export function fieldReferences(fields: DeclaredField[]): string[] {
    return fields.flatMap((field) => field.type.match(/[\w.]+@\d+(?:\.\d+)*/g) ?? []);
}
