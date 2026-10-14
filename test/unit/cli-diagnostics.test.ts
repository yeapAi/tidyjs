import { CliDiagnostics } from '../../src/cli/diagnostics';
import { ImportParser } from '../../src/parser';

import type { Linter, LinterName } from '../../src/cli/linter';
import type { TypeScriptDiagnosticsProvider } from '../../src/cli/typescript-diagnostics';
import type { TidyDiagnostic } from '../../src/core/diagnostics';

jest.mock('../../src/utils/log', () => ({ logDebug: jest.fn(), logError: jest.fn() }));

const SOURCE = "import { gone } from 'missing';\nimport { a } from 'a';\nexport const x = a;\n";

function initialResult() {
    const parser = new ImportParser({ groups: [{ name: 'Other', order: 0, default: true }], importOrder: { sideEffect: 0, default: 1, named: 2, typeOnly: 3 } });
    try {
        return parser.parse(SOURCE, undefined, undefined, 'file.ts');
    } finally {
        parser.dispose();
    }
}

function typescriptReturning(diagnostics: TidyDiagnostic[]): TypeScriptDiagnosticsProvider {
    return {
        getDiagnostics: async () => diagnostics,
        describe: async () => ({ kind: 'configured', configPath: '/p/tsconfig.json', typescriptVersion: '5.9.3', typescriptPath: '/ts' }),
    } as unknown as TypeScriptDiagnosticsProvider;
}

function linterSpy(name: LinterName, diagnostics: TidyDiagnostic[]): Linter & { lint: jest.Mock } {
    return {
        name,
        lint: jest.fn(async () => ({ status: 'linted' as const, diagnostics })),
        fixAll: jest.fn(),
        dispose: jest.fn(),
    };
}

const oxlintUnused: TidyDiagnostic = { source: 'oxc', code: 'eslint(no-unused-vars)', message: "Identifier 'gone' is imported but never used.", severity: 'error' };
const eslintUnused: TidyDiagnostic = { source: 'eslint', code: '@typescript-eslint/no-unused-vars', message: "'a' is defined but never used.", severity: 'warning' };

function oxlintSpy(): Linter & { lint: jest.Mock } {
    return linterSpy('oxlint', [oxlintUnused]);
}

const missing: TidyDiagnostic = { source: 'ts', code: 2307, severity: 'error', message: "Cannot find module 'missing' or its corresponding type declarations." };

describe('CliDiagnostics', () => {
    test('runs oxlint alongside TypeScript when unused imports are removed', async () => {
        const oxlint = oxlintSpy();
        const collected = await new CliDiagnostics(typescriptReturning([]), [oxlint])
            .collect({ filePath: '/p/file.ts', text: SOURCE, workspaceRoot: '/p', initialResult: initialResult(), removeUnusedImports: true });

        expect(oxlint.lint).toHaveBeenCalledTimes(1);
        expect(collected.diagnostics).toHaveLength(1);
    });

    test('skips oxlint when only missing modules are removed and TypeScript finds none', async () => {
        const oxlint = oxlintSpy();
        const collected = await new CliDiagnostics(typescriptReturning([]), [oxlint])
            .collect({ filePath: '/p/file.ts', text: SOURCE, workspaceRoot: '/p', initialResult: initialResult(), removeUnusedImports: false });

        expect(oxlint.lint).not.toHaveBeenCalled();
        expect(collected.reports.find((report) => report.source === 'oxlint')).toMatchObject({ status: 'skipped' });
    });

    test('still runs oxlint for unused names of a missing module', async () => {
        const oxlint = oxlintSpy();
        const collected = await new CliDiagnostics(typescriptReturning([missing]), [oxlint])
            .collect({ filePath: '/p/file.ts', text: SOURCE, workspaceRoot: '/p', initialResult: initialResult(), removeUnusedImports: false });

        expect(oxlint.lint).toHaveBeenCalledTimes(1);
        expect(collected.diagnostics).toHaveLength(2);
    });

    test('runs every linter alongside TypeScript, keeps the diagnostics of all of them and reports each one', async () => {
        const oxlint = oxlintSpy();
        const eslint = linterSpy('eslint', [eslintUnused]);
        const collected = await new CliDiagnostics(typescriptReturning([]), [oxlint, eslint])
            .collect({ filePath: '/p/file.ts', text: SOURCE, workspaceRoot: '/p', initialResult: initialResult(), removeUnusedImports: true });

        expect(oxlint.lint).toHaveBeenCalledTimes(1);
        expect(eslint.lint).toHaveBeenCalledTimes(1);
        expect(collected.diagnostics).toEqual([oxlintUnused, eslintUnused]);
        expect(collected.reports.map((report) => [report.source, report.status])).toEqual([['typescript', 'used'], ['oxlint', 'used'], ['eslint', 'used']]);
    });

    test('reports a linter that is not installed or not configured as unavailable and still uses the other one', async () => {
        const oxlint = linterSpy('oxlint', []);
        oxlint.lint.mockResolvedValue({ status: 'not-installed', diagnostics: [] });
        const eslint = linterSpy('eslint', [eslintUnused]);
        const collected = await new CliDiagnostics(typescriptReturning([]), [oxlint, eslint])
            .collect({ filePath: '/p/file.ts', text: SOURCE, workspaceRoot: '/p', initialResult: initialResult(), removeUnusedImports: true });

        expect(collected.diagnostics).toEqual([eslintUnused]);
        expect(collected.reports.find((report) => report.source === 'oxlint')).toMatchObject({ status: 'unavailable', detail: 'not-installed' });
        expect(collected.reports.find((report) => report.source === 'eslint')).toMatchObject({ status: 'used' });
    });

    test('a failing linter is a failed report and does not stop the others', async () => {
        const oxlint = oxlintSpy();
        oxlint.lint.mockRejectedValue(new Error('server crashed'));
        const eslint = linterSpy('eslint', [eslintUnused]);
        const collected = await new CliDiagnostics(typescriptReturning([]), [oxlint, eslint])
            .collect({ filePath: '/p/file.ts', text: SOURCE, workspaceRoot: '/p', initialResult: initialResult(), removeUnusedImports: true });

        expect(collected.diagnostics).toEqual([eslintUnused]);
        expect(collected.reports.find((report) => report.source === 'oxlint')).toMatchObject({ status: 'failed', detail: 'server crashed' });
    });

    test('skips every linter when only missing modules are removed and TypeScript finds none', async () => {
        const oxlint = oxlintSpy();
        const eslint = linterSpy('eslint', []);
        const collected = await new CliDiagnostics(typescriptReturning([]), [oxlint, eslint])
            .collect({ filePath: '/p/file.ts', text: SOURCE, workspaceRoot: '/p', initialResult: initialResult(), removeUnusedImports: false });

        expect(oxlint.lint).not.toHaveBeenCalled();
        expect(eslint.lint).not.toHaveBeenCalled();
        expect(collected.reports.filter((report) => report.status === 'skipped').map((report) => report.source)).toEqual(['oxlint', 'eslint']);
    });

    test('works with TypeScript alone when every linter is disabled', async () => {
        const collected = await new CliDiagnostics(typescriptReturning([missing]), [])
            .collect({ filePath: '/p/file.ts', text: SOURCE, workspaceRoot: '/p', initialResult: initialResult(), removeUnusedImports: true });

        expect(collected.diagnostics).toEqual([missing]);
        expect(collected.reports.map((report) => report.source)).toEqual(['typescript']);
    });
});
