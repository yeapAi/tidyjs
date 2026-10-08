import * as path from 'path';

import { sortCodePatterns } from '../destructuring-sorter';
import { formatImports } from '../formatter';
import { ImportParser } from '../parser';
import { organizeReExports } from '../reexport-organizer';
import { validateFormattedOutput } from '../utils/format-validation';
import { hasIgnorePragma } from '../utils/ignore-pragma';
import { logDebug, logError } from '../utils/log';
import { PathResolver } from '../utils/path-resolver';
import { perfMonitor } from '../utils/performance';
import { serializeConfig } from './config';
import { analyzeImportDiagnostics, buildImportFilters, findImportBindingSpans, needsDiagnostics } from './diagnostics';

import type { ImportSource, InvalidImport, ParsedImport, ParserResult } from '../parser';
import type { Config } from '../types';
import type { ImportFilters, TidyDiagnostic } from './diagnostics';

export type FormatProfile = 'editor' | 'folder';

export type UnchangedReason = 'ignored' | 'empty' | 'no-imports' | 'unchanged';

export type FailureStage = 'parser-init' | 'invalid-imports' | 'format' | 'validation';

export interface DiagnosticsUsage {
    requested: boolean;
    count: number;
    error?: string;
    unusedImports: string[];
    missingModules: string[];
}

export type FormatOutcome =
    | { status: 'changed'; text: string; diagnostics: DiagnosticsUsage }
    | { status: 'unchanged'; reason: UnchangedReason; parseError?: string; diagnostics: DiagnosticsUsage }
    | { status: 'failed'; stage: FailureStage; message: string; invalidImports?: InvalidImport[]; diagnostics: DiagnosticsUsage };

export type DiagnosticsSupplier = (initialResult: ParserResult) => Promise<readonly TidyDiagnostic[]>;

export interface FormatRequest {
    text: string;
    filePath: string;
    config: Config;
    workspaceRoot: string | undefined;
    parsers: ParserCache;
    profile: FormatProfile;
    getDiagnostics?: DiagnosticsSupplier;
}

export class ParserCache {
    constructor(
        private readonly entries: Map<string, ImportParser> = new Map(),
        private readonly maxEntries = Number.POSITIVE_INFINITY
    ) {}

    get(config: Config): ImportParser {
        const key = serializeConfig(config);
        const cached = this.entries.get(key);
        if (cached) {
            return cached;
        }

        const parser = new ImportParser(config);
        while (this.entries.size >= this.maxEntries) {
            this.entries.delete(this.entries.keys().next().value as string);
        }
        this.entries.set(key, parser);
        return parser;
    }

    clear(): void {
        this.entries.clear();
    }
}

export function isFileInExcludedFolder(
    filePath: string,
    config: Config,
    workspaceRoot: string | undefined
): boolean {
    const excludedFolders = config.excludedFolders;
    if (!excludedFolders || excludedFolders.length === 0 || !workspaceRoot) {
        return false;
    }

    const relativePath = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');

    return excludedFolders.some((excluded) => {
        const normalizedExcluded = excluded.replace(/\\/g, '/');
        return relativePath.startsWith(normalizedExcluded + '/') || relativePath === normalizedExcluded;
    });
}

function hasImportPostProcessing(config: Config, profile: FormatProfile): boolean {
    const format = config.format;
    if (profile === 'editor') {
        return !!(format?.sortEnumMembers || format?.sortExports || format?.sortClassProperties);
    }
    return !!(format?.sortEnumMembers || format?.sortExports || format?.sortClassProperties || format?.sortTypeMembers);
}

function hasCodeSorting(config: Config): boolean {
    const format = config.format;
    return !!(format?.sortEnumMembers || format?.sortExports || format?.sortClassProperties || format?.sortTypeMembers);
}

function applyPostProcessing(text: string, config: Config, runCodeSorting: boolean): string {
    let result = text;
    if (runCodeSorting) {
        result = sortCodePatterns(result, config);
    }
    if (config.format?.organizeReExports) {
        result = organizeReExports(result, config);
    }
    return result;
}

export function applyPathResolution(
    originalResult: ParserResult,
    config: Config,
    filePath: string,
    workspaceRoot: string,
    parser: ImportParser
): ParserResult | null {
    const mode = config.pathResolution?.mode;
    if (!mode) {
        return null;
    }

    try {
        const pathResolver = new PathResolver({
            mode,
            preferredAliases: config.pathResolution?.preferredAliases || [],
            aliases: config.pathResolution?.aliases,
        });

        const allImports: ParsedImport[] = [];
        for (const group of originalResult.groups) {
            allImports.push(...group.imports);
        }

        const convertedImports: ParsedImport[] = [];
        let convertedCount = 0;

        for (const importInfo of allImports) {
            const resolvedPath = pathResolver.convertImportPathBatch(importInfo.source, filePath, workspaceRoot);

            if (resolvedPath && resolvedPath !== importInfo.source) {
                let groupName = importInfo.groupName;
                let isPriority = importInfo.isPriority;

                if (mode === 'absolute') {
                    const result = parser.determineGroup(resolvedPath);
                    groupName = result.groupName;
                    isPriority = result.isPriority;
                }

                convertedImports.push({
                    ...importInfo,
                    source: resolvedPath as ImportSource,
                    groupName,
                    isPriority
                });
                convertedCount++;
                logDebug(`Path resolved: ${importInfo.source} -> ${resolvedPath} (group: ${groupName})`);
            } else {
                convertedImports.push(importInfo);
            }
        }

        if (convertedCount === 0) {
            logDebug('Path resolution: no changes needed');
            return null;
        }

        logDebug(`Path resolution summary: ${convertedCount}/${allImports.length} imports converted`);

        return {
            ...originalResult,
            groups: parser.organizeImportsIntoGroups(convertedImports)
        };
    } catch (error) {
        logError('Error applying path resolution with regrouping:', error);
        return null;
    }
}

