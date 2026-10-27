import pc from 'picocolors';
import { CliError, type ErrorCode } from './errors.js';
import type { UpdateInfo } from './update.js';

export type OutputMode = 'pretty' | 'json' | 'agent';
export const outputModes: readonly OutputMode[] = ['pretty', 'json', 'agent'];

export interface Style {
    bold(text: string): string;
    dim(text: string): string;
    red(text: string): string;
    green(text: string): string;
    yellow(text: string): string;
    cyan(text: string): string;
    magenta(text: string): string;
}

const identity = (text: string) => text;
export const plainStyle: Style = { bold: identity, dim: identity, red: identity, green: identity, yellow: identity, cyan: identity, magenta: identity };
const colorStyle: Style = { bold: pc.bold, dim: pc.dim, red: pc.red, green: pc.green, yellow: pc.yellow, cyan: pc.cyan, magenta: pc.magenta };

/** What a command produces. The runner picks a rendering once the command and update check are done. */
export interface CommandResult<T = unknown> {
    data: T;
    /** Print `render`'s output in every mode, JSON included, without the envelope. */
    raw?: boolean;
    /** Human text. Also used for agent mode, with `agent` set and a plain style. */
    render(style: Style, context: RenderContext): string;
}

export interface RenderContext {
    agent: boolean;
    width: number;
}

export interface OutputOptions {
    output?: string;
    json?: boolean;
    color?: boolean;
}

export function resolveMode(options: OutputOptions, stdoutIsTTY: boolean): OutputMode {
    if (options.json) return 'json';
    if (options.output) {
        if (!(outputModes as readonly string[]).includes(options.output)) {
            throw new CliError('usage', `--output must be one of ${outputModes.join(', ')}, got "${options.output}"`);
        }
        return options.output as OutputMode;
    }
    return stdoutIsTTY ? 'pretty' : 'json';
}

export function colorsEnabled(mode: OutputMode, options: OutputOptions, env: Record<string, string | undefined>, isTTY: boolean): boolean {
    if (mode !== 'pretty' || options.color === false) return false;
    if (env.NO_COLOR) return false;
    if (env.FORCE_COLOR) return true;
    return isTTY;
}

export class Output {
    readonly style: Style;

    constructor(
        readonly mode: OutputMode,
        color: boolean,
        private readonly stdout: NodeJS.WritableStream = process.stdout,
        private readonly stderr: NodeJS.WritableStream = process.stderr,
        readonly width: number = process.stdout.columns || 100,
    ) {
        this.style = color ? colorStyle : plainStyle;
    }

    result(result: CommandResult, update?: UpdateInfo): void {
        if (this.mode === 'json' && !result.raw) {
            this.writeJson({ ok: true, data: result.data, ...(update && { update }) });
            return;
        }
        const text = result.render(this.mode === 'agent' ? plainStyle : this.style, { agent: this.mode === 'agent', width: this.width });
        if (text) this.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
        if (update && this.mode !== 'json') this.updateNotice(update);
    }

    error(error: CliError, update?: UpdateInfo): void {
        if (this.mode === 'json') {
            this.writeJson({ ok: false, error: error.toJSON(), ...(update && { update }) });
            return;
        }
        const s = this.style;
        const lines = this.mode === 'agent'
            ? [`error[${error.code}]: ${error.message}`]
            : [`${s.red(s.bold('Error:'))} ${error.message}`];
        const details = describeDetails(error.code, error.details);
        if (details) lines.push(...details.split('\n').map((line) => (this.mode === 'agent' ? `details: ${line}` : `  ${s.dim(line)}`)));
        if (error.hint) lines.push(this.mode === 'agent' ? `hint: ${error.hint}` : `${s.cyan('Hint:')} ${error.hint}`);
        this.stderr.write(`${lines.join('\n')}\n`);
        if (update) this.updateNotice(update);
    }

    /** A diagnostic line that is never part of the data, such as --verbose request logs. */
    note(line: string): void {
        this.stderr.write(`${this.mode === 'pretty' ? this.style.dim(line) : line}\n`);
    }

    private updateNotice(update: UpdateInfo): void {
        const s = this.style;
        const command = 'npm i -g stellarium-cli';
        this.stderr.write(this.mode === 'agent'
            ? `notice: update available ${update.current} -> ${update.latest}. Run: ${command}\n`
            : `\n${s.yellow('Update available')} ${s.dim(update.current)} → ${s.green(update.latest)}. Run: ${s.cyan(command)}\n`);
    }

    private writeJson(value: unknown): void {
        this.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    }
}

/** Extra lines for an error, such as the node's message for a failed script. */
function describeDetails(code: ErrorCode, details: unknown): string | undefined {
    if (details === undefined || details === null) return undefined;
    if (code === 'script_failed') {
        const { usage } = details as { usage?: { tokens?: number } };
        return usage?.tokens !== undefined ? `Executed ${usage.tokens} tokens before failing.` : undefined;
    }
    return typeof details === 'string' ? details : JSON.stringify(details);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matches ANSI escape sequences
const ansiPattern = /\x1b\[[0-9;]*m/g;

export function visibleLength(text: string): number {
    return text.replace(ansiPattern, '').length;
}

export function truncate(text: string, max: number): string {
    if (max <= 1) return text.length > max ? '…' : text;
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Aligns rows into columns. The last column is truncated so lines fit `width`.
 * Cells are plain text; `color` styles a cell after padding so escapes don't skew widths.
 */
export function table(headers: string[], rows: string[][], options: { width: number, style: Style, color?: (column: number, text: string) => string }): string {
    const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)));
    const last = headers.length - 1;
    const fixed = widths.slice(0, last).reduce((sum, width) => sum + width + 2, 0);
    widths[last] = Math.max(10, Math.min(widths[last], options.width - fixed));
    const color = options.color ?? ((_column: number, text: string) => text);

    const line = (cells: string[], header: boolean) => cells
        .map((cell, column) => {
            const text = column === last ? truncate(cell, widths[column]) : cell.padEnd(widths[column]);
            return header ? options.style.bold(text) : color(column, text);
        })
        .join('  ')
        .trimEnd();
    return [line(headers, true), ...rows.map((row) => line(row, false))].join('\n');
}
