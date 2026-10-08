import { formatSource, ParserCache } from '../../src/core/pipeline';

import type { FormatRequest } from '../../src/core/pipeline';
import type { TidyDiagnostic } from '../../src/core/diagnostics';
import type { Config } from '../../src/types';

jest.mock('../../src/utils/log', () => ({
    logDebug: jest.fn(),
    logError: jest.fn(),
    notifyError: jest.fn(),
}));

const baseConfig: Config = {
    groups: [{ name: 'Other', order: 0, default: true }],
    importOrder: { sideEffect: 0, default: 1, named: 2, typeOnly: 3 },
    format: { indent: 4, singleQuote: true, bracketSpacing: true },
};

function request(overrides: Partial<FormatRequest>): FormatRequest {
    return {
        text: '',
        filePath: '/workspace/src/file.ts',
        config: baseConfig,
        workspaceRoot: '/workspace',
        parsers: new ParserCache(),
        profile: 'editor',
        ...overrides,
    };
}

const typeMembers = [
    "import { b } from 'b';",
    '',
    'export interface Options {',
    '    verbose: boolean;',
    '    id: number;',
    '    patch: typeof b;',
    '}',
    '',
].join('\n');

describe('formatSource profiles', () => {
    const sortTypeMembersOnly: Config = { ...baseConfig, format: { ...baseConfig.format, sortTypeMembers: true } };

    test('editor profile does not sort type members of a file with imports (1.9.2 behavior)', async () => {
        const outcome = await formatSource(request({ text: typeMembers, config: sortTypeMembersOnly }));
        expect(outcome.status).toBe('changed');
        expect(outcome.status === 'changed' && outcome.text).toContain('verbose: boolean;\n    id: number;');
    });

    test('folder profile sorts type members of the same file', async () => {
        const outcome = await formatSource(request({ text: typeMembers, config: sortTypeMembersOnly, profile: 'folder' }));
        expect(outcome.status === 'changed' && outcome.text).toContain('id: number;\n    patch: typeof b;\n    verbose: boolean;');
    });

    test('editor profile sorts type members when the file has no imports', async () => {
        const text = 'export interface Options {\n    verbose: boolean;\n    id: number;\n}\n';
        const outcome = await formatSource(request({ text, config: sortTypeMembersOnly }));
        expect(outcome.status === 'changed' && outcome.text).toBe('export interface Options {\n    id: number;\n    verbose: boolean;\n}\n');
    });

    test('folder profile reports empty files', async () => {
        expect(await formatSource(request({ text: '  \n', profile: 'folder' }))).toMatchObject({ status: 'unchanged', reason: 'empty' });
    });

    test('both profiles honour the ignore pragma', async () => {
        const text = "// tidyjs-ignore\nimport { b, a } from 'x';\n";
        expect(await formatSource(request({ text }))).toMatchObject({ status: 'unchanged', reason: 'ignored' });
        expect(await formatSource(request({ text, profile: 'folder' }))).toMatchObject({ status: 'unchanged', reason: 'ignored' });
    });
});

describe('formatSource guards', () => {
    const broken = "import { a } from 'a';\nexport const x = (;\n";

    test('editor profile leaves a file with a syntax error untouched and reports the parse error', async () => {
        const outcome = await formatSource(request({ text: broken }));
        expect(outcome).toMatchObject({ status: 'unchanged', reason: 'no-imports' });
        expect(outcome.status === 'unchanged' && outcome.parseError).toMatch(/Syntax error/);
    });

    test('folder profile reports the same file as invalid imports', async () => {
        expect(await formatSource(request({ text: broken, profile: 'folder' }))).toMatchObject({ status: 'failed', stage: 'invalid-imports' });
    });
});