async function prepareImportFilters(
    request: FormatRequest,
    parser: ImportParser,
    usage: DiagnosticsUsage
): Promise<ImportFilters> {
    if (!needsDiagnostics(request.config) || !request.getDiagnostics) {
        logDebug('Skipping import analysis - both removeUnusedImports and removeMissingModules are false');
        return {};
    }

    try {
        const initialParserResult = parser.parse(request.text, undefined, undefined, request.filePath);
        if (initialParserResult.groups.length === 0) {
            logDebug('Skipping import analysis - no import to filter');
            return {};
        }

        usage.requested = true;
        const diagnostics = await request.getDiagnostics(initialParserResult);
        usage.count = diagnostics.length;

        const analysis = analyzeImportDiagnostics(initialParserResult, diagnostics, findImportBindingSpans(request.text, request.filePath));
        const filters = buildImportFilters(request.config, analysis);

        usage.unusedImports = filters.unusedImports ? [...filters.unusedImports] : [];
        usage.missingModules = filters.missingModules ? Array.from(filters.missingModules) : [];

        logDebug('Filtering parameters prepared:', {
            unusedImportsList: usage.unusedImports,
            missingModules: usage.missingModules,
        });

        return filters;
    } catch (error) {
        usage.error = error instanceof Error ? error.message : String(error);
        logError('Error preparing import filters:', usage.error);
        return {};
    }
}

function firstParseError(result: ParserResult): string | undefined {
    if (!result.importRange && result.groups.length === 0 && result.invalidImports?.length) {
        return result.invalidImports[0].error;
    }
    return undefined;
}

export async function formatSource(request: FormatRequest): Promise<FormatOutcome> {
    const { text, filePath, config, profile } = request;
    const diagnostics: DiagnosticsUsage = { requested: false, count: 0, unusedImports: [], missingModules: [] };

    if (profile === 'folder' && !text.trim()) {
        return { status: 'unchanged', reason: 'empty', diagnostics };
    }

    if (hasIgnorePragma(text)) {
        logDebug('Formatting skipped: tidyjs-ignore pragma found');
        return { status: 'unchanged', reason: 'ignored', diagnostics };
    }

    let parser: ImportParser;
    try {
        parser = request.parsers.get(config);
    } catch (error) {
        return { status: 'failed', stage: 'parser-init', message: error instanceof Error ? error.message : String(error), diagnostics };
    }

    const filters = await prepareImportFilters(request, parser, diagnostics);

    let parserResult = perfMonitor.measureSync(
        'parser_parse',
        () => parser.parse(text, filters.missingModules, filters.unusedImports, filePath),
        { documentLength: text.length }
    );

    if (profile === 'editor' && !parserResult.importRange && parserResult.groups.length === 0) {
        const parseError = firstParseError(parserResult);
        const hasPostProcessing = hasCodeSorting(config) || !!config.format?.organizeReExports;

        if (!hasPostProcessing) {
            logDebug('No imports to process in document');
            return { status: 'unchanged', reason: 'no-imports', parseError, diagnostics };
        }

        logDebug('No imports to process, but post-processing features are enabled');
        const finalText = applyPostProcessing(text, config, hasCodeSorting(config));

        if (finalText === text) {
            logDebug('Post-processing produced no changes');
            return { status: 'unchanged', reason: 'no-imports', parseError, diagnostics };
        }

        const validationError = validateFormattedOutput(parser, finalText, filePath);
        if (validationError) {
            return { status: 'failed', stage: 'validation', message: validationError, diagnostics };
        }

        return { status: 'changed', text: finalText, diagnostics };
    }

    if (config.pathResolution?.mode && request.workspaceRoot) {
        const resolved = applyPathResolution(parserResult, config, filePath, request.workspaceRoot, parser);
        if (resolved) {
            parserResult = resolved;
        }
    }

    if (parserResult.invalidImports && parserResult.invalidImports.length > 0) {
        return {
            status: 'failed',
            stage: 'invalid-imports',
            message: parserResult.invalidImports[0].error,
            invalidImports: parserResult.invalidImports,
            diagnostics,
        };
    }

    const hasImports = !!parserResult.importRange && parserResult.groups.length > 0;
    let finalText = text;

    if (profile === 'editor' || hasImports) {
        const formattedDocument = await perfMonitor.measureAsync('format_imports', () => formatImports(text, config, parserResult));
        if (formattedDocument.error) {
            return { status: 'failed', stage: 'format', message: formattedDocument.error, diagnostics };
        }
        finalText = formattedDocument.text;
    }

    finalText = applyPostProcessing(finalText, config, hasImportPostProcessing(config, profile));

    if (finalText === text) {
        return { status: 'unchanged', reason: hasImports ? 'unchanged' : 'no-imports', diagnostics };
    }

    const validationError = validateFormattedOutput(parser, finalText, filePath);
    if (validationError) {
        return { status: 'failed', stage: 'validation', message: validationError, diagnostics };
    }

    return { status: 'changed', text: finalText, diagnostics };
}
