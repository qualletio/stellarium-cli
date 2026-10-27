import { describe, expect, it, vi } from 'vitest';
import type { TokenProvider } from '../auth.js';
import { NodeClient } from '../client.js';
import type { CliError } from '../errors.js';
import { clock, jsonResponse, llm, weather } from './fixtures.js';

function tokens(...values: string[]) {
    let index = 0;
    return {
        token: vi.fn(async () => values[Math.min(index, values.length - 1)]),
        invalidate: vi.fn(async () => {
            index++;
        }),
    } as unknown as TokenProvider & { token: ReturnType<typeof vi.fn>, invalidate: ReturnType<typeof vi.fn> };
}

describe('NodeClient', () => {
    it('follows nextOffset through every page', async () => {
        const fetch = vi.fn(async (url: string | URL | Request) => {
            const offset = new URL(String(url)).searchParams.get('offset');
            return offset === '0' ? jsonResponse({ resources: [weather, clock], nextOffset: 2 }) : jsonResponse({ resources: [llm], nextOffset: null });
        });
        const resources = await new NodeClient('http://node', undefined, { fetch }).listResources();
        expect(resources.map((resource) => resource.name)).toEqual(['Weather', 'Clock', 'Chat']);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('runs a script with a bearer run token', async () => {
        const fetch = vi.fn(async () => jsonResponse({ returnValue: { value: 12, error: null }, usage: { tokens: 17 } }));
        const result = await new NodeClient('http://node', tokens('tok'), { fetch }).run('request A { return 1 }');
        expect(result).toEqual({ returnValue: { value: 12, error: null }, usage: { tokens: 17 } });
        const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('http://node/v1/run');
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
        expect(JSON.parse(init.body as string)).toEqual({ source: 'request A { return 1 }' });
    });

    it('retries once with a fresh token after a 401', async () => {
        const provider = tokens('stale', 'fresh');
        const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
            const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
            return auth === 'Bearer fresh' ? jsonResponse({ returnValue: 1 }) : jsonResponse({ error: 'Unauthorized' }, 401);
        });
        expect((await new NodeClient('http://node', provider, { fetch }).run('x')).returnValue).toBe(1);
        expect(provider.invalidate).toHaveBeenCalledOnce();
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('gives up after the fresh token is also rejected', async () => {
        const fetch = vi.fn(async () => jsonResponse({ error: 'Unauthorized' }, 401));
        const error = await new NodeClient('http://node', tokens('a', 'b'), { fetch }).run('x').catch((e: CliError) => e);
        expect((error as CliError).code).toBe('auth_failed');
        expect((error as CliError).exitCode).toBe(3);
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it.each([
        [400, { error: 'Invalid script' }, 'invalid_script', 4],
        [402, { error: 'Insufficient balance' }, 'payment_required', 6],
        [422, { error: 'Script failed', details: 'Division by zero', usage: { tokens: 3 } }, 'script_failed', 4],
        [500, { error: 'Internal server error' }, 'server_error', 5],
        [429, { error: 'Too many requests' }, 'rate_limited', 5],
    ])('maps HTTP %i to %s', async (status, body, code, exitCode) => {
        const fetch = vi.fn(async () => jsonResponse(body, status));
        const error = await new NodeClient('http://node', tokens('tok'), { fetch }).run('x').catch((e: CliError) => e);
        expect((error as CliError).code).toBe(code);
        expect((error as CliError).exitCode).toBe(exitCode);
    });

    it('includes the failure details of a 422', async () => {
        const fetch = vi.fn(async () => jsonResponse({ error: 'Script failed', details: 'Division by zero', usage: { tokens: 3 } }, 422));
        const error = (await new NodeClient('http://node', tokens('tok'), { fetch }).run('x').catch((e) => e)) as CliError;
        expect(error.message).toContain('Division by zero');
        expect(error.details).toEqual({ details: 'Division by zero', usage: { tokens: 3 } });
    });

    it('reports an unreachable node as a network error', async () => {
        const fetch = vi.fn(async () => {
            throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
        });
        const error = (await new NodeClient('http://node:1', undefined, { fetch }).self().catch((e) => e)) as CliError;
        expect(error.code).toBe('network');
        expect(error.message).toContain('ECONNREFUSED');
    });
});
