import { ImportParser } from '../../src/parser';
import { formatImports } from '../../src/formatter';
import type { Config } from '../../src/types';

const config: Config = {
    groups: [
        { name: '@app', order: 1, match: /^@app/ },
        { name: 'Other', order: 0, default: true },
    ],
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
        '// @ts-nocheck',
        '// @ts-check',
        '// @jsxImportSource @emotion/react',
        '// @flow',
        '// @refresh reset',
    ])('keeps %s exactly once at the top of the file', async (directive) => {
        const code = `${directive}\nimport { b } from 'b';\nimport a from 'a';\n\nexport const x = 1;\n`;
        const formatted = await format(code);
        expect(formatted.startsWith(`${directive}\n`)).toBe(true);
        expect(formatted.split(directive).length - 1).toBe(1);
    });

    test('keeps the directive when it is separated from the imports by a blank line', async () => {
        const code = `// @vitest-environment jsdom\n\nimport { b } from 'b';\nimport a from 'a';\n\nexport const x = 1;\n`;
        const formatted = await format(code);
        expect(formatted.startsWith('// @vitest-environment jsdom\n')).toBe(true);
    });

    test('keeps several stacked directives in order', async () => {
        const code = `// @vitest-environment jsdom\n// @ts-nocheck\nimport { b } from 'b';\nimport a from 'a';\n\nexport const x = 1;\n`;
        const formatted = await format(code);
        expect(formatted.startsWith('// @vitest-environment jsdom\n// @ts-nocheck\n')).toBe(true);
    });

    test('keeps the directive when a group comment follows it', async () => {
        const code = `// @vitest-environment jsdom\n// Other\nimport a from 'a';\n\nexport const x = 1;\n`;
        const formatted = await format(code);
        expect(formatted.startsWith('// @vitest-environment jsdom\n')).toBe(true);
        expect(formatted.split('// @vitest-environment jsdom').length - 1).toBe(1);
    });

    test('keeps the directive after a file header block comment', async () => {
        const code = `/**\n * header\n */\n// @vitest-environment jsdom\nimport { b } from 'b';\nimport a from 'a';\n\nexport const x = 1;\n`;
        const formatted = await format(code);
        expect(formatted).toContain('// @vitest-environment jsdom\n');
        expect(formatted.split('// @vitest-environment jsdom').length - 1).toBe(1);
    });

    test('is stable when formatting twice', async () => {
        const code = `// @vitest-environment jsdom\nimport { b } from 'b';\nimport a from 'a';\nimport c from '@app/c';\n\nexport const x = 1;\n`;
        const once = await format(code);
        const twice = await format(once);
        expect(twice).toBe(once);
    });

    test('excludes the directive from the import range', () => {
        const code = `// @vitest-environment jsdom\nimport a from 'a';\n\nexport const x = 1;\n`;
        const parser = new ImportParser(config);
        const result = parser.parse(code);
        expect(result.importRange?.start).toBe('// @vitest-environment jsdom\n'.length);
    });

    test('still treats a group comment such as // @app as a group comment', async () => {
        const code = `// @app\nimport c from '@app/c';\nimport a from 'a';\n\nexport const x = 1;\n`;
        const parser = new ImportParser(config);
        const result = parser.parse(code);
        expect(result.importRange?.start).toBe(0);
        const formatted = await format(code);
        expect(formatted.split('// @app\n').length - 1).toBe(1);
    });
});
