import { analyzeImportDiagnostics } from '../core/diagnostics';
import { DiagnosticsUnavailableError } from './diagnostic-errors';

import type { ParserResult } from '../parser';
import type { TidyDiagnostic } from '../core/diagnostics';
import type { DiagnosticsSource } from './diagnostic-errors';
import type { EslintDiagnosticsProvider, EslintLintResult } from './eslint-diagnostics';
import type { EslintLinter } from './eslint-host';
import type { TypeScriptDiagnosticsProvider } from './typescript-diagnostics';

export type SourceStatus = 'used' | 'skipped' | 'unavailable' | 'failed';

export interface SourceReport {
    source: DiagnosticsSource;
    status: SourceStatus;
    count: number;
    detail?: string;
    location?: string;
}

export interface CollectedDiagnostics {
    diagnostics: TidyDiagnostic[];
    reports: SourceReport[];
}

export interface CollectRequest {
    filePath: string;
    text: string;
    workspaceRoot: string | undefined;
    initialResult: ParserResult;
    removeUnusedImports: boolean;
}

export class LocalEslintLinter implements EslintLinter {
    constructor(private readonly provider: EslintDiagnosticsProvider) {}

    lint(filePath: string, text: string, workspaceRoot: string | undefined): Promise<EslintLintResult> {
        return this.provider.lint(filePath, text, workspaceRoot);
    }

    warm(): void {
        return;
    }

    prefetch(): void {
        return;
    }

    dispose(): void {
        return;
    }
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
    return promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
}

export class LazyEslintLinter implements EslintLinter {
    private linter: EslintLinter | undefined;

    constructor(private readonly create: () => EslintLinter) {}

    private instance(): EslintLinter {
        this.linter ??= this.create();
        return this.linter;
    }

    lint(filePath: string, text: string, workspaceRoot: string | undefined): Promise<EslintLintResult> {
        return this.instance().lint(filePath, text, workspaceRoot);
    }

    warm(filePath: string, workspaceRoot: string | undefined): void {
        this.instance().warm(filePath, workspaceRoot);
    }

    prefetch(files: { filePath: string; workspaceRoot: string | undefined }[]): void {
        this.instance().prefetch(files);
    }

    dispose(): void {
        this.linter?.dispose();
    }
}

export class CliDiagnostics {
    constructor(
        private readonly typescript: TypeScriptDiagnosticsProvider | undefined,
        private readonly eslint: EslintLinter | undefined,
        private readonly fastAnalysis = false
    ) {}

