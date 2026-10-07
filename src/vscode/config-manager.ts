import * as vscode from 'vscode';

import {
    cloneConfig,
    computeAutoOrder,
    loadSettingsConfiguration,
    mergeConfigs,
    parseRegexString,
    resolveConfigForFile,
    sortGroupsForParser,
    validateConfiguration,
} from '../core/config';
import { ConfigCache } from '../utils/config-cache';
import { logDebug } from '../utils/log';
import { ConfigLoader } from './config-loader';

import type { ConfigValidation } from '../core/config';
import type { Config } from '../types';

class ConfigManager {
    private configCache = new ConfigCache();
    private documentConfigCache = new Map<string, Config>();

    public initialize(context: vscode.ExtensionContext): void {
        ConfigLoader.initialize(context);

        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('tidyjs')) {
                    this.clearDocumentCache();
                    logDebug('Configuration changed, clearing caches');
                }
            })
        );

        logDebug('ConfigManager initialized');
    }

    private deepCloneConfig(config: Config): Config {
        return cloneConfig(config);
    }

    private computeAutoOrder(groups: Config['groups']): Config['groups'] {
        return computeAutoOrder(groups);
    }

    public validateConfiguration(config: Config): ConfigValidation {
        return validateConfiguration(config);
    }

    public getConfig(): Config {
        const { config } = this.configCache.getConfig(
            () => this.loadConfiguration(),
            (c) => this.validateConfiguration(c)
        );
        return config;
    }

    public validateCurrentConfiguration(): ConfigValidation {
        const { validation } = this.configCache.getConfig(
            () => this.loadConfiguration(),
            (c) => this.validateConfiguration(c)
        );
        return validation;
    }

    public getGroups(): Config['groups'] {
        return sortGroupsForParser(this.getConfig().groups);
    }

    private parseRegexString(regexStr: string): RegExp | undefined {
        return parseRegexString(regexStr);
    }

    private loadConfiguration(): Config {
        return loadSettingsConfiguration(vscode.workspace.getConfiguration('tidyjs'));
    }

    public getParserConfig(): Config {
        return {
            ...this.getConfig(),
            groups: this.getGroups(),
        };
    }

    public async getConfigForUri(uri: vscode.Uri): Promise<Config> {
        const cacheKey = uri.toString();

        const cached = this.documentConfigCache.get(cacheKey);
        if (cached) {
            return cached;
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
        const config = await resolveConfigForFile(uri.fsPath, {
            ...ConfigLoader.getResolutionContext(uri),
            workspaceRoot: workspaceFolder?.uri.fsPath,
            fallbackConfig: () => this.getConfig(),
        });

        this.documentConfigCache.set(cacheKey, config);
        return config;
    }

    public async getConfigForDocument(document: vscode.TextDocument): Promise<Config> {
        return this.getConfigForUri(document.uri);
    }

    private mergeConfigs(base: Config, override: Partial<Config>): Config {
        return mergeConfigs(base, override);
    }

    public clearDocumentCache(): void {
        this.documentConfigCache.clear();
        this.configCache.clear();
        ConfigLoader.clearCache();
        logDebug('Document configuration cache cleared');
    }
}

export const configManager = new ConfigManager();
