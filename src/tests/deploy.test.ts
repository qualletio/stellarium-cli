import { describe, expect, it } from 'vitest';
import { deployOrder } from '../commands/deploy.js';
import { type Declaration, fieldReferences, parseDeclaration } from '../declaration.js';

describe('parseDeclaration', () => {
    it('reads a contract, defaulting its version to 1', () => {
        expect(parseDeclaration('// Today in words\ncontract com.example.Outlook(city: string): string { return city }')).toMatchObject({
            kind: 'contract', path: 'com.example', name: 'Outlook', version: '1', fields: [],
        });
    });

    it('reads an event contract and a dotted version', () => {
        expect(parseDeclaration('contract shop.OnOrder@1.2.3 consumes shop.Order@1 { }')).toMatchObject({ kind: 'contract', version: '1.2.3' });
    });

    it('reads a restricted event and normalizes its field types', () => {
        expect(parseDeclaration('restricted event shop.Audit(entry: object, total: decimal(10, 2),)')).toEqual({
            kind: 'event', path: 'shop', name: 'Audit', version: '1', restricted: true,
            fields: [{ name: 'entry', type: 'object' }, { name: 'total', type: 'decimal(10,2)' }],
        });
    });

    it('reads an event without fields', () => {
        expect(parseDeclaration('event shop.Tick')).toMatchObject({ kind: 'event', fields: [] });
    });

    it('reads a struct over several lines, ignoring comments', () => {
        const declaration = parseDeclaration('struct shop.Order@2(\n  // where it goes\n  to: shop.Address@1,\n  items: []shop.Item@3\n)');
        expect(declaration.fields).toEqual([{ name: 'to', type: 'shop.Address@1' }, { name: 'items', type: '[]shop.Item@3' }]);
        expect(fieldReferences(declaration.fields)).toEqual(['shop.Address@1', 'shop.Item@3']);
    });

    it('recognizes a request', () => {
        expect(parseDeclaration('request Today { return 1 }')).toMatchObject({ kind: 'request', name: 'Today' });
    });

    it.each([
        ['var x = 1', "doesn't start"],
        ['contract Outlook: string { }', 'no path'],
        ['struct shop.Address(zip: int32)', 'no version'],
    ])('refuses %s', (source, message) => {
        expect(() => parseDeclaration(source)).toThrow(message);
    });
});

describe('deployOrder', () => {
    const script = (source: string) => {
        const declaration: Declaration = parseDeclaration(source);
        return { declaration, ref: `${declaration.path}.${declaration.name}@${declaration.version}` };
    };

    it('puts structs before what names them, then events, then contracts', () => {
        const ordered = deployOrder([
            script('contract a.C(x: a.Outer@1): string { return "" }'),
            script('event a.E(x: a.Outer@1)'),
            script('struct a.Outer@1(inner: a.Inner@1)'),
            script('struct a.Inner@1(zip: int32)'),
        ]);
        expect(ordered.map((item) => item.ref)).toEqual(['a.Inner@1', 'a.Outer@1', 'a.E@1', 'a.C@1']);
    });

    it('terminates on a cycle, leaving the node to refuse it', () => {
        const ordered = deployOrder([script('struct a.A@1(b: a.B@1)'), script('struct a.B@1(a: a.A@1)')]);
        expect(ordered).toHaveLength(2);
    });
});
