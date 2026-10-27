import { describe, expect, it } from 'vitest';
import { badges, exampleScript, formatUsd, renderResource, renderResourceList, searchResources, signature } from '../format/resources.js';
import { failedCalls, renderRun } from '../format/run.js';
import { plainStyle, table } from '../output.js';
import { clock, llm, weather } from './fixtures.js';

const agent = { agent: true, width: 100 };
const pretty = { agent: false, width: 100 };

describe('resources', () => {
    it('writes signatures in RequestScript form', () => {
        expect(signature(weather.functions[0])).toBe('temperature(city: string): int32');
    });

    it('prices per call and per million tokens', () => {
        expect(formatUsd(10_000)).toBe('$0.01');
        expect(formatUsd(1_500)).toBe('$0.0015');
        expect(badges(weather.functions[0])).toEqual(['paid $0.01/call']);
        expect(badges(llm.functions[0])).toEqual(['paid $3.00/M in, $15.00/M out', 'restricted', 'inference']);
    });

    it('builds an example request with typed placeholders', () => {
        expect(exampleScript(llm)).toBe([
            'request Example {',
            '    const chat: ai.models.Chat',
            '',
            '    return chat.complete(prompt: "...", maxTokens: 0)',
            '}',
        ].join('\n'));
    });

    it('ranks search results and requires every term', () => {
        const resources = [clock, llm, weather];
        expect(searchResources(resources, 'weather').map((r) => r.name)).toEqual(['Weather']);
        expect(searchResources(resources, 'com.example').map((r) => r.name)).toEqual(['Clock', 'Weather']);
        expect(searchResources(resources, 'temperature oslo').map((r) => r.name)).toEqual(['Weather']);
        expect(searchResources(resources, 'temperature zone')).toEqual([]);
    });

    it('lists signatures inline for agents', () => {
        expect(renderResourceList([weather], plainStyle, agent, 'none')).toBe(
            'com.example.Weather - Current weather conditions\n  temperature(city: string): int32 [paid $0.01/call] - Current temperature in degrees Celsius',
        );
    });

    it('lists a table for people', () => {
        const text = renderResourceList([weather, clock], plainStyle, pretty, 'none');
        expect(text).toContain('RESOURCE             FUNCS  PRICE  HOST            DESCRIPTION');
        expect(text).toContain('com.example.Weather  1      paid   127.0.0.1:3000  Current weather conditions');
        expect(text).toContain('2 resources.');
    });

    it('shows a resource with its example', () => {
        const text = renderResource(weather, plainStyle, pretty);
        expect(text).toContain('temperature(city: string): int32  paid $0.01/call');
        expect(text).toContain('• city  string  City name, such as Oslo');
        expect(text).toContain('return weather.temperature(city: "...")');
        expect(renderResource(weather, plainStyle, agent)).toMatch(/^resource: com\.example\.Weather\n/);
    });
});

describe('run', () => {
    it('finds failed calls anywhere in the return value', () => {
        const value = { a: { value: 1, error: null }, list: [{ value: null, error: { message: 'timed out' } }] };
        expect(failedCalls(value)).toEqual([{ path: '$.list[0]', error: { message: 'timed out' } }]);
    });

    it('renders results for agents', () => {
        const result = { returnValue: { value: null, error: { message: 'timed out' } }, usage: { tokens: 17 } };
        expect(renderRun(result, plainStyle, agent)).toBe('result: {"value":null,"error":{"message":"timed out"}}\ncall_error at $: timed out\ntokens: 17');
    });
});

describe('table', () => {
    it('truncates the last column to fit', () => {
        const text = table(['A', 'B'], [['x', 'a long description that overflows']], { width: 16, style: plainStyle });
        expect(text.split('\n')[1]).toBe('x  a long descr…');
    });
});
