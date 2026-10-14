import { CliDiagnostics } from '../../src/cli/diagnostics';
import { ImportParser } from '../../src/parser';

import type { OxlintLinter } from '../../src/cli/oxlint-diagnostics';
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

function oxlintSpy(): OxlintLinter & { lint: jest.Mock } {
    return {
        lint: jest.fn(async () => ({ status: 'linted' as const, diagnostics: [{ source: 'oxc', code: 'eslint(no-unused-vars)', message: "Identifier 'gone' is imported but never used.", severity: 'error' as const }] })),
        fixAll: jest.fn(),
        dispose: jest.fn(),
    };
}

const missing: TidyDiagnostic = { source: 'ts', code: 2307, severity: 'error', message: "Cannot find module 'missing' or its corresponding type declarations." };

describe('CliDiagnostics', () => {
    test('runs oxlint alongside TypeScript when unused imports are removed', async () => {
        const oxlint = oxlintSpy();
        const collected = await new CliDiagnostics(typescriptReturning([]), oxlint)
            .collect({ filePath: '/p/file.ts', text: SOURCE, workspaceRoot: '/p', initialResult: initialResult(), removeUnusedImports: true });

        expect(oxlint.lint).toHaveBeenCalledTimes(1);
        expect(collected.diagnostics).toHaveLength(1);
    });

    test('skips oxlint when only missing modules are removed and TypeScript finds none', async () => {
        const oxlint = oxlintSpy();
        const collected = await new CliDiagnostics(typescriptReturning([]), oxlint)
            .collect({ filePath: '/p/file.ts', text: SOURCE, workspaceRoot: '/p', initialResult: initialResult(), removeUnusedImports: false });

        expect(oxlint.lint).not.toHaveBeenCalled();
        expect(collected.reports.find((report) => report.source === 'oxlint')).toMatchObject({ status: 'skipped' });
    });

    test('still runs oxlint for unused names of a missing module', async () => {
        const oxlint = oxlintSpy();
        const collected = await new CliDiagnostics(typescriptReturning([missing]), oxlint)
            .collect({ filePath: '/p/file.ts', text: SOURCE, workspaceRoot: '/p', initialResult: initialResult(), removeUnusedImports: false });

        expect(oxlint.lint).toHaveBeenCalledTimes(1);
        expect(collected.diagnostics).toHaveLength(2);
    });
});
