import { CliError } from './errors.js';

export type Fetch = typeof fetch;

export interface HttpOptions {
    fetch?: Fetch;
    timeoutMs?: number;
    /** Cancels the request early, reported as a network error. */
    signal?: AbortSignal;
    /** Receives one line per request. Never given credentials. */
    log?: (line: string) => void;
}

export interface HttpResponse {
    status: number;
    ok: boolean;
    /** The parsed JSON body, or undefined when the body is empty or not JSON. */
    body: unknown;
    text: string;
}

export const DEFAULT_TIMEOUT_MS = 30_000;

/** Sends a request and reads its body. Throws only for transport failures, never for HTTP statuses. */
export async function send(url: string, init: RequestInit, options: HttpOptions = {}): Promise<HttpResponse> {
    const fetchImpl = options.fetch ?? fetch;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const method = init.method ?? 'GET';
    const started = Date.now();
    let response: Response;
    try {
        const timeout = AbortSignal.timeout(timeoutMs);
        response = await fetchImpl(url, { ...init, signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout });
    } catch (error) {
        if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
            throw new CliError('timeout', `${method} ${url} timed out after ${timeoutMs} ms`, { hint: 'Raise the limit with --timeout <ms>.', cause: error });
        }
        const reason = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
        throw new CliError('network', `Couldn't reach ${new URL(url).origin}: ${reason}`, { hint: 'Check the URL and that the server is running.', cause: error });
    }
    const text = await response.text();
    options.log?.(`${method} ${url} → ${response.status} (${Date.now() - started} ms)`);
    let body: unknown;
    if (text) {
        try {
            body = JSON.parse(text);
        } catch {
            body = undefined;
        }
    }
    return { status: response.status, ok: response.ok, body, text };
}

/** The `error` (and optional description) a Stellarium or OAuth error body carries. */
export function errorMessage(response: HttpResponse): string | undefined {
    const body = response.body as { error?: unknown, error_description?: unknown, message?: unknown } | undefined;
    if (body && typeof body === 'object') {
        if (typeof body.error_description === 'string') return body.error_description;
        if (typeof body.error === 'string') return body.error;
        if (typeof body.message === 'string') return body.message;
    }
    return response.text ? response.text.slice(0, 200) : undefined;
}
