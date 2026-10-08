import * as vscode from 'vscode';

import {
    CONFIG_FILE_NAMES,
    FileConfigSources,
    collectConfigSources,
    convertFileConfigToConfig,
    findNearestConfigFile,
    loadConfigFile,
    mergeFileConfigs,
} from '../core/config';
import { logDebug as debugLog } from '../utils/log';
import { configManager } from './config-manager';

import type { ConfigResolutionContext } from '../core/config';
import type { Config, ConfigSource, TidyJSConfigFile } from '../types';

export class ConfigLoader {
    private static configCache = new FileConfigSources();
    private static fileWatcher: vscode.FileSystemWatcher | undefined;

    static initialize(context: vscode.ExtensionContext): void {
        const pattern = `**/{${CONFIG_FILE_NAMES.join(',')}}`;
        this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);

        const clearAllCaches = (): void => {
            debugLog('Config file changed, clearing all caches');
            configManager.clearDocumentCache();
        };
        this.fileWatcher.onDidCreate(clearAllCaches);
        this.fileWatcher.onDidChange(clearAllCaches);
        this.fileWatcher.onDidDelete(clearAllCaches);

        context.subscriptions.push(this.fileWatcher);

        debugLog('ConfigLoader initialized with file watcher');
    }

    static clearCache(): void {
        this.configCache.clear();
    }

    static async findNearestConfigFile(documentUri: vscode.Uri): Promise<string | null> {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
        return findNearestConfigFile(documentUri.fsPath, workspaceFolder?.uri.fsPath);
    }

    static async loadConfigFile(configPath: string): Promise<TidyJSConfigFile | null> {
        return loadConfigFile(configPath);
    }

    static mergeConfigs(base: TidyJSConfigFile, override: TidyJSConfigFile): TidyJSConfigFile {
        return mergeFileConfigs(base, override);
    }

    static convertFileConfigToConfig(fileConfig: TidyJSConfigFile, configPath?: string): Partial<Config> {
        return convertFileConfigToConfig(fileConfig, configPath);
    }

    static getResolutionContext(documentUri: vscode.Uri): ConfigResolutionContext {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
        return {
            workspaceRoot: workspaceFolder?.uri.fsPath,
            fileSources: this.configCache,
            workspaceSettings: workspaceFolder ? vscode.workspace.getConfiguration('tidyjs', documentUri) : undefined,
            globalSettings: vscode.workspace.getConfiguration('tidyjs'),
        };
    }

    static async getConfigForDocument(documentUri: vscode.Uri): Promise<ConfigSource[]> {
        return collectConfigSources(documentUri.fsPath, this.getResolutionContext(documentUri));
    }
}
