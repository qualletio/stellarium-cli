import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clock, weather } from './fixtures.js';

// Runs the built CLI, so `pnpm build` must run first (`pnpm test` does).
const cli = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

let server: Server;
let origin: string;
let dir: string;
let tokensIssued = 0;

/** A node and an operator in one server: the operator under /operator/v1, the node under /v1. */
function startServer(): Promise<void> {
    server = createServer((request, response) => {
        let body = '';
        request.on('data', (chunk) => {
            body += chunk;
        });
        request.on('end', () => {
            const url = new URL(request.url ?? '/', 'http://localhost');
            const send = (status: number, value: unknown) => {
                response.writeHead(status, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(value));
            };
            if (url.pathname === '/operator/v1/oauth/token') {
                const form = new URLSearchParams(body);
                if (form.get('client_id') !== 'cli_test' || form.get('client_secret') !== 'secret') {
                    return send(401, { error: 'invalid_client', error_description: 'Unknown client' });
                }
                return send(200, { access_token: `tok_${++tokensIssued}`, token_type: 'Bearer', expires_in: 900 });
            }
            if (url.pathname === '/v1/self') return send(200, { baseUrl: origin, publicKey: 'pk', name: 'test-node' });
            if (url.pathname === '/v1/resources') {
                return url.searchParams.get('offset') === '0'
                    ? send(200, { resources: [weather], nextOffset: 1 })
                    : send(200, { resources: [clock], nextOffset: null });
            }
            if (url.pathname === '/v1/run') {
                if (!request.headers.authorization?.startsWith('Bearer tok_')) return send(401, { error: 'Unauthorized' });
                const { source } = JSON.parse(body) as { source: string };
                if (source.includes('boom')) return send(422, { error: 'Script failed', details: 'Division by zero', usage: { tokens: 4 } });
                if (!source.startsWith('request')) return send(400, { error: 'Invalid script' });
                return send(200, { returnValue: { value: 12, error: null }, usage: { tokens: 17 } });
            }
            send(404, { error: 'Not found' });
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
            resolve();
        });
    });
}

interface Run {
    code: number;
    stdout: string;
    stderr: string;
}

function stellarium(args: string[], env: Record<string, string> = {}, input?: string): Promise<Run> {
    return new Promise((resolve) => {
        const child = execFile(process.execPath, [cli, ...args], {
            env: { PATH: process.env.PATH, STELLARIUM_CONFIG_DIR: join(dir, 'config'), STELLARIUM_CACHE_DIR: join(dir, 'cache'), STELLARIUM_NO_UPDATE_CHECK: '1', ...env },
        }, (error, stdout, stderr) => {
            resolve({ code: error ? (error.code as number) : 0, stdout, stderr });
        });
        if (input !== undefined) child.stdin?.end(input);
        else child.stdin?.end();
    });
}

const json = (run: Run) => JSON.parse(run.stdout);

describe('stellarium', () => {
    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'stellarium-e2e-'));
        await startServer();
    });
    afterAll(async () => {
        server.close();
        await rm(dir, { recursive: true, force: true });
    });

    it('explains missing config with exit code 2', async () => {
        const run = await stellarium(['run', '-e', 'request A { return 1 }']);
        expect(run.code).toBe(2);
        expect(json(run)).toMatchObject({ ok: false, error: { code: 'config_missing' } });
    });

    it('creates a profile without prompting and verifies it', async () => {
        const run = await stellarium(['config', 'init', '--no-input', '--node-url', `${origin}/v1`, '--operator-url', `${origin}/operator/v1`, '--client-id', 'cli_test', '--client-secret', 'secret']);
        expect(run.code).toBe(0);
        const data = json(run).data;
        expect(data.values).toMatchObject({ nodeUrl: origin, clientId: 'cli_test', clientSecret: '********' });
        expect(data.verification).toMatchObject({ ok: true, node: { name: 'test-node' } });
    });

    it('runs a script from stdin, printing the JSON envelope when piped', async () => {
        const run = await stellarium(['run'], {}, 'request A { return 1 }');
        expect(run.code).toBe(0);
        expect(json(run)).toEqual({ ok: true, data: { returnValue: { value: 12, error: null }, usage: { tokens: 17 } } });
    });

    it('reuses the cached run token', async () => {
        const before = tokensIssued;
        await stellarium(['run', '--raw', '-e', 'request A { return 1 }']);
        expect(tokensIssued).toBe(before);
    });

    it('prints only the return value with --raw', async () => {
        const run = await stellarium(['run', '--raw', '-e', 'request A { return 1 }']);
        expect(JSON.parse(run.stdout)).toEqual({ value: 12, error: null });
    });

    it('maps script failures to exit code 4 with details for agents', async () => {
        const run = await stellarium(['-o', 'agent', 'run', '-e', 'request A { return boom }']);
        expect(run.code).toBe(4);
        expect(run.stdout).toBe('');
        expect(run.stderr).toContain('error[script_failed]: The script failed while running: Division by zero');
        expect(run.stderr).toContain('details: Executed 4 tokens before failing.');
    });

    it('maps bad credentials to exit code 3 with a hint', async () => {
        const run = await stellarium(['run', '-e', 'request A { return 1 }'], { STELLARIUM_CLIENT_ID: 'wrong' });
        expect(run.code).toBe(3);
        expect(json(run).error).toMatchObject({ code: 'invalid_client', hint: expect.stringContaining('clientId') });
    });

    it('lists every page of resources', async () => {
        const run = await stellarium(['resources', 'list']);
        expect(json(run).data.map((r: { name: string }) => r.name)).toEqual(['Weather', 'Clock']);
    });

    it('shows a resource for agents with an example script', async () => {
        const run = await stellarium(['--output', 'agent', 'resources', 'show', 'com.example.Weather']);
        expect(run.stdout).toContain('temperature(city: string): int32 [paid $0.01/call]');
        expect(run.stdout).toContain('const weather: com.example.Weather');
    });

    it('suggests close matches for an unknown resource', async () => {
        const run = await stellarium(['resources', 'show', 'com.example.Weathr']);
        expect(run.code).toBe(2);
        expect(json(run).error.code).toBe('not_found');
    });

    it('searches resources', async () => {
        const run = await stellarium(['-o', 'agent', 'resources', 'search', 'zone']);
        expect(run.stdout).toMatch(/^com\.example\.Clock/);
    });

    it('masks the secret in config list', async () => {
        const run = await stellarium(['config', 'list']);
        expect(run.stdout).not.toContain('"secret"');
        expect(json(run).data.profiles[0]).toMatchObject({ name: 'default', active: true });
    });

    it('rejects an unknown command as a usage error', async () => {
        const run = await stellarium(['bogus']);
        expect(run.code).toBe(2);
    });
});
