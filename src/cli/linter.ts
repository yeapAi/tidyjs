import type { TidyDiagnostic } from '../core/diagnostics';

export type LinterName = 'oxlint' | 'eslint';

export type LinterFileStatus = 'linted' | 'ignored' | 'disabled' | 'not-validated' | 'not-installed' | 'not-configured';

export interface LinterLintResult {
    status: LinterFileStatus;
    diagnostics: TidyDiagnostic[];
    warnings?: string[];
    workingDirectory?: string;
}

export interface LinterFixResult {
    status: LinterFileStatus;
    output?: string;
    workingDirectory?: string;
}

export interface Linter {
    readonly name: LinterName;
    lint(filePath: string, text: string, workspaceRoot: string | undefined): Promise<LinterLintResult>;
    fixAll(filePath: string, text: string, workspaceRoot: string | undefined): Promise<LinterFixResult>;
    warm?(filePath: string, workspaceRoot: string | undefined): void;
    prefetch?(files: { filePath: string; workspaceRoot: string | undefined }[]): void;
    dispose(): void;
}
