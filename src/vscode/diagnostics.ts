import { DiagnosticSeverity, languages } from 'vscode';

import { perfMonitor } from '../utils/performance';

import type { Diagnostic, TextDocument, Uri } from 'vscode';
import type { TidyDiagnostic, TidyDiagnosticSeverity } from '../core/diagnostics';

const SEVERITY_BY_VSCODE: Record<DiagnosticSeverity, TidyDiagnosticSeverity> = {
    [DiagnosticSeverity.Error]: 'error',
    [DiagnosticSeverity.Warning]: 'warning',
    [DiagnosticSeverity.Information]: 'info',
    [DiagnosticSeverity.Hint]: 'hint',
};

export function toTidyDiagnostic(diagnostic: Diagnostic, document?: Pick<TextDocument, 'offsetAt'>): TidyDiagnostic {
    const code = diagnostic.code;
    let normalizedCode: string | number | undefined;
    if (typeof code === 'string' || typeof code === 'number') {
        normalizedCode = code;
    } else if (code && typeof code === 'object' && 'value' in code) {
        normalizedCode = code.value;
    }

    const tidyDiagnostic: TidyDiagnostic = {
        source: diagnostic.source,
        code: normalizedCode,
        message: diagnostic.message,
        severity: SEVERITY_BY_VSCODE[diagnostic.severity],
    };
    if (document) {
        tidyDiagnostic.start = document.offsetAt(diagnostic.range.start);
        tidyDiagnostic.length = document.offsetAt(diagnostic.range.end) - tidyDiagnostic.start;
    }
    return tidyDiagnostic;
}

class DiagnosticsCache {
    private cache = new Map<string, { diagnostics: readonly Diagnostic[]; timestamp: number }>();
    private readonly TTL = 100;

    getDiagnostics(uri: Uri): readonly Diagnostic[] {
        const key = uri.toString();
        const cached = this.cache.get(key);

        if (cached && Date.now() - cached.timestamp < this.TTL) {
            return cached.diagnostics;
        }

        const diagnostics = perfMonitor.measureSync(
            'get_diagnostics_from_vscode',
            () => languages.getDiagnostics(uri),
            { uri: key }
        );

        this.cache.set(key, {
            diagnostics,
            timestamp: Date.now()
        });

        return diagnostics;
    }

    clear(): void {
        this.cache.clear();
    }
}

export const diagnosticsCache = new DiagnosticsCache();

export function getPublishedDiagnostics(document: TextDocument): TidyDiagnostic[] {
    return diagnosticsCache.getDiagnostics(document.uri).map((diagnostic) => toTidyDiagnostic(diagnostic, document));
}