describe('formatSource diagnostics', () => {
    const text = [
        "import { used, unused } from 'lib';",
        "import { gone } from 'missing';",
        '',
        'export const x = [used, gone];',
        '',
    ].join('\n');
    const removalConfig: Config = { ...baseConfig, format: { ...baseConfig.format, removeUnusedImports: true, removeMissingModules: true } };
    const diagnostics: TidyDiagnostic[] = [
        { source: 'ts', code: 6133, severity: 'hint', message: "'unused' is declared but its value is never read.", start: text.indexOf('unused') },
        { source: 'ts', code: 2307, severity: 'error', message: "Cannot find module 'missing' or its corresponding type declarations.", start: text.indexOf("'missing'") },
    ];

    test('removes unused names and missing modules from normalized diagnostics', async () => {
        const outcome = await formatSource(request({ text, config: removalConfig, getDiagnostics: async () => diagnostics }));

        expect(outcome.status === 'changed' && outcome.text).toBe("// Other\nimport { used } from 'lib';\n\nexport const x = [used, gone];\n");
        expect(outcome.diagnostics).toMatchObject({ requested: true, count: 2, unusedImports: ['unused'], missingModules: ['missing'] });
    });

    test('keeps a used import when another declaration with the same name is reported unused', async () => {
        const source = [
            "import { format } from 'date-fns';",
            '',
            "export const today = format(new Date(), 'yyyy-MM-dd');",
            'export const label = (value: string, format: string): string => value;',
            '',
        ].join('\n');
        const parameterStart = source.indexOf('format: string');
        const outcome = await formatSource(request({
            text: source,
            config: removalConfig,
            getDiagnostics: async () => [
                { source: 'ts', code: 6133, severity: 'hint', message: "'format' is declared but its value is never read.", start: parameterStart },
                { source: 'eslint', code: '@typescript-eslint/no-unused-vars', severity: 'error', message: "'format' is defined but never used.", start: parameterStart },
            ],
        }));

        expect(outcome.status === 'changed' && outcome.text).toContain("import { format } from 'date-fns';");
        expect(outcome.diagnostics.unusedImports).toEqual([]);
    });

    test('ignores unused-name diagnostics without a position', async () => {
        const outcome = await formatSource(request({
            text,
            config: removalConfig,
            getDiagnostics: async () => [{ source: 'other', code: 6133, severity: 'hint', message: "'unused' is declared but its value is never read." }],
        }));

        expect(outcome.diagnostics.unusedImports).toEqual([]);
    });

    test('does not ask for diagnostics when the file has no import to filter', async () => {
        const getDiagnostics = jest.fn(async () => diagnostics);
        const outcome = await formatSource(request({ text: 'export const a = 1;\n', config: removalConfig, getDiagnostics }));

        expect(getDiagnostics).not.toHaveBeenCalled();
        expect(outcome).toMatchObject({ status: 'unchanged', diagnostics: { requested: false } });
    });

    test('does not ask for diagnostics when both removal options are off', async () => {
        const getDiagnostics = jest.fn(async () => diagnostics);
        const outcome = await formatSource(request({ text, getDiagnostics }));

        expect(getDiagnostics).not.toHaveBeenCalled();
        expect(outcome.diagnostics.requested).toBe(false);
    });

    test('formats without removing anything when diagnostics are unavailable', async () => {
        const outcome = await formatSource(request({
            text,
            config: removalConfig,
            getDiagnostics: async () => { throw new Error('no source'); },
        }));

        expect(outcome.status === 'changed' && outcome.text).toContain("import { gone } from 'missing';");
        expect(outcome.status === 'changed' && outcome.text).toContain('unused');
        expect(outcome.diagnostics.error).toBe('no source');
        expect(outcome.diagnostics.unusedImports).toEqual([]);
    });
});

describe('ParserCache', () => {
    test('creates distinct parsers for configs that differ only by a regex', () => {
        const cache = new ParserCache();
        const first = cache.get({ ...baseConfig, groups: [{ name: 'Other', order: 0, default: true, match: /^a/ }] });
        const second = cache.get({ ...baseConfig, groups: [{ name: 'Other', order: 0, default: true, match: /^b/ }] });

        expect(first).not.toBe(second);
        cache.clear();
    });

    test('reuses a parser for an equal config and evicts the oldest entry at capacity', () => {
        const entries = new Map();
        const cache = new ParserCache(entries, 1);
        const parser = cache.get(baseConfig);

        expect(cache.get({ ...baseConfig })).toBe(parser);
        cache.get({ ...baseConfig, format: { indent: 2 } });
        expect(entries.size).toBe(1);
        cache.clear();
    });

    test('keeps the groups of a parser still in use after its eviction or a clear', () => {
        const cache = new ParserCache(new Map(), 1);
        const parser = cache.get({ ...baseConfig, groups: [{ name: 'React', order: 0, match: /^react$/ }, { name: 'Other', order: 1, default: true }] });

        cache.get({ ...baseConfig, format: { indent: 2 } });
        expect(parser.determineGroup('react').groupName).toBe('React');

        cache.clear();
        expect(parser.determineGroup('react').groupName).toBe('React');
    });
});
