#!/usr/bin/env node
import { Command, CommanderError, Option } from 'commander';
import { registerConfig } from './commands/config.js';
import { registerResources } from './commands/resources.js';
import { registerRun } from './commands/run.js';
import type { Runner } from './commands/types.js';
import { Context, type GlobalOptions } from './context.js';
import { ExitCode, toCliError } from './errors.js';
import { colorsEnabled, Output, outputModes, resolveMode } from './output.js';
import { currentVersion, isUpdate, PACKAGE_NAME, settleWithin, UpdateChecker, type UpdateInfo, updateCheckDisabled } from './update.js';

/** How long a finished command waits for a background update check before giving up on it. */
const UPDATE_GRACE_MS = 300;

const version = await currentVersion();
const env = process.env;
const program = new Command();

function createOutput(globals: GlobalOptions): Output {
    try {
        const mode = resolveMode(globals, Boolean(process.stdout.isTTY));
        return new Output(mode, colorsEnabled(mode, globals, env, Boolean(process.stderr.isTTY && process.stdout.isTTY)));
    } catch (error) {
        // An invalid --output still needs a way to report itself.
        new Output('pretty', false).error(toCliError(error));
        process.exit(ExitCode.usage);
    }
}

const runner: Runner = (action) => async (...args) => {
    const globals = program.opts<GlobalOptions>();
    const output = createOutput(globals);
    const abort = new AbortController();
    const update = updateCheckDisabled(env, globals.updateCheck) ? undefined : new UpdateChecker(version, { env }).start(abort.signal);
    const pendingUpdate = async (): Promise<UpdateInfo | undefined> => {
        if (!update) return undefined;
        const info = await settleWithin(update, UPDATE_GRACE_MS);
        abort.abort();
        return info;
    };

    try {
        const context = new Context(globals, output, env);
        const result = await action(context, ...args);
        output.result(result, await pendingUpdate());
    } catch (error) {
        const cliError = toCliError(error);
        output.error(cliError, await pendingUpdate());
        if (globals.verbose && cliError.code === 'unexpected' && error instanceof Error) output.note(error.stack ?? '');
        process.exitCode = cliError.exitCode;
    }
};

program
    .name('stellarium')
    .description('Run RequestScript queries on a Stellarium node and discover its resources.')
    .version(version, '-v, --version')
    .option('-p, --profile <name>', 'config profile to use (default: the active profile)')
    .option('-n, --node <url>', 'node URL, overriding the profile')
    .option('--json', 'print JSON (same as --output json)')
    .addOption(new Option('-o, --output <mode>', 'output format; default pretty on a terminal, json otherwise').choices(outputModes))
    .option('--no-color', 'disable colors (also NO_COLOR)')
    .option('--timeout <ms>', 'HTTP timeout in milliseconds', '30000')
    .option('--verbose', 'log HTTP requests to stderr')
    .option('--no-update-check', 'skip checking npm for a newer version (also STELLARIUM_NO_UPDATE_CHECK=1)')
    .showSuggestionAfterError()
    .exitOverride()
    .addHelpText('after', `
Output modes:
  pretty  tables and colors for people (default on a terminal)
  json    {"ok": true, "data": ...} or {"ok": false, "error": {...}} (default when piped)
  agent   compact plain text for LLM agents, with resource signatures and hints

Exit codes:
  0 ok, 1 unexpected, 2 usage or config, 3 auth, 4 script invalid or failed,
  5 network or server, 6 payment required`);

registerRun(program, runner);
registerResources(program, runner);
registerConfig(program, runner);

program
    .command('version')
    .description('Print the version and check npm for a newer one')
    .action(runner(async () => {
        const latest = await new UpdateChecker(version, { env }).fetchLatest();
        const updateAvailable = latest !== undefined && isUpdate(version, latest);
        return {
            data: { version, latest: latest ?? null, updateAvailable },
            render: (style) => {
                if (latest === undefined) return `${PACKAGE_NAME} ${version} ${style.dim('(could not reach npm)')}`;
                if (!updateAvailable) return `${PACKAGE_NAME} ${version} ${style.dim('(latest)')}`;
                return `${PACKAGE_NAME} ${version}\n${style.yellow('Update available')} → ${style.green(latest)}. Run: ${style.cyan(`npm i -g ${PACKAGE_NAME}`)}`;
            },
        };
    }));

try {
    await program.parseAsync();
} catch (error) {
    if (!(error instanceof CommanderError)) throw error;
    // Commander has already printed help, the version, or the usage error.
    const success = error.code === 'commander.helpDisplayed' || error.code === 'commander.version' || error.code === 'commander.help';
    process.exitCode = success ? ExitCode.ok : ExitCode.usage;
}
