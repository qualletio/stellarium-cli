/** Process exit codes. Stable: scripts and agents branch on them. */
export const ExitCode = {
    ok: 0,
    unexpected: 1,
    usage: 2,
    auth: 3,
    script: 4,
    network: 5,
    payment: 6,
} as const;

export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

export type ErrorCode =
    | 'unexpected'
    | 'usage'
    | 'config_missing'
    | 'not_found'
    | 'auth_failed'
    | 'invalid_client'
    | 'unauthorized_client'
    | 'invalid_script'
    | 'script_failed'
    | 'payment_required'
    | 'forbidden'
    | 'rate_limited'
    | 'network'
    | 'timeout'
    | 'server_error';

const exitCodes: Record<ErrorCode, ExitCode> = {
    unexpected: ExitCode.unexpected,
    usage: ExitCode.usage,
    config_missing: ExitCode.usage,
    not_found: ExitCode.usage,
    auth_failed: ExitCode.auth,
    invalid_client: ExitCode.auth,
    unauthorized_client: ExitCode.auth,
    forbidden: ExitCode.auth,
    invalid_script: ExitCode.script,
    script_failed: ExitCode.script,
    payment_required: ExitCode.payment,
    rate_limited: ExitCode.network,
    network: ExitCode.network,
    timeout: ExitCode.network,
    server_error: ExitCode.network,
};

export interface CliErrorOptions {
    hint?: string;
    status?: number;
    details?: unknown;
    cause?: unknown;
}

/** An error the CLI knows how to explain. Anything else is reported as `unexpected`. */
export class CliError extends Error {
    readonly code: ErrorCode;
    readonly hint?: string;
    readonly status?: number;
    readonly details?: unknown;

    constructor(code: ErrorCode, message: string, options: CliErrorOptions = {}) {
        super(message, { cause: options.cause });
        this.name = 'CliError';
        this.code = code;
        this.hint = options.hint;
        this.status = options.status;
        this.details = options.details;
    }

    get exitCode(): ExitCode {
        return exitCodes[this.code];
    }

    toJSON() {
        return {
            code: this.code,
            message: this.message,
            ...(this.hint !== undefined && { hint: this.hint }),
            ...(this.status !== undefined && { status: this.status }),
            ...(this.details !== undefined && { details: this.details }),
        };
    }
}

export function toCliError(error: unknown): CliError {
    if (error instanceof CliError) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new CliError('unexpected', message, { cause: error });
}
