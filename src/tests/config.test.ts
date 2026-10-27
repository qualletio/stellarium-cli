import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type ConfigFile, configPath, loadConfig, maskSecret, normalizeUrl, resolveConfig, resolveNodeUrl, saveConfig } from '../config.js';
import { CliError } from '../errors.js';

const full = { nodeUrl: 'http://node:3000', operatorUrl: 'http://operator:3001/v1', clientId: 'cli_1', clientSecret: 'secret-value' };

describe('resolveConfig', () => {
    const config: ConfigFile = { currentProfile: 'work', profiles: { work: full, other: { ...full, nodeUrl: 'http://other:3000' } } };

    it('uses the current profile', () => {
        expect(resolveConfig(config, {}, {})).toMatchObject({ profile: 'work', nodeUrl: 'http://node:3000' });
    });

    it('prefers --profile, then STELLARIUM_PROFILE', () => {
        expect(resolveConfig(config, { profile: 'other' }, { STELLARIUM_PROFILE: 'work' }).nodeUrl).toBe('http://other:3000');
        expect(resolveConfig(config, {}, { STELLARIUM_PROFILE: 'other' }).nodeUrl).toBe('http://other:3000');
    });

    it('lets env override the profile and --node override env', () => {
        const env = { STELLARIUM_NODE_URL: 'http://env:1', STELLARIUM_CLIENT_ID: 'cli_env' };
        expect(resolveConfig(config, {}, env)).toMatchObject({ nodeUrl: 'http://env:1', clientId: 'cli_env' });
        expect(resolveConfig(config, { node: 'http://flag:2/v1/' }, env).nodeUrl).toBe('http://flag:2');
    });

    it('works from env alone', () => {
        const env = { STELLARIUM_NODE_URL: full.nodeUrl, STELLARIUM_OPERATOR_URL: full.operatorUrl, STELLARIUM_CLIENT_ID: 'a', STELLARIUM_CLIENT_SECRET: 'b' };
        expect(resolveConfig({ profiles: {} }, {}, env).profile).toBe('default');
    });

    it('names every missing value and the variables that set them', () => {
        const error = (() => {
            try {
                resolveConfig({ profiles: { default: { nodeUrl: full.nodeUrl } } }, {}, {});
            } catch (e) {
                return e as CliError;
            }
        })();
        expect(error).toBeInstanceOf(CliError);
        expect(error?.code).toBe('config_missing');
        expect(error?.message).toContain('operatorUrl, clientId, clientSecret');
        expect(error?.hint).toContain('STELLARIUM_OPERATOR_URL');
    });

    it('rejects an unknown --profile', () => {
        expect(() => resolveConfig(config, { profile: 'nope' }, {})).toThrow('Profile "nope" doesn\'t exist');
    });

    it('needs only the node URL for public commands', () => {
        expect(resolveNodeUrl({ profiles: { default: { nodeUrl: 'http://n:1/' } } }, {}, {})).toBe('http://n:1');
    });
});

describe('normalizeUrl', () => {
    it('strips trailing slashes, and /v1 from node URLs only', () => {
        expect(normalizeUrl('http://a:1/v1/', 'nodeUrl')).toBe('http://a:1');
        expect(normalizeUrl('http://a:1/v1/', 'operatorUrl')).toBe('http://a:1/v1');
    });

    it('rejects non-http URLs', () => {
        expect(() => normalizeUrl('ftp://a', 'nodeUrl')).toThrow(CliError);
        expect(() => normalizeUrl('node.example.com', 'nodeUrl')).toThrow(CliError);
    });
});

describe('maskSecret', () => {
    it('hides all but the ends of long secrets', () => {
        expect(maskSecret('abcdefghijkl')).toBe('abcd…kl');
        expect(maskSecret('short')).toBe('********');
    });
});

describe('config file', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'stellarium-config-'));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('round-trips and is readable only by the owner', async () => {
        const env = { STELLARIUM_CONFIG_DIR: dir };
        expect(await loadConfig(env)).toEqual({ currentProfile: undefined, profiles: {} });
        await saveConfig({ currentProfile: 'default', profiles: { default: full } }, env);
        expect((await loadConfig(env)).profiles.default).toEqual(full);
        expect((await stat(configPath(env))).mode & 0o777).toBe(0o600);
    });
});
