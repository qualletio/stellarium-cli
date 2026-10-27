import type { RunResult } from '../client.js';
import type { RenderContext, Style } from '../output.js';

export interface FailedCall {
    /** Where the call result sits in the return value, such as `$` or `$.weather[0]`. */
    path: string;
    error: unknown;
}

function isCallResult(value: unknown): value is { value: unknown, error: unknown } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return keys.length === 2 && keys.includes('value') && keys.includes('error');
}

/** Resource call results (`{ value, error }`) in the return value whose `error` is set. */
export function failedCalls(value: unknown, path = '$', found: FailedCall[] = []): FailedCall[] {
    if (isCallResult(value)) {
        if (value.error !== null && value.error !== undefined) found.push({ path, error: value.error });
        failedCalls(value.value, `${path}.value`, found);
    } else if (Array.isArray(value)) {
        for (const [index, item] of value.entries()) failedCalls(item, `${path}[${index}]`, found);
    } else if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) failedCalls(item, `${path}.${key}`, found);
    }
    return found;
}

function describeError(error: unknown): string {
    if (typeof error === 'string') return error;
    if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
    return JSON.stringify(error);
}

/** JSON with keys dimmed and strings colored. Plain JSON when the style is plain. */
export function highlightJson(value: unknown, style: Style): string {
    const json = JSON.stringify(value, null, 2) ?? 'null';
    return json.replace(/("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (match, string, colon, literal, number) => {
        if (string) return colon ? `${style.dim(string)}${colon}` : style.green(string);
        if (literal) return style.magenta(literal);
        if (number) return style.yellow(number);
        return match;
    });
}

export function renderRun(result: RunResult, style: Style, context: RenderContext): string {
    const failures = failedCalls(result.returnValue);
    const tokens = result.usage?.tokens;
    if (context.agent) {
        const lines = [`result: ${JSON.stringify(result.returnValue)}`];
        for (const failure of failures) lines.push(`call_error at ${failure.path}: ${describeError(failure.error)}`);
        if (tokens !== undefined) lines.push(`tokens: ${tokens}`);
        return lines.join('\n');
    }
    const lines = [highlightJson(result.returnValue, style)];
    if (failures.length > 0) {
        lines.push('');
        for (const failure of failures) lines.push(`${style.yellow('⚠ Call failed')} ${style.dim(`at ${failure.path}:`)} ${describeError(failure.error)}`);
    }
    if (tokens !== undefined) lines.push('', style.dim(`${tokens} script tokens`));
    return lines.join('\n');
}
