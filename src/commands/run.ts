import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import type { Context } from '../context.js';
import { CliError } from '../errors.js';
import { renderRun } from '../format/run.js';
import type { CommandResult } from '../output.js';
import type { Runner } from './types.js';

interface RunOptions {
    eval?: string;
    raw?: boolean;
}

async function readStdin(): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
}

async function readSource(file: string | undefined, options: RunOptions): Promise<string> {
    if (options.eval !== undefined && file !== undefined) throw new CliError('usage', 'Pass a file or --eval, not both');
    let source: string;
    if (options.eval !== undefined) {
        source = options.eval;
    } else if (file === '-' || (file === undefined && !process.stdin.isTTY)) {
        source = await readStdin();
    } else if (file !== undefined) {
        try {
            source = await readFile(file, 'utf8');
        } catch (error) {
            throw new CliError('usage', `Couldn't read ${file}: ${(error as Error).message}`, { cause: error });
        }
    } else {
        throw new CliError('usage', 'No script given', { hint: 'Pass a file, "-" for stdin, or --eval "request Name { ... }".' });
    }
    if (!source.trim()) throw new CliError('usage', 'The script is empty');
    return source;
}

async function run(context: Context, file: string | undefined, options: RunOptions): Promise<CommandResult> {
    const source = await readSource(file, options);
    const client = await context.authorizedClient();
    const result = await client.run(source);
    if (options.raw) {
        return { data: result.returnValue, raw: true, render: () => JSON.stringify(result.returnValue, null, 2) ?? 'null' };
    }
    return { data: result, render: (style, renderContext) => renderRun(result, style, renderContext) };
}

export function registerRun(program: Command, runner: Runner): void {
    program
        .command('run')
        .description('Run a RequestScript request on the node')
        .argument('[file]', 'script file, or "-" for stdin (default: stdin when piped)')
        .option('-e, --eval <source>', 'script source to run')
        .option('--raw', 'print only the return value as JSON')
        .addHelpText('after', `
Examples:
  $ stellarium run weather.txt
  $ stellarium run -e 'request T { const w: com.example.Weather
      return w.temperature(city: "Oslo") }'
  $ cat script.txt | stellarium run --raw`)
        .action(runner((context, file: string | undefined, options: RunOptions) => run(context, file, options)));
}
