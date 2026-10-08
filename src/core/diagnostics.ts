import { ImportType } from '../parser';
import { logDebug, logError } from '../utils/log';
import { parseSource } from '../utils/oxc-parse';

import type { ParserResult } from '../parser';
import type * as AST from '../types/ast';
import type { Config } from '../types';

export type TidyDiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

export interface TidyDiagnostic {
    source?: string;
    code?: string | number;
    message: string;
    severity: TidyDiagnosticSeverity;
    start?: number;
    length?: number;
}

export interface ImportDiagnosticsAnalysis {
    unusedImports: string[];
    missingModules: Set<string>;
    unusedFromMissing: Set<string>;
}

export interface ImportBindingSpan {
    start: number;
    end: number;
    names: Set<string>;
}

export function findImportBindingSpans(text: string, fileName?: string): ImportBindingSpan[] {
    let program;
    try {
        program = parseSource(text, { fileName });
    } catch {
        return [];
    }

    const spans: ImportBindingSpan[] = [];
    for (const statement of program.body) {
        if (statement.type !== 'ImportDeclaration' || !statement.range) {
            continue;
        }
        const declaration = statement as AST.ImportDeclaration;
        const names = new Set<string>();
        for (const specifier of declaration.specifiers) {
            names.add((specifier as AST.ImportSpecifier).local.name);
        }
        spans.push({ start: statement.range[0], end: statement.range[1], names });
    }
    return spans;
}

function pointsToImportOf(diagnostic: TidyDiagnostic, name: string, spans: readonly ImportBindingSpan[]): boolean {
    const start = diagnostic.start;
    if (start === undefined) {
        return false;
    }
    return spans.some((span) => start >= span.start && start < span.end && span.names.has(name));
}

export interface ImportFilters {
    missingModules?: Set<string>;
    unusedImports?: string[];
}

export const UNUSED_IMPORT_CODES = ['unused-import', 'import-not-used', '6192', '6133', '6196', '@typescript-eslint/no-unused-vars'];
export const MODULE_NOT_FOUND_CODES = ['2307', '2318'];

const UNUSED_SEVERITIES: readonly TidyDiagnosticSeverity[] = ['error', 'warning', 'hint'];

export function diagnosticCodeToString(code: TidyDiagnostic['code']): string {
    return String(code);
}

export function needsDiagnostics(config: Config): boolean {
    return config.format?.removeUnusedImports === true || config.format?.removeMissingModules === true;
}

function emptyAnalysis(): ImportDiagnosticsAnalysis {
    return {
        unusedImports: [],
        missingModules: new Set(),
        unusedFromMissing: new Set(),
    };
}

export function analyzeImportDiagnostics(
    parserResult: ParserResult,
    diagnostics: readonly TidyDiagnostic[],
    importSpans?: readonly ImportBindingSpan[]
): ImportDiagnosticsAnalysis {
    try {
        const missingModules = new Set<string>();
        const unusedVariables = new Set<string>();

        logDebug(`analyzeImports: Processing ${diagnostics.length} diagnostics`);

        if (diagnostics.length === 0) {
            logDebug('No diagnostics available for import analysis');
            return emptyAnalysis();
        }

        for (const diagnostic of diagnostics) {
            const code = diagnosticCodeToString(diagnostic.code);
            logDebug(`Diagnostic: severity=${diagnostic.severity}, code=${code}, message="${diagnostic.message}"`);

            if (diagnostic.severity === 'error' && MODULE_NOT_FOUND_CODES.includes(code)) {
                const moduleMatch = diagnostic.message.match(/Cannot find module ['"]([^'"]+)['"]/);

                if (moduleMatch && moduleMatch[1]) {
                    missingModules.add(moduleMatch[1]);
                    logDebug(`Found missing module: ${moduleMatch[1]}`);
                }
            }

            if (UNUSED_SEVERITIES.includes(diagnostic.severity) && UNUSED_IMPORT_CODES.includes(code)) {
                const match = diagnostic.message.match(/'([^']+)' is (?:declared|defined) but (?:its value is )?never (?:read|used)\.?/);
                if (match && match[1] && (!importSpans || pointsToImportOf(diagnostic, match[1], importSpans))) {
                    unusedVariables.add(match[1]);
                    logDebug(`Unused variable detected: ${match[1]}`);
                }
            }
        }

        const allImportedNames: string[] = [];
        for (const group of parserResult.groups) {
            for (const imp of group.imports) {
                if (imp.defaultImport && imp.type === ImportType.DEFAULT) {
                    allImportedNames.push(imp.defaultImport);
                } else {
                    for (const spec of imp.specifiers) {
                        const specName = typeof spec === 'string' ? spec : spec.local;
                        allImportedNames.push(specName);
                    }
                }
            }
        }

        const unusedImports = Array.from(unusedVariables).filter((name) => allImportedNames.includes(name));

        const unusedFromMissing = new Set<string>();

        logDebug('Missing modules detected:', Array.from(missingModules));
        logDebug('Unused imports detected:', unusedImports);

        for (const group of parserResult.groups) {
            for (const imp of group.imports) {
                if (missingModules.has(imp.source)) {
                    logDebug(`Import from missing module ${imp.source}:`, imp.specifiers);

                    for (const specifier of imp.specifiers) {
                        const specName = typeof specifier === 'string' ? specifier : specifier.local;
                        if (unusedVariables.has(specName)) {
                            unusedFromMissing.add(specName);
                            logDebug(`  - ${specName} is unused and from missing module`);
                        }
                    }

                    if (imp.defaultImport && unusedVariables.has(imp.defaultImport)) {
                        unusedFromMissing.add(imp.defaultImport);
                        logDebug(`  - Default import ${imp.defaultImport} is unused and from missing module`);
                    }
                }
            }
        }

        logDebug('Final analysis results:', {
            unusedImports,
            missingModules: Array.from(missingModules),
            unusedFromMissing: Array.from(unusedFromMissing),
        });

        return {
            unusedImports,
            missingModules,
            unusedFromMissing,
        };
    } catch (error) {
        logError('Error analyzing imports:', error);
        return emptyAnalysis();
    }
}

export function buildImportFilters(config: Config, analysis: ImportDiagnosticsAnalysis): ImportFilters {
    const filters: ImportFilters = {};

    if (config.format?.removeUnusedImports === true) {
        filters.unusedImports = analysis.unusedImports;
    }

    if (config.format?.removeMissingModules === true) {
        filters.missingModules = analysis.missingModules;

        if (config.format?.removeUnusedImports !== true) {
            filters.unusedImports = Array.from(analysis.unusedFromMissing);
        }
    }

    return filters;
}