    async collect(request: CollectRequest): Promise<CollectedDiagnostics> {
        const { filePath, text, workspaceRoot } = request;
        const diagnostics: TidyDiagnostic[] = [];
        const reports: SourceReport[] = [];
        let fastAnalysisNote: string | undefined;

        if (this.fastAnalysis && this.typescript && this.eslint) {
            const verdict = this.typescript.fastAnalysis(filePath, text, workspaceRoot);
            if (verdict.decided) {
                return {
                    diagnostics: verdict.diagnostics,
                    reports: [
                        { source: 'typescript', status: 'used', count: verdict.diagnostics.length, detail: 'fast import analysis' },
                        { source: 'eslint', status: 'skipped', count: 0, detail: 'not needed: fast import analysis decided' },
                    ],
                };
            }
            if (verdict.stage === 'file') {
                return this.collectFileOnly(request, this.typescript, this.eslint, verdict.reason);
            }
            fastAnalysisNote = `full analysis because ${verdict.reason}`;
        }

        const eslintNeededUpfront = request.removeUnusedImports;
        let eslintRun = this.eslint && eslintNeededUpfront ? settle(this.eslint.lint(filePath, text, workspaceRoot)) : undefined;

        let typescriptDiagnostics: TidyDiagnostic[] = [];
        if (!this.typescript) {
            reports.push({ source: 'typescript', status: 'skipped', count: 0, detail: 'disabled by --no-typescript' });
        } else {
            try {
                typescriptDiagnostics = await this.typescript.getDiagnostics(filePath, text, workspaceRoot);
                const project = await this.typescript.describe(filePath, workspaceRoot);
                diagnostics.push(...typescriptDiagnostics);
                reports.push({
                    source: 'typescript',
                    status: 'used',
                    count: typescriptDiagnostics.length,
                    detail: [
                        project ? `${project.kind === 'configured' ? 'project' : 'inferred project'}, TypeScript ${project.typescriptVersion}` : undefined,
                        fastAnalysisNote,
                    ].filter(Boolean).join(', ') || undefined,
                    location: project?.configPath,
                });
            } catch (error) {
                reports.push(describeFailure('typescript', error));
            }
        }

        if (!this.eslint) {
            reports.push({ source: 'eslint', status: 'skipped', count: 0, detail: 'disabled by --no-eslint' });
            return { diagnostics, reports };
        }

        if (!eslintRun) {
            const typescriptRan = reports.some((report) => report.source === 'typescript' && report.status === 'used');
            const missingModules = analyzeImportDiagnostics(request.initialResult, typescriptDiagnostics).missingModules;
            if (typescriptRan && missingModules.size === 0) {
                reports.push({ source: 'eslint', status: 'skipped', count: 0, detail: 'not needed: no missing module to clean up' });
                return { diagnostics, reports };
            }
            eslintRun = settle(this.eslint.lint(filePath, text, workspaceRoot));
        }

        reports.push(eslintReport(await eslintRun, diagnostics));
        return { diagnostics, reports };
    }

    private async collectFileOnly(
        request: CollectRequest,
        typescript: TypeScriptDiagnosticsProvider,
        eslint: EslintLinter,
        reason: string
    ): Promise<CollectedDiagnostics> {
        const { filePath, text, workspaceRoot } = request;
        if (!request.removeUnusedImports) {
            return {
                diagnostics: [],
                reports: [
                    { source: 'typescript', status: 'used', count: 0, detail: `fast import analysis: every module resolves (${reason})` },
                    { source: 'eslint', status: 'skipped', count: 0, detail: 'not needed: no missing module to clean up' },
                ],
            };
        }

        const eslintRun = settle(eslint.lint(filePath, text, workspaceRoot));
        const diagnostics: TidyDiagnostic[] = [];
        const reports: SourceReport[] = [];
        try {
            const typescriptDiagnostics = typescript.fileOnlyUnusedDiagnostics(filePath, text, workspaceRoot);
            diagnostics.push(...typescriptDiagnostics);
            reports.push({ source: 'typescript', status: 'used', count: typescriptDiagnostics.length, detail: `file-only analysis because ${reason}` });
        } catch (error) {
            reports.push(describeFailure('typescript', error));
        }
        reports.push(eslintReport(await eslintRun, diagnostics));
        return { diagnostics, reports };
    }
}

function eslintReport(outcome: Settled<EslintLintResult>, diagnostics: TidyDiagnostic[]): SourceReport {
    if (!outcome.ok) {
        return describeFailure('eslint', outcome.error);
    }
    const result = outcome.value;
    diagnostics.push(...result.diagnostics);
    return {
        source: 'eslint',
        status: result.status === 'linted' ? 'used' : result.status === 'not-installed' || result.status === 'not-configured' ? 'unavailable' : 'skipped',
        count: result.diagnostics.length,
        detail: result.status,
        location: result.workingDirectory,
    };
}

function describeFailure(source: DiagnosticsSource, error: unknown): SourceReport {
    if (error instanceof DiagnosticsUnavailableError) {
        return { source, status: error.source === 'typescript' && /not installed/.test(error.message) ? 'unavailable' : 'failed', count: 0, detail: error.message };
    }
    return { source, status: 'failed', count: 0, detail: error instanceof Error ? error.message.split('\n')[0] : String(error) };
}
