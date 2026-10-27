import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenProvider } from '../auth.js';
import type { ResolvedConfig } from '../config.js';
import type { CliError } from '../errors.js';
import { jsonResponse } from './fixtures.js';

const config: ResolvedConfig = { profile: 'default', nodeUrl: 'http://node', operatorUrl: 'http://operator/v1', clientId: 'cli_1', clientSecret: 's3cret' };

describe('TokenProvider', () => {
    let dir: string;
    let now: number;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'stellarium-auth-'));
        now = 1_000_000;
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    const provider = (fetch: typeof globalThis.fetch) => new TokenProvider(config, { fetch, env: { STELLARIUM_CACHE_DIR: dir }, now: () => now });

    it('exchanges client credentials with the client_credentials grant', async () => {
        const fetch = vi.fn(async () => jsonResponse({ access_token: 'tok_1', token_type: 'Bearer', expires_in: 900 }));
        expect(await provider(fetch).token()).toBe('tok_1');
        const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('http://operator/v1/oauth/token');
        expect(Object.fromEntries(new URLSearchParams(init.body as string))).toEqual({ grant_type: 'client_credentials', client_id: 'cli_1', client_secret: 's3cret' });
    });

    it('reuses a cached token across instances until it nears expiry', async () => {
        let issued = 0;
        const fetch = vi.fn(async () => jsonResponse({ access_token: `tok_${++issued}`, expires_in: 900 }));
        expect(await provider(fetch).token()).toBe('tok_1');
        now += 800_000;
        expect(await provider(fetch).token()).toBe('tok_1');
        now += 50_000; // within a minute of expiry
        expect(await provider(fetch).token()).toBe('tok_2');
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('fetches a new token after invalidate', async () => {
        let issued = 0;
        const fetch = vi.fn(async () => jsonResponse({ access_token: `tok_${++issued}`, expires_in: 900 }));
        const tokens = provider(fetch);
        await tokens.token();
        await tokens.invalidate();
        expect(await tokens.token()).toBe('tok_2');
    });

    it.each([
        [{ error: 'invalid_client', error_description: 'Unknown client' }, 401, 'invalid_client'],
        [{ error: 'unauthorized_client', error_description: 'Client is revoked' }, 400, 'unauthorized_client'],
        [{ error: 'temporarily_unavailable' }, 503, 'server_error'],
        [{}, 404, 'config_missing'],
    ])('maps %j (%i) to %s', async (body, status, code) => {
        const error = await provider(async () => jsonResponse(body, status)).token().catch((e: CliError) => e);
        expect((error as CliError).code).toBe(code);
        expect((error as CliError).message).not.toContain('s3cret');
    });
});
