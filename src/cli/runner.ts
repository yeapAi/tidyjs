import * as fs from 'fs';

import { resolveConfigForFile, validateConfiguration } from '../core/config';
import { formatSource, isFileInExcludedFolder, ParserCache } from '../core/pipeline';
import { needsDiagnostics } from '../core/diagnostics';

import type { ParserResult } from '../parser';
import type { Config } from '../types';
import type { FormatProfile } from '../core/pipeline';
import type { CliDiagnostics, SourceReport } from './diagnostics';
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
}

export interface RunnerOptions {
    mode: RunMode;
    profile: FormatProfile;
    keepContents: boolean;
}

const BOM = '﻿';

export class FileRunner {
    private readonly parsers = new ParserCache();

    constructor(
        private readonly workspace: CliWorkspace,
        private readonly diagnostics: CliDiagnostics | undefined,
        private readonly options: RunnerOptions
    ) {}

    dispose(): void {
        this.parsers.clear();
    }

    async needsUnusedImportDiagnostics(filePath: string): Promise<boolean> {
        if (this.options.profile !== 'editor' || !this.diagnostics) {
            return false;
        }
        try {
            const workspaceRoot = this.workspace.rootFor(filePath);
            const config = await resolveConfigForFile(filePath, this.workspace.resolutionContext(filePath));
            return config.format?.removeUnusedImports === true
                && validateConfiguration(config).isValid
                && !isFileInExcludedFolder(filePath, config, workspaceRoot);
        } catch {
            return false;
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

        let config: Config;
        try {
            report.configPath = (await this.workspace.fileSources.getSource(filePath, workspaceRoot))?.path;
            config = await resolveConfigForFile(filePath, this.workspace.resolutionContext(filePath));
        } catch (error) {
            return this.fail(report, 'config', `Invalid configuration: ${error instanceof Error ? error.message : String(error)}`);
        }

        const validation = validateConfiguration(config);
        if (!validation.isValid) {
            return this.fail(report, 'config', `Invalid configuration${report.configPath ? ` (${report.configPath})` : ''}: ${validation.errors.join(' ')}`);
        }

        if (isFileInExcludedFolder(filePath, config, workspaceRoot)) {
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
        const text = hasBom ? raw.slice(1) : raw;

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
            report.status = outcome.reason === 'ignored' || outcome.reason === 'empty' ? 'skipped' : 'unchanged';
            report.reason = outcome.reason;
            return report;
        }

        report.status = 'changed';
        if (this.options.keepContents) {
            report.original = text;
            report.formatted = outcome.text;
        }

        if (this.options.mode === 'write') {
            try {
                await fs.promises.writeFile(filePath, hasBom ? BOM + outcome.text : outcome.text, 'utf8');
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
