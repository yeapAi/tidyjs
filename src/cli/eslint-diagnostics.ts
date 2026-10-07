import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';

import { UNUSED_IMPORT_CODES } from '../core/diagnostics';
import { DiagnosticsUnavailableError } from './diagnostic-errors';

import type { SettingsReader } from '../core/config';
import type { TidyDiagnostic, TidyDiagnosticSeverity } from '../core/diagnostics';

const DEFAULT_PROBE = ['astro', 'civet', 'javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'html', 'mdx', 'vue', 'markdown', 'json', 'jsonc'];

const WORKING_DIRECTORY_MARKERS: { fileName: string; isRoot: boolean; isFlatConfig: boolean }[] = [
    { fileName: 'eslint.config.js', isRoot: true, isFlatConfig: true },
    { fileName: 'eslint.config.cjs', isRoot: true, isFlatConfig: true },
    { fileName: 'eslint.config.mjs', isRoot: true, isFlatConfig: true },
    { fileName: 'eslint.config.ts', isRoot: true, isFlatConfig: true },
    { fileName: 'eslint.config.cts', isRoot: true, isFlatConfig: true },
    { fileName: 'eslint.config.mts', isRoot: true, isFlatConfig: true },
    { fileName: 'package.json', isRoot: true, isFlatConfig: false },
    { fileName: '.eslintignore', isRoot: true, isFlatConfig: false },
    { fileName: '.eslintrc', isRoot: false, isFlatConfig: false },
    { fileName: '.eslintrc.json', isRoot: false, isFlatConfig: false },
    { fileName: '.eslintrc.js', isRoot: false, isFlatConfig: false },
    { fileName: '.eslintrc.yaml', isRoot: false, isFlatConfig: false },
    { fileName: '.eslintrc.yml', isRoot: false, isFlatConfig: false },
];

const MISSING_CONFIG_TEMPLATES = new Set(['config-file-missing', 'no-config-found']);

type RuleSeverityOverride = 'off' | 'info' | 'warn' | 'error' | 'downgrade' | 'upgrade' | 'default';

interface RuleCustomization {
    rule: string;
    severity: RuleSeverityOverride;
    fixable?: boolean;
}

interface ModeItem { mode: 'location' | 'auto' }
interface DirectoryItem { directory: string; '!cwd'?: boolean }

export interface EslintEditorSettings {
    enable: boolean;
    validate?: string[];
    probe: string[];
    workingDirectories?: unknown[];
    options: Record<string, unknown>;
    useFlatConfig?: boolean;
    experimentalUseFlatConfig: boolean;
    quiet: boolean;
    nodePath?: string;
    customizations: RuleCustomization[];
    codeActionsOnSave: EslintSaveSettings;
}

export interface EslintSaveSettings {
    mode: string;
    rules?: string[];
    options?: Record<string, unknown>;
}

export interface WorkingDirectory {
    directory: string;
    changeProcessCwd: boolean;
}

export type EslintFileStatus = 'linted' | 'ignored' | 'disabled' | 'not-validated' | 'not-installed' | 'not-configured';

export interface EslintLintResult {
    status: EslintFileStatus;
    diagnostics: TidyDiagnostic[];
    workingDirectory?: string;
    eslintPath?: string;
}

export interface EslintFixResult {
    status: EslintFileStatus;
    output?: string;
    workingDirectory?: string;
}

interface EslintMessage {
    ruleId: string | null;
    severity: number;
    message: string;
    line?: number;
    column?: number;
    fix?: unknown;
}

function offsetOf(lineStarts: number[], line: number | undefined, column: number | undefined): number | undefined {
    if (line === undefined || column === undefined || line < 1 || line > lineStarts.length) {
        return undefined;
    }
    return lineStarts[line - 1] + Math.max(0, column - 1);
}

function computeLineStarts(text: string): number[] {
    const starts = [0];
    for (let index = 0; index < text.length; index++) {
        if (text.charCodeAt(index) === 10) {
            starts.push(index + 1);
        }
    }
    return starts;
}

interface EslintInstance {
    lintText(code: string, options: { filePath: string; warnIgnored?: boolean }): Promise<{ messages: EslintMessage[]; output?: string }[]>;
    calculateConfigForFile?(filePath: string): Promise<unknown>;
}

type EslintConstructor = new (options: Record<string, unknown>) => EslintInstance;

interface EslintModule {
    loadESLint?: (options: { useFlatConfig?: boolean; cwd?: string }) => Promise<EslintConstructor>;
    ESLint?: EslintConstructor;
}

export function languageIdFor(filePath: string): string {
    const extension = path.extname(filePath).toLowerCase();
    switch (extension) {
        case '.ts':
        case '.mts':
        case '.cts':
            return 'typescript';
        case '.tsx':
            return 'typescriptreact';
        case '.jsx':
            return 'javascriptreact';
        default:
            return 'javascript';
    }
}

function asBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function isRuleOffOnSave(ruleId: string, patterns: string[]): boolean {
    for (const pattern of patterns) {
        if (pattern.startsWith('!') && new RegExp(`^${pattern.slice(1).replace(/\*/g, '.*')}$`).test(ruleId)) {
            return true;
        }
        if (new RegExp(`^${pattern.replace(/\*/g, '.*')}$`).test(ruleId)) {
            return false;
        }
    }
    return true;
}

export function readEslintEditorSettings(reader: SettingsReader): EslintEditorSettings {
    const validateSetting = reader.get<unknown>('validate');
    const validate = Array.isArray(validateSetting)
        ? validateSetting
            .map((entry) => (typeof entry === 'string' ? entry : (entry as { language?: unknown })?.language))
            .filter((entry): entry is string => typeof entry === 'string')
        : undefined;

    const probeSetting = reader.get<unknown>('probe');
    const probe = Array.isArray(probeSetting) ? probeSetting.filter((entry): entry is string => typeof entry === 'string') : DEFAULT_PROBE;

    const workingDirectories = reader.get<unknown>('workingDirectories');
    const options = reader.get<unknown>('options');
    const nodePath = reader.get<unknown>('nodePath');
    const customizationsSetting = reader.get<unknown>('rules.customizations');
    const customizations: RuleCustomization[] = Array.isArray(customizationsSetting)
        ? customizationsSetting.flatMap((entry) => {
            const candidate = entry as { rule?: unknown; severity?: unknown; fixable?: unknown };
            if (typeof candidate?.rule !== 'string' || typeof candidate.severity !== 'string') {
                return [];
            }
            return [{
                rule: candidate.rule,
                severity: candidate.severity as RuleSeverityOverride,
                fixable: asBoolean(candidate.fixable),
            }];
        })
        : [];
    const saveMode = reader.get<unknown>('codeActionsOnSave.mode');
    const saveRules = reader.get<unknown>('codeActionsOnSave.rules');

    return {
        enable: asBoolean(reader.get('enable')) ?? true,
        validate,
        probe,
        workingDirectories: Array.isArray(workingDirectories) ? workingDirectories : undefined,
        options: asObject(options) ?? {},
        useFlatConfig: asBoolean(reader.get('useFlatConfig')),
        experimentalUseFlatConfig: asBoolean(reader.get('experimental.useFlatConfig')) === true,
        quiet: asBoolean(reader.get('quiet')) ?? false,
        nodePath: typeof nodePath === 'string' ? nodePath : undefined,
        customizations,
        codeActionsOnSave: {
            mode: typeof saveMode === 'string' ? saveMode : 'all',
            rules: Array.isArray(saveRules) ? saveRules.filter((rule): rule is string => typeof rule === 'string') : undefined,
            options: asObject(reader.get<unknown>('codeActionsOnSave.options')),
        },
    };
}

function withTrailingSeparator(directory: string, separator: string): string {
    return directory.endsWith(separator) ? directory : directory + separator;
}

function withoutTrailingSeparator(directory: string): string {
    return directory.length > 1 && directory.endsWith(path.sep) ? directory.slice(0, -1) : directory;
}

function globToPrefixRegExp(pattern: string): RegExp {
    let source = '';
    for (let index = 0; index < pattern.length; index++) {
        const char = pattern[index];
        if (char === '*') {
            if (pattern[index + 1] === '*') {
                source += '.*';
                index++;
            } else {
                source += '[^/]*';
            }
        } else if (char === '?') {
            source += '[^/]';
        } else {
            source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp(`^${source}`);
}

function isModeItem(value: unknown): value is ModeItem {
    const mode = (value as ModeItem | undefined)?.mode;
    return mode === 'location' || mode === 'auto';
}

function selectConfiguredWorkingDirectory(filePath: string, workspaceRoot: string | undefined, entries: unknown[]): ModeItem | DirectoryItem | undefined {
    let selected: ModeItem | DirectoryItem | undefined;

    for (const entry of entries) {
        let directory: string | undefined;
        let pattern: string | undefined;
        let noCwd = false;
        let matched: string | undefined;

        if (typeof entry === 'string') {
            directory = entry;
        } else if (entry && typeof entry === 'object') {
            const item = entry as { directory?: unknown; changeProcessCWD?: unknown; '!cwd'?: unknown; pattern?: unknown };
            if (typeof item.directory === 'string' && typeof item.changeProcessCWD === 'boolean') {
                directory = item.directory;
                noCwd = !item.changeProcessCWD;
            } else if (typeof item.directory === 'string') {
                directory = item.directory;
                if (typeof item['!cwd'] === 'boolean') {
                    noCwd = item['!cwd'];
                }
            } else if (typeof item.pattern === 'string') {
                pattern = item.pattern;
                if (typeof item['!cwd'] === 'boolean') {
                    noCwd = item['!cwd'];
                }
            } else if (isModeItem(entry)) {
                selected = entry;
                continue;
            }
        }

        if (directory !== undefined) {
            let candidate = directory.split(/[\\/]/).join(path.sep);
            if (!path.isAbsolute(candidate) && workspaceRoot !== undefined) {
                candidate = path.join(workspaceRoot, candidate);
            }
            candidate = withTrailingSeparator(candidate, path.sep);
            if (filePath.startsWith(candidate)) {
                matched = candidate;
            }
        } else if (pattern !== undefined && pattern.length > 0) {
            let candidate = pattern;
            if (!path.posix.isAbsolute(candidate) && workspaceRoot !== undefined) {
                candidate = path.posix.join(workspaceRoot.split(path.sep).join('/'), candidate);
            }
            candidate = withTrailingSeparator(candidate, '/');
            const match = globToPrefixRegExp(candidate).exec(filePath.split(path.sep).join('/'));
            if (match && match.length > 0) {
                matched = match[0].split('/').join(path.sep);
            }
        }

        if (matched !== undefined) {
            if (selected === undefined || isModeItem(selected)) {
                selected = { directory: matched, '!cwd': noCwd };
            } else if (selected.directory.length < matched.length) {
                selected = { directory: matched, '!cwd': noCwd };
            }
        }
    }

    return selected;
}

function findMarkerDirectory(workspaceRoot: string, filePath: string): [string, boolean] {
    if (filePath.includes(`${path.sep}node_modules${path.sep}`)) {
        return [workspaceRoot, false];
    }

    let found = workspaceRoot;
    let isFlatConfig = false;
    let directory: string | undefined = path.dirname(filePath);

    outer: while (directory !== undefined && directory.startsWith(workspaceRoot)) {
        for (const marker of WORKING_DIRECTORY_MARKERS) {
            if (fs.existsSync(path.join(directory, marker.fileName))) {
                found = directory;
                isFlatConfig = marker.isFlatConfig;
                if (marker.isRoot) {
                    break outer;
                }
                break;
            }
        }
        const parent = path.dirname(directory);
        directory = parent !== directory ? parent : undefined;
    }

    return [found, isFlatConfig];
}

export function resolveEslintWorkingDirectory(
    filePath: string,
    workspaceRoot: string | undefined,
    settings: EslintEditorSettings
): { workingDirectory?: WorkingDirectory; configured: boolean } {
    const configured = settings.workingDirectories !== undefined
        ? selectConfiguredWorkingDirectory(filePath, workspaceRoot, settings.workingDirectories)
        : undefined;
    const item: ModeItem | DirectoryItem = configured ?? { mode: 'location' };

    if (!isModeItem(item)) {
        return {
            workingDirectory: { directory: withoutTrailingSeparator(item.directory), changeProcessCwd: item['!cwd'] !== true },
            configured: configured !== undefined,
        };
    }

    let directory: string | undefined;
    if (item.mode === 'location') {
        if (workspaceRoot !== undefined) {
            const [markerDirectory, isFlatConfig] = findMarkerDirectory(workspaceRoot, filePath);
            directory = isFlatConfig && settings.useFlatConfig !== false ? markerDirectory : workspaceRoot;
        } else {
            directory = path.dirname(filePath);
        }
    } else {
        directory = workspaceRoot !== undefined ? findMarkerDirectory(workspaceRoot, filePath)[0] : path.dirname(filePath);
    }

    if (directory === undefined || !fs.existsSync(directory)) {
        return { configured: configured !== undefined };
    }

    return {
        workingDirectory: { directory: withoutTrailingSeparator(directory), changeProcessCwd: true },
        configured: configured !== undefined,
    };
}

function matchesRulePattern(pattern: string, ruleId: string): boolean {
    const negated = pattern.startsWith('!');
    const source = (negated ? pattern.slice(1) : pattern).replace(/\*/g, '.*');
    const matches = new RegExp(`^${source}$`).test(ruleId);
    return negated ? !matches : matches;
}

function customizedSeverity(message: EslintMessage, customizations: RuleCustomization[]): TidyDiagnosticSeverity | null {
    let override: RuleSeverityOverride | undefined;
    if (message.ruleId) {
        for (const customization of customizations) {
            if (matchesRulePattern(customization.rule, message.ruleId)
                && (customization.fixable === undefined || customization.fixable === (message.fix !== undefined))) {
                override = customization.severity;
            }
        }
    }

    const base: TidyDiagnosticSeverity = message.severity === 1 ? 'warning' : 'error';
    switch (override) {
        case 'off':
            return null;
        case 'info':
            return 'info';
        case 'warn':
            return 'warning';
        case 'error':
            return 'error';
        case 'downgrade':
            return base === 'error' ? 'warning' : 'info';
        case 'upgrade':
            return 'error';
        default:
            return base;
    }
}

function isMissingConfigError(error: unknown): boolean {
    const template = (error as { messageTemplate?: unknown })?.messageTemplate;
    if (typeof template === 'string' && MISSING_CONFIG_TEMPLATES.has(template)) {
        return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    return /Could not find config file|No ESLint configuration found/.test(message);
}

async function withWorkingDirectory<T>(workingDirectory: WorkingDirectory | undefined, action: () => Promise<T>): Promise<T> {
    const previous = process.cwd();
    try {
        if (workingDirectory?.changeProcessCwd && fs.existsSync(workingDirectory.directory)) {
            process.chdir(workingDirectory.directory);
        }
        return await action();
    } finally {
        if (process.cwd() !== previous) {
            process.chdir(previous);
        }
    }
}

export class EslintDiagnosticsProvider {
    private readonly instances = new Map<string, Promise<EslintInstance>>();
    private readonly relevantRules = new Set(UNUSED_IMPORT_CODES);

    constructor(private readonly settings: EslintEditorSettings) {}

    private shouldValidate(filePath: string): EslintFileStatus | undefined {
        if (!this.settings.enable) {
            return 'disabled';
        }
        const languageId = languageIdFor(filePath);
        if (this.settings.validate !== undefined) {
            return this.settings.validate.includes(languageId) ? undefined : 'not-validated';
        }
        return this.settings.probe.includes(languageId) ? undefined : 'not-validated';
    }

    private resolveLibrary(resolveFrom: string, workspaceRoot: string | undefined): string | undefined {
        const request = this.settings.experimentalUseFlatConfig ? 'eslint/use-at-your-own-risk' : 'eslint';
        const searchDirectories: string[] = [];
        if (this.settings.nodePath) {
            const nodePath = path.isAbsolute(this.settings.nodePath) || workspaceRoot === undefined
                ? this.settings.nodePath
                : path.join(workspaceRoot, this.settings.nodePath);
            searchDirectories.push(nodePath);
        }
        searchDirectories.push(resolveFrom);

        for (const directory of searchDirectories) {
            try {
                return createRequire(path.join(directory, '__tidyjs_resolve__.js')).resolve(request);
            } catch {
                continue;
            }
        }
        return undefined;
    }

    private async createInstance(libraryPath: string, workingDirectory: WorkingDirectory | undefined, fixOptions?: Record<string, unknown>): Promise<EslintInstance> {
        const library = createRequire(libraryPath)(libraryPath) as EslintModule;
        const EslintClass = typeof library.loadESLint === 'function'
            ? await library.loadESLint({ useFlatConfig: this.settings.useFlatConfig })
            : library.ESLint;
        if (!EslintClass) {
            throw new DiagnosticsUnavailableError('eslint', `${libraryPath} does not expose the ESLint class API`);
        }

        const options: Record<string, unknown> = { ...this.settings.options, ...fixOptions };
        if (workingDirectory) {
            options.cwd = workingDirectory.directory;
        }
        if (fixOptions) {
            return new EslintClass(options);
        }

        try {
            return new EslintClass({ ...options, ruleFilter: ({ ruleId }: { ruleId: string }) => this.relevantRules.has(ruleId) });
        } catch (error) {
            if (error instanceof Error && /ruleFilter/.test(error.message)) {
                return new EslintClass(options);
            }
            throw error;
        }
    }

    async warm(filePath: string, workspaceRoot: string | undefined): Promise<void> {
        if (this.shouldValidate(filePath)) {
            return;
        }
        const { workingDirectory, configured } = resolveEslintWorkingDirectory(filePath, workspaceRoot, this.settings);
        const resolveFrom = !configured || !workingDirectory || !workingDirectory.changeProcessCwd
            ? path.dirname(filePath)
            : workingDirectory.directory;
        const libraryPath = this.resolveLibrary(resolveFrom, workspaceRoot);
        if (!libraryPath) {
            return;
        }
        await withWorkingDirectory(workingDirectory, async () => {
            try {
                const instance = await this.instanceFor(libraryPath, workingDirectory);
                await instance.calculateConfigForFile?.(filePath);
            } catch {
                return;
            }
        });
    }

    private instanceFor(libraryPath: string, workingDirectory: WorkingDirectory | undefined, fixOptions?: Record<string, unknown>): Promise<EslintInstance> {
        const cacheKey = `${libraryPath}\0${workingDirectory?.directory ?? ''}\0${workingDirectory?.changeProcessCwd ?? false}\0${fixOptions ? JSON.stringify(fixOptions) : ''}`;
        let instancePromise = this.instances.get(cacheKey);
        if (!instancePromise) {
            instancePromise = this.createInstance(libraryPath, workingDirectory, fixOptions);
            this.instances.set(cacheKey, instancePromise);
        }
        return instancePromise;
    }

    private locate(filePath: string, workspaceRoot: string | undefined): { workingDirectory: WorkingDirectory | undefined; libraryPath: string | undefined } {
        const { workingDirectory, configured } = resolveEslintWorkingDirectory(filePath, workspaceRoot, this.settings);
        const resolveFrom = !configured || !workingDirectory || !workingDirectory.changeProcessCwd
            ? path.dirname(filePath)
            : workingDirectory.directory;
        return { workingDirectory, libraryPath: this.resolveLibrary(resolveFrom, workspaceRoot) };
    }

    private async rulesOffOnSave(libraryPath: string, workingDirectory: WorkingDirectory | undefined, filePath: string): Promise<string[]> {
        const patterns = this.settings.codeActionsOnSave.rules;
        if (patterns === undefined) {
            return [];
        }
        const instance = await this.instanceFor(libraryPath, workingDirectory);
        const config = await instance.calculateConfigForFile?.(filePath) as { rules?: Record<string, unknown> } | undefined;
        const ruleIds = Object.keys(config?.rules ?? {});
        return patterns.length === 0 ? ruleIds : ruleIds.filter((ruleId) => isRuleOffOnSave(ruleId, patterns));
    }

    async fixAll(filePath: string, text: string, workspaceRoot: string | undefined): Promise<EslintFixResult> {
        const skipped = this.shouldValidate(filePath);
        if (skipped) {
            return { status: skipped };
        }
        if (this.settings.codeActionsOnSave.mode !== 'all') {
            throw new DiagnosticsUnavailableError('eslint', `eslint.codeActionsOnSave.mode "${this.settings.codeActionsOnSave.mode}" applies the fixes the editor has already computed and is not reproduced`);
        }

        const { workingDirectory, libraryPath } = this.locate(filePath, workspaceRoot);
        if (!libraryPath) {
            return { status: 'not-installed', workingDirectory: workingDirectory?.directory };
        }

        return withWorkingDirectory(workingDirectory, async () => {
            try {
                const offRules = await this.rulesOffOnSave(libraryPath, workingDirectory, filePath);
                const fixOptions: Record<string, unknown> = { fix: true, ...this.settings.codeActionsOnSave.options };
                if (offRules.length > 0) {
                    fixOptions.overrideConfig = { rules: Object.fromEntries(offRules.map((ruleId) => [ruleId, 'off'])) };
                }
                const instance = await this.instanceFor(libraryPath, workingDirectory, fixOptions);
                const results = await instance.lintText(text, { filePath, warnIgnored: false });
                if (results.length === 0) {
                    return { status: 'ignored', workingDirectory: workingDirectory?.directory };
                }
                return { status: 'linted', output: results[0].output, workingDirectory: workingDirectory?.directory };
            } catch (error) {
                if (isMissingConfigError(error)) {
                    return { status: 'not-configured', workingDirectory: workingDirectory?.directory };
                }
                const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
                throw new DiagnosticsUnavailableError('eslint', `ESLint fixes failed: ${message}`);
            }
        });
    }

    async lint(filePath: string, text: string, workspaceRoot: string | undefined): Promise<EslintLintResult> {
        const skipped = this.shouldValidate(filePath);
        if (skipped) {
            return { status: skipped, diagnostics: [] };
        }

        const { workingDirectory, libraryPath } = this.locate(filePath, workspaceRoot);
        if (!libraryPath) {
            return { status: 'not-installed', diagnostics: [], workingDirectory: workingDirectory?.directory };
        }

        return withWorkingDirectory(workingDirectory, async () => {
            let results: { messages: EslintMessage[] }[];
            try {
                const instance = await this.instanceFor(libraryPath, workingDirectory);
                results = await instance.lintText(text, { filePath, warnIgnored: false });
            } catch (error) {
                if (isMissingConfigError(error)) {
                    return { status: 'not-configured', diagnostics: [], workingDirectory: workingDirectory?.directory, eslintPath: libraryPath };
                }
                const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
                throw new DiagnosticsUnavailableError('eslint', `ESLint failed: ${message}`);
            }

            if (results.length === 0) {
                return { status: 'ignored', diagnostics: [], workingDirectory: workingDirectory?.directory, eslintPath: libraryPath };
            }

            const diagnostics: TidyDiagnostic[] = [];
            const lineStarts = computeLineStarts(text);
            for (const message of results[0].messages) {
                const severity = customizedSeverity(message, this.settings.customizations);
                if (severity === null) {
                    continue;
                }
                if (this.settings.quiet && (severity === 'warning' || severity === 'info')) {
                    continue;
                }
                diagnostics.push({
                    source: 'eslint',
                    code: message.ruleId ?? undefined,
                    message: message.message,
                    severity,
                    start: offsetOf(lineStarts, message.line, message.column),
                });
            }

            return { status: 'linted', diagnostics, workingDirectory: workingDirectory?.directory, eslintPath: libraryPath };
        });
    }
}
