import * as fs from 'fs';
import * as path from 'path';
import { parse as parseJsonc } from 'jsonc-parser';

import { FileConfigSources } from '../core/config';
import {
    contributedDefaults,
    createFlatSettingsReader,
    createSettingsReader,
    getSettingsSection,
    mergeSettingsTrees,
    settingsTreeFromFlatEntries,
} from '../core/settings';

import type { ParseError } from 'jsonc-parser';
import type { ConfigResolutionContext, SettingsReader } from '../core/config';
import type { SettingsTree } from '../core/settings';

const WORKSPACE_MARKERS = ['.git', '.vscode'];

export interface WorkspaceSettingsLoad {
    tree: SettingsTree;
    languageOverrides: Record<string, Record<string, unknown>>;
    flatEntries: Record<string, unknown>;
    path?: string;
    warning?: string;
}

export interface CliWorkspace {
    root: string;
    settingsPath?: string;
    settingsWarning?: string;
    settings: SettingsTree;
    tidyjsSettings: SettingsReader;
    oxcSettings: SettingsReader;
    fileSources: FileConfigSources;
    oxlintFixAllOnSave(filePath: string): boolean;
    rootFor(filePath: string): string | undefined;
    resolutionContext(filePath: string): ConfigResolutionContext;
}

export function isInsideDirectory(filePath: string, directory: string): boolean {
    const relative = path.relative(directory, filePath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function findWorkspaceRoot(startDir: string): string {
    let current = path.resolve(startDir);
    for (;;) {
        if (WORKSPACE_MARKERS.some((marker) => fs.existsSync(path.join(current, marker)))) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            return path.resolve(startDir);
        }
        current = parent;
    }
}

export function loadWorkspaceSettings(root: string): WorkspaceSettingsLoad {
    const settingsPath = path.join(root, '.vscode', 'settings.json');
    let content: string;
    try {
        content = fs.readFileSync(settingsPath, 'utf8');
    } catch {
        return { tree: {}, languageOverrides: {}, flatEntries: {} };
    }

    const errors: ParseError[] = [];
    const parsed: unknown = parseJsonc(content, errors, { allowTrailingComma: true, disallowComments: false });
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { tree: {}, languageOverrides: {}, flatEntries: {}, path: settingsPath, warning: `${settingsPath} is not a JSON object; VS Code settings ignored` };
    }

    const warning = errors.length > 0
        ? `${settingsPath} contains ${errors.length} JSON syntax error(s); the readable part is used, as VS Code does`
        : undefined;

    const flatEntries: Record<string, unknown> = {};
    const languageOverrides: Record<string, Record<string, unknown>> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!key.startsWith('[')) {
            flatEntries[key] = value;
            continue;
        }
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            continue;
        }
        for (const [, languageId] of key.matchAll(/\[([^\]]+)\]/g)) {
            languageOverrides[languageId] = { ...languageOverrides[languageId], ...value as Record<string, unknown> };
        }
    }

    return { tree: settingsTreeFromFlatEntries(flatEntries), languageOverrides, flatEntries, path: settingsPath, warning };
}

export function languageIdFor(filePath: string): string {
    switch (path.extname(filePath).toLowerCase()) {
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

function isCodeActionEnabled(value: unknown): boolean {
    return value === true || value === 'explicit' || value === 'always';
}

export function codeActionsRunOxlintFixAll(codeActionsOnSave: unknown): boolean {
    if (Array.isArray(codeActionsOnSave)) {
        return codeActionsOnSave.includes('source.fixAll.oxc') || codeActionsOnSave.includes('source.fixAll');
    }
    if (typeof codeActionsOnSave !== 'object' || codeActionsOnSave === null) {
        return false;
    }
    const kinds = codeActionsOnSave as Record<string, unknown>;
    return 'source.fixAll.oxc' in kinds ? isCodeActionEnabled(kinds['source.fixAll.oxc']) : isCodeActionEnabled(kinds['source.fixAll']);
}

function mergeCodeActions(general: unknown, language: unknown): unknown {
    const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
    if (language === undefined) {
        return general;
    }
    return isObject(general) && isObject(language) ? { ...general, ...language } : language;
}

export function createCliWorkspace(root: string, packageJson: unknown): CliWorkspace {
    const loaded = loadWorkspaceSettings(root);
    const defaults = settingsTreeFromFlatEntries(contributedDefaults(packageJson));
    const settings = mergeSettingsTrees(defaults, loaded.tree);
    const tidyjsSettings = createSettingsReader(getSettingsSection(settings, 'tidyjs'));
    const oxcSettings = createFlatSettingsReader('oxc', loaded.flatEntries);
    const codeActionsOnSave = createSettingsReader(getSettingsSection(settings, 'editor')).get<unknown>('codeActionsOnSave');
    const fileSources = new FileConfigSources();
    const rootFor = (filePath: string): string | undefined => (isInsideDirectory(filePath, root) ? root : undefined);

    return {
        root,
        settingsPath: loaded.path,
        settingsWarning: loaded.warning,
        settings,
        tidyjsSettings,
        oxcSettings,
        fileSources,
        oxlintFixAllOnSave: (filePath) => codeActionsRunOxlintFixAll(mergeCodeActions(
            codeActionsOnSave,
            loaded.languageOverrides[languageIdFor(filePath)]?.['editor.codeActionsOnSave']
        )),
        rootFor,
        resolutionContext: (filePath) => {
            const workspaceRoot = rootFor(filePath);
            return {
                workspaceRoot,
                fileSources,
                workspaceSettings: workspaceRoot ? tidyjsSettings : undefined,
                globalSettings: tidyjsSettings,
            };
        },
    };
}
