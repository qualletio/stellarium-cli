import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareVersions, isUpdate, settleWithin, UpdateChecker, updateCheckDisabled } from '../update.js';
import { jsonResponse } from './fixtures.js';

describe('versions', () => {
    it.each([
        ['1.0.0', '1.0.1', -1],
        ['1.10.0', '1.9.0', 1],
        ['1.0.0', '1.0.0', 0],
        ['1.0.0-beta.1', '1.0.0', -1],
        ['1.0.0-beta.2', '1.0.0-beta.10', -1],
        ['1.0.0-alpha', '1.0.0-beta', -1],
    ])('compares %s with %s', (a, b, sign) => {
        expect(Math.sign(compareVersions(a, b))).toBe(sign);
    });

    it('offers prereleases only to prerelease users', () => {
        expect(isUpdate('0.1.0', '0.2.0')).toBe(true);
        expect(isUpdate('0.1.0', '0.2.0-beta.1')).toBe(false);
        expect(isUpdate('0.2.0-beta.1', '0.2.0-beta.2')).toBe(true);
        expect(isUpdate('0.2.0', '0.1.0')).toBe(false);
        expect(isUpdate('0.1.0', 'garbage')).toBe(false);
    });

    it('is disabled by flag, env or CI', () => {
        expect(updateCheckDisabled({}, undefined)).toBe(false);
        expect(updateCheckDisabled({}, false)).toBe(true);
        expect(updateCheckDisabled({ STELLARIUM_NO_UPDATE_CHECK: '1' }, true)).toBe(true);
        expect(updateCheckDisabled({ CI: 'true' }, true)).toBe(true);
    });
});

describe('UpdateChecker', () => {
    let dir: string;
    const now = 1_700_000_000_000;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'stellarium-update-'));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    const checker = (fetch: typeof globalThis.fetch, at = now) => new UpdateChecker('0.1.0', { fetch, env: { STELLARIUM_CACHE_DIR: dir }, now: () => at });

    it('asks the registry when there is no cache, and caches the answer', async () => {
        const fetch = vi.fn(async () => jsonResponse({ version: '0.2.0' }));
        expect(await checker(fetch).start()).toEqual({ current: '0.1.0', latest: '0.2.0' });
        expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe('https://registry.npmjs.org/stellarium-cli/latest');
        expect(JSON.parse(await readFile(join(dir, 'update-check.json'), 'utf8'))).toEqual({ checkedAt: now, latest: '0.2.0' });
    });

    it('answers from a fresh cache without a request', async () => {
        await writeFile(join(dir, 'update-check.json'), JSON.stringify({ checkedAt: now - 1000, latest: '0.3.0' }));
        const fetch = vi.fn();
        expect(await checker(fetch).start()).toEqual({ current: '0.1.0', latest: '0.3.0' });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('refreshes a stale cache, falling back to it when the registry is down', async () => {
        await writeFile(join(dir, 'update-check.json'), JSON.stringify({ checkedAt: now - 2 * 86_400_000, latest: '0.3.0' }));
        const fetch = vi.fn(async () => {
            throw new TypeError('fetch failed');
        });
        expect(await checker(fetch).start()).toEqual({ current: '0.1.0', latest: '0.3.0' });
        expect(fetch).toHaveBeenCalledOnce();
    });

    it('reports nothing when up to date', async () => {
        expect(await checker(async () => jsonResponse({ version: '0.1.0' })).start()).toBeUndefined();
    });

    it("doesn't wait for a slow check", async () => {
        const slow = new Promise<undefined>(() => {});
        const started = Date.now();
        expect(await settleWithin(slow, 20)).toBeUndefined();
        expect(Date.now() - started).toBeLessThan(500);
    });
});
