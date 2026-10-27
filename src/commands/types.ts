import type { Context } from '../context.js';
import type { CommandResult } from '../output.js';

/** Wraps a command's action with context creation, output and exit codes. */
export type Runner = <A extends unknown[]>(action: (context: Context, ...args: A) => Promise<CommandResult>) => (...args: A) => Promise<void>;
