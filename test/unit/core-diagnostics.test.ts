import { analyzeImportDiagnostics, buildImportFilters, findImportBindingSpans, needsDiagnostics } from '../../src/core/diagnostics';
import { ImportParser } from '../../src/parser';
import { toTidyDiagnostic } from '../../src/vscode/diagnostics';
import { Diagnostic, DiagnosticSeverity, Range } from 'vscode';

import type { TidyDiagnostic } from '../../src/core/diagnostics';
import type { Config } from '../../src/types';

jest.mock('../../src/utils/log', () => ({
    logDebug: jest.fn(),
    logError: jest.fn(),
}));

const config: Config = {
    groups: [{ name: 'Other', order: 0, default: true }],
    importOrder: { sideEffect: 0, default: 1, named: 2, typeOnly: 3 },
    format: { removeUnusedImports: true, removeMissingModules: true },
};

const source = [
    "import React from 'react';",
    "import { a, b } from 'lib';",
    "import type { T } from 'types';",
    "import { gone } from 'missing-module';",
    "import * as ns from 'ns';",
    '',
    'export const x = [a, React];',
].join('\n');

function analyze(diagnostics: TidyDiagnostic[]) {
    const parser = new ImportParser(config);
    try {
        return analyzeImportDiagnostics(parser.parse(source, undefined, undefined, 'file.ts'), diagnostics);
    } finally {
        parser.dispose();
    }
}

describe('analyzeImportDiagnostics', () => {
    test('collects unused names from TypeScript and ESLint codes', () => {
        const result = analyze([
            { source: 'ts', code: 6133, severity: 'hint', message: "'b' is declared but its value is never read." },
            { source: 'ts', code: 6196, severity: 'hint', message: "'T' is declared but never used." },
            { source: 'eslint', code: '@typescript-eslint/no-unused-vars', severity: 'warning', message: "'ns' is defined but never used." },
        ]);

        expect(result.unusedImports.sort()).toEqual(['T', 'b']);
        expect(result.missingModules.size).toBe(0);
    });

    test('does not match unused namespace imports (behavior of 1.9.2, kept for parity)', () => {
        const result = analyze([
            { source: 'eslint', code: '@typescript-eslint/no-unused-vars', severity: 'warning', message: "'ns' is defined but never used." },
        ]);

        expect(result.unusedImports).toEqual([]);
    });

    test('ignores information severity, unknown codes and names that are not imported', () => {
        const result = analyze([
            { source: 'ts', code: 6133, severity: 'info', message: "'b' is declared but its value is never read." },
            { source: 'eslint', code: 'no-unused-vars', severity: 'warning', message: "'a' is defined but never used." },
            { source: 'ts', code: 6133, severity: 'hint', message: "'local' is declared but its value is never read." },
        ]);

        expect(result.unusedImports).toEqual([]);
    });

    test('does not match TypeScript 6192, whose message names no import', () => {
        const result = analyze([
            { source: 'ts', code: 6192, severity: 'hint', message: 'All imports in import declaration are unused.' },
        ]);

        expect(result.unusedImports).toEqual([]);
    });

    test('collects missing modules only from error-level 2307 and 2318', () => {
        const result = analyze([
            { source: 'ts', code: 2307, severity: 'error', message: "Cannot find module 'missing-module' or its corresponding type declarations." },
            { source: 'ts', code: 2307, severity: 'warning', message: "Cannot find module 'lib' or its corresponding type declarations." },
            { source: 'ts', code: 6133, severity: 'hint', message: "'gone' is declared but its value is never read." },
        ]);

        expect([...result.missingModules]).toEqual(['missing-module']);
        expect([...result.unusedFromMissing]).toEqual(['gone']);
    });

    test('returns an empty analysis without diagnostics', () => {
        expect(analyze([])).toEqual({ unusedImports: [], missingModules: new Set(), unusedFromMissing: new Set() });
    });
});

describe('findImportBindingSpans', () => {
    test('maps each import declaration to the names it binds', () => {
        const text = "import React, { useState as useLocal } from 'react';\nimport * as ns from 'ns';\nimport './side';\nconst x = 1;\n";
        const spans = findImportBindingSpans(text, 'file.tsx');

        expect(spans.map((span) => [...span.names])).toEqual([['React', 'useLocal'], ['ns'], []]);
        expect(text.slice(spans[1].start, spans[1].end)).toBe("import * as ns from 'ns';");
    });

    test('only counts unused names whose diagnostic points into their import', () => {
        const parser = new ImportParser(config);
        const text = "import { a } from 'lib';\nexport const f = (a: number) => 1;\nexport const g = a;\n";
        try {
            const spans = findImportBindingSpans(text, 'file.ts');
            const parameter = { source: 'ts', code: 6133, severity: 'hint' as const, message: "'a' is declared but its value is never read.", start: text.indexOf('a: number') };
            const atImport = { ...parameter, start: text.indexOf('{ a }') + 2 };
            const result = parser.parse(text, undefined, undefined, 'file.ts');

            expect(analyzeImportDiagnostics(result, [parameter], spans).unusedImports).toEqual([]);
            expect(analyzeImportDiagnostics(result, [atImport], spans).unusedImports).toEqual(['a']);
        } finally {
            parser.dispose();
        }
    });
});

describe('buildImportFilters', () => {
    const analysis = { unusedImports: ['b'], missingModules: new Set(['missing-module']), unusedFromMissing: new Set(['gone']) };

    test('applies both filters when both options are on', () => {
        expect(buildImportFilters(config, analysis)).toEqual({ unusedImports: ['b'], missingModules: new Set(['missing-module']) });
    });

    test('keeps only unused names from missing modules when removeUnusedImports is off', () => {
        const filters = buildImportFilters({ ...config, format: { removeMissingModules: true } }, analysis);
        expect(filters).toEqual({ unusedImports: ['gone'], missingModules: new Set(['missing-module']) });
    });

    test('needsDiagnostics follows the two removal options', () => {
        expect(needsDiagnostics({ ...config, format: {} })).toBe(false);
        expect(needsDiagnostics({ ...config, format: { removeMissingModules: true } })).toBe(true);
    });
});

describe('toTidyDiagnostic (VS Code adapter)', () => {
    test('normalizes ESLint object codes and VS Code severities', () => {
        const diagnostic = new Diagnostic(new Range(0, 0, 0, 1) as never, "'a' is defined but never used.", DiagnosticSeverity.Warning);
        diagnostic.code = { value: '@typescript-eslint/no-unused-vars', target: 'https://example.invalid' };
        diagnostic.source = 'eslint';

        expect(toTidyDiagnostic(diagnostic as never)).toEqual({
            source: 'eslint',
            code: '@typescript-eslint/no-unused-vars',
            message: "'a' is defined but never used.",
            severity: 'warning',
        });
    });

    test('adds the document offsets of the range', () => {
        const diagnostic = new Diagnostic({ start: { line: 1, character: 2 }, end: { line: 1, character: 5 } } as never, 'x', DiagnosticSeverity.Hint);
        const document = { offsetAt: (position: { line: number; character: number }) => position.line * 100 + position.character };

        expect(toTidyDiagnostic(diagnostic as never, document as never)).toMatchObject({ start: 102, length: 3 });
    });

    test('keeps numeric TypeScript codes and maps Hint', () => {
        const diagnostic = new Diagnostic(new Range(0, 0, 0, 1) as never, 'x', DiagnosticSeverity.Hint);
        diagnostic.code = 6133;

        expect(toTidyDiagnostic(diagnostic as never)).toMatchObject({ code: 6133, severity: 'hint' });
    });
});
