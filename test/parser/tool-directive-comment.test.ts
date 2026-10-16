import { ImportParser } from '../../src/parser';
import { formatImports } from '../../src/formatter';
import type { Config } from '../../src/types';

const config: Config = {
    groups: [{ name: 'Other', order: 0, default: true }],
    importOrder: { sideEffect: 0, default: 1, named: 2, typeOnly: 3 },
    format: { indent: 4, singleQuote: true, bracketSpacing: true },
};

const format = async (code: string): Promise<string> => {
    const parser = new ImportParser(config);
    const result = parser.parse(code);
    return (await formatImports(code, config, result)).text;
};

describe('tool directive comments before the first import', () => {
    test.each([
        '// @vitest-environment jsdom',
        '// @jest-environment jsdom',
        '// @vitest-environment-options { "url": "http://localhost" }',
    ])('keeps %s', async (directive) => {
        const code = `${directive}\nimport { b } from 'b';\nimport a from 'a';\n\nexport const x = 1;\n`;
        const formatted = await format(code);
        expect(formatted.startsWith(`${directive}\n`)).toBe(true);
        expect(formatted.split(directive).length - 1).toBe(1);
    });

    test('keeps the directive and still moves the group comment', async () => {
        const code = `// @vitest-environment jsdom\n// Other\nimport a from 'a';\n\nexport const x = 1;\n`;
        const formatted = await format(code);
        expect(formatted.startsWith('// @vitest-environment jsdom\n')).toBe(true);
    });
});
