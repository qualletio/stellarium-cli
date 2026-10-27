import type { Resource } from '../client.js';

export const weather: Resource = {
    path: 'com.example',
    name: 'Weather',
    baseUrl: 'http://127.0.0.1:3000',
    description: 'Current weather conditions',
    functions: [
        {
            name: 'temperature',
            returnType: 'int32',
            description: 'Current temperature in degrees Celsius',
            parameters: [{ name: 'city', type: 'string', description: 'City name, such as Oslo' }],
            paymentManifest: { costMicroUsd: 10_000, recipientOrganizationId: 'org_1' },
        },
    ],
};

export const llm: Resource = {
    path: 'ai.models',
    name: 'Chat',
    baseUrl: 'https://llm.example.com',
    functions: [
        {
            name: 'complete',
            returnType: 'string',
            kind: 'inference',
            restricted: true,
            parameters: [{ name: 'prompt', type: 'string' }, { name: 'maxTokens', type: 'int32' }],
            paymentManifest: { inputCostMicroUsdPerMillionTokens: 3_000_000, outputCostMicroUsdPerMillionTokens: 15_000_000 },
        },
    ],
};

export const clock: Resource = {
    path: 'com.example',
    name: 'Clock',
    baseUrl: 'http://127.0.0.1:3000',
    description: 'Time in any zone',
    functions: [{ name: 'now', returnType: 'string', parameters: [{ name: 'zone', type: 'string' }] }],
};

export function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
