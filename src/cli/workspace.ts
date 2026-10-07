import * as fs from 'fs';
import * as path from 'path';
import { parse as parseJsonc } from 'jsonc-parser';

import { FileConfigSources } from '../core/config';
import {
    contributedDefaults,
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
    path?: string;
    warning?: string;
}

export interface CliWorkspace {
    root: string;
    settingsPath?: string;
    settingsWarning?: string;
    settings: SettingsTree;
    tidyjsSettings: SettingsReader;
    eslintSettings: SettingsReader;
    fileSources: FileConfigSources;
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
        return { tree: {} };
    }

    const errors: ParseError[] = [];
    const parsed: unknown = parseJsonc(content, errors, { allowTrailingComma: true, disallowComments: false });
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { tree: {}, path: settingsPath, warning: `${settingsPath} is not a JSON object; VS Code settings ignored` };
    }

    const warning = errors.length > 0
        ? `${settingsPath} contains ${errors.length} JSON syntax error(s); the readable part is used, as VS Code does`
        : undefined;

    const flatEntries: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!key.startsWith('[')) {
            flatEntries[key] = value;
        }
    }

    return { tree: settingsTreeFromFlatEntries(flatEntries), path: settingsPath, warning };
}

export function createCliWorkspace(root: string, packageJson: unknown): CliWorkspace {
    const loaded = loadWorkspaceSettings(root);
    const defaults = settingsTreeFromFlatEntries(contributedDefaults(packageJson));
    const settings = mergeSettingsTrees(defaults, loaded.tree);
    const tidyjsSettings = createSettingsReader(getSettingsSection(settings, 'tidyjs'));
    const eslintSettings = createSettingsReader(getSettingsSection(settings, 'eslint'));
    const fileSources = new FileConfigSources();
    const rootFor = (filePath: string): string | undefined => (isInsideDirectory(filePath, root) ? root : undefined);

    return {
        root,
        settingsPath: loaded.path,
        settingsWarning: loaded.warning,
        settings,
        tidyjsSettings,
        eslintSettings,
        fileSources,
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
