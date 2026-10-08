import * as fs from 'fs';
import * as path from 'path';

import { resolveConfigForFile, validateConfiguration } from '../core/config';
import { formatSource, isFileInExcludedFolder, ParserCache } from '../core/pipeline';
import { needsDiagnostics } from '../core/diagnostics';

import type { ParserResult } from '../parser';
import type { Config } from '../types';
import type { FormatProfile } from '../core/pipeline';
import type { CliDiagnostics, SourceReport } from './diagnostics';
import type { EslintLinter } from './eslint-host';
import type { CliWorkspace } from './workspace';

export type RunMode = 'list' | 'check' | 'write';

export type FileStatus = 'changed' | 'unchanged' | 'skipped' | 'error';

export interface FileReport {
    filePath: string;
    status: FileStatus;
    written: boolean;
    reason?: string;
    errorStage?: string;
    message?: string;
    warnings: string[];
    original?: string;
    formatted?: string;
    configPath?: string;
    removedUnused: string[];
    removedMissing: string[];
    sources: SourceReport[];
    eslintFixes?: 'applied' | 'none';
}

export interface RunnerOptions {
    mode: RunMode;
    profile: FormatProfile;
    keepContents: boolean;
}

const BOM = '﻿';

type DirectoryConfig = { configPath: string | undefined } & ({ config: Config } | { error: unknown });

export class FileRunner {
    private readonly parsers = new ParserCache();
    private readonly directoryConfigs = new Map<string, Promise<DirectoryConfig>>();

    constructor(
        private readonly workspace: CliWorkspace,
        private readonly diagnostics: CliDiagnostics | undefined,
        private readonly options: RunnerOptions,
        private readonly eslint?: EslintLinter
    ) {}

    dispose(): void {
        this.parsers.clear();
    }

    async needsUnusedImportDiagnostics(filePath: string): Promise<boolean> {
        if (this.options.profile !== 'editor' || !this.diagnostics) {
            return false;
        }
        const resolved = await this.configFor(filePath);
        if ('error' in resolved) {
            return false;
        }
        return resolved.config.format?.removeUnusedImports === true
            && validateConfiguration(resolved.config).isValid
            && !isFileInExcludedFolder(filePath, resolved.config, this.workspace.rootFor(filePath));
    }

    private configFor(filePath: string): Promise<DirectoryConfig> {
        const directory = path.dirname(filePath);
        let resolved = this.directoryConfigs.get(directory);
        if (!resolved) {
            resolved = this.resolveDirectoryConfig(filePath);
            this.directoryConfigs.set(directory, resolved);
        }
        return resolved;
    }

    private async resolveDirectoryConfig(filePath: string): Promise<DirectoryConfig> {
        let configPath: string | undefined;
        try {
            configPath = (await this.workspace.fileSources.getSource(filePath, this.workspace.rootFor(filePath)))?.path;
            return { configPath, config: await resolveConfigForFile(filePath, this.workspace.resolutionContext(filePath)) };
        } catch (error) {
            return { configPath, error };
        }
    }

    async run(filePath: string): Promise<FileReport> {
        const report: FileReport = {
            filePath,
            status: 'unchanged',
            written: false,
            warnings: [],
            removedUnused: [],
            removedMissing: [],
            sources: [],
        };
        const workspaceRoot = this.workspace.rootFor(filePath);

        const resolved = await this.configFor(filePath);
        report.configPath = resolved.configPath;
        if ('error' in resolved) {
            return this.fail(report, 'config', `Invalid configuration: ${resolved.error instanceof Error ? resolved.error.message : String(resolved.error)}`);
        }
        const config = resolved.config;

        const validation = validateConfiguration(config);
        if (!validation.isValid) {
            return this.fail(report, 'config', `Invalid configuration${report.configPath ? ` (${report.configPath})` : ''}: ${validation.errors.join(' ')}`);
        }

        const excluded = isFileInExcludedFolder(filePath, config, workspaceRoot);
        const eslintFixesOnSave = this.options.profile === 'editor' && this.eslint !== undefined && this.workspace.eslintFixAllOnSave(filePath);
        if (excluded && !eslintFixesOnSave) {
            report.status = 'skipped';
            report.reason = 'excluded';
            return report;
        }

        let raw: string;
        try {
            raw = await fs.promises.readFile(filePath, 'utf8');
        } catch (error) {
            return this.fail(report, 'read', `Failed to read file: ${error instanceof Error ? error.message : String(error)}`);
        }

        const hasBom = raw.startsWith(BOM);
        const original = hasBom ? raw.slice(1) : raw;
        const text = eslintFixesOnSave ? await this.applyEslintFixes(filePath, original, workspaceRoot, report) : original;

        if (excluded) {
            if (text === original) {
                report.status = 'skipped';
                report.reason = 'excluded';
                return report;
            }
            return this.complete(report, filePath, original, text, hasBom);
        }

        const collectDiagnostics = this.options.profile === 'editor' && this.diagnostics && needsDiagnostics(config)
            ? async (initialResult: ParserResult) => {
                const collected = await this.diagnostics!.collect({
                    filePath,
                    text,
                    workspaceRoot,
                    initialResult,
                    removeUnusedImports: config.format?.removeUnusedImports === true,
                });
                report.sources = collected.reports;
                if (!collected.reports.some((source) => source.status === 'used')) {
                    throw new Error('no diagnostics source could analyse the file');
                }
                return collected.diagnostics;
            }
            : undefined;

        const outcome = await formatSource({
            text,
            filePath,
            config,
            workspaceRoot,
            parsers: this.parsers,
            profile: this.options.profile,
            getDiagnostics: collectDiagnostics,
        });

        report.removedUnused = outcome.diagnostics.unusedImports;
        report.removedMissing = outcome.diagnostics.missingModules;
        for (const source of report.sources) {
            if (source.status === 'failed') {
                report.warnings.push(`${source.source} diagnostics failed: ${source.detail ?? 'unknown error'}`);
            }
        }
        if (outcome.diagnostics.error) {
            report.warnings.push(`unused and missing imports were not removed: ${outcome.diagnostics.error}`);
        }

        if (outcome.status === 'failed') {
            return this.fail(report, outcome.stage, outcome.message);
        }

        if (outcome.status === 'unchanged') {
            if (outcome.parseError) {
                return this.fail(report, 'parse', outcome.parseError);
            }
            if (text !== original) {
                return this.complete(report, filePath, original, text, hasBom);
            }
            report.status = outcome.reason === 'ignored' || outcome.reason === 'empty' ? 'skipped' : 'unchanged';
            report.reason = outcome.reason;
            return report;
        }

        return this.complete(report, filePath, original, outcome.text, hasBom);
    }

    private async applyEslintFixes(filePath: string, text: string, workspaceRoot: string | undefined, report: FileReport): Promise<string> {
        try {
            const { output } = await this.eslint!.fixAll(filePath, text, workspaceRoot);
            report.eslintFixes = output !== undefined && output !== text ? 'applied' : 'none';
            return output ?? text;
        } catch (error) {
            report.warnings.push(`ESLint fixes were not applied: ${error instanceof Error ? error.message : String(error)}`);
            return text;
        }
    }

    private async complete(report: FileReport, filePath: string, original: string, formatted: string, hasBom: boolean): Promise<FileReport> {
        report.status = 'changed';
        if (this.options.keepContents) {
            report.original = original;
            report.formatted = formatted;
        }

        if (this.options.mode === 'write') {
            try {
                await fs.promises.writeFile(filePath, hasBom ? BOM + formatted : formatted, 'utf8');
                report.written = true;
            } catch (error) {
                return this.fail(report, 'write', `Failed to write file: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        return report;
    }

    private fail(report: FileReport, stage: string, message: string): FileReport {
        report.status = 'error';
        report.errorStage = stage;
        report.message = message;
        return report;
    }
}
