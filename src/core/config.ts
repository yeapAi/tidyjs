import * as fs from 'fs';
import * as path from 'path';

import { cloneDeepWith } from '../utils/deep-clone';
import { logDebug, logError } from '../utils/log';

import type { Config, ConfigSource, ImportGroupFile, TidyJSConfigFile } from '../types';

export const CONFIG_FILE_NAMES = ['.tidyjsrc', 'tidyjs.json'];

export const DEFAULT_CONFIG: Config = {
    debug: false,
    groups: [
        {
            name: 'Other',
            order: 0,
            default: true,
        }
    ],
    importOrder: {
        sideEffect: 0,
        default: 1,
        named: 2,
        typeOnly: 3,
    },
    format: {
        indent: 4,
        removeUnusedImports: false,
        removeMissingModules: false,
        singleQuote: true,
        bracketSpacing: true,
        organizeReExports: false,
        enforceNewlineAfterImports: true,
        blankLinesBetweenGroups: 1,
        trailingComma: 'never',
        sortSpecifiers: 'length',
        maxLineWidth: 0,
        sortEnumMembers: false,
        sortExports: false,
        sortClassProperties: false,
        sortTypeMembers: false,
        preserveComments: true,
    },
    pathResolution: {
        mode: false,
        preferredAliases: [],
    },
    excludedFolders: [],
};

export interface ConfigValidation {
    isValid: boolean;
    errors: string[];
}

export interface SettingsReader {
    has(key: string): boolean;
    get<T>(key: string): T | undefined;
}

type ConfigGroup = Config['groups'][0];

export function cloneConfig(config: Config): Config {
    return cloneDeepWith(config, (value) => {
        if (value instanceof RegExp) {
            return new RegExp(value.source, value.flags);
        }
        return undefined;
    });
}

export function serializeConfig(config: Config): string {
    return JSON.stringify(config, (_key, value) => {
        if (value instanceof RegExp) {
            return `__REGEXP__${value.source}__FLAGS__${value.flags}`;
        }
        return value;
    });
}

export function computeAutoOrder(groups: Config['groups']): Config['groups'] {
    const usedOrders = new Set<number>();
    const withOrders: Config['groups'] = [];
    const withoutOrders: Config['groups'] = [];

    for (const grp of groups) {
        if (typeof grp.order === 'number' && Number.isInteger(grp.order) && grp.order >= 0) {
            if (grp.order > 1000) {
                logDebug(`High order value detected: ${grp.order} for group "${grp.name}". Consider using lower values.`);
            }
            withOrders.push({ ...grp, originalOrder: grp.order } as ConfigGroup & { originalOrder: number });
        } else {
            withoutOrders.push({ ...grp });
        }
    }

    for (const item of withOrders) {
        const typedItem = item as ConfigGroup & { originalOrder: number };
        let desired = typedItem.originalOrder;

        while (usedOrders.has(desired)) {
            desired++;
        }

        usedOrders.add(desired);
        item.order = desired;

        if (desired !== typedItem.originalOrder) {
            logDebug(`Group "${item.name}" order adjusted from ${typedItem.originalOrder} to ${desired} due to collision.`);
        }
    }

    let candidate = 0;
    for (const item of withoutOrders) {
        while (usedOrders.has(candidate)) {
            candidate++;
        }

        usedOrders.add(candidate);
        item.order = candidate;
        candidate++;
    }

    const allResolved = [...withOrders, ...withoutOrders];
    allResolved.sort((a, b) => a.order - b.order);

    return allResolved;
}

export function validateRegexString(regexStr: string): { isValid: boolean; error?: string } {
    if (!regexStr) {
        return { isValid: false, error: 'Empty regex pattern' };
    }

    try {
        if (regexStr.startsWith('/') && regexStr.length > 1) {
            const lastSlashIndex = regexStr.lastIndexOf('/');
            if (lastSlashIndex > 0) {
                const pattern = regexStr.slice(1, lastSlashIndex);
                const flags = regexStr.slice(lastSlashIndex + 1);

                const validFlags = /^[dgimsuy]*$/.test(flags);
                if (!validFlags) {
                    return { isValid: false, error: `Invalid regex flags '${flags}'` };
                }

                new RegExp(pattern, flags);
            } else {
                new RegExp(regexStr.slice(1));
            }
        } else {
            new RegExp(regexStr);
        }

        return { isValid: true };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown regex error';
        return { isValid: false, error: errorMessage };
    }
}

export function parseRegexString(regexStr: string): RegExp | undefined {
    if (!regexStr) {return undefined;}

    const validation = validateRegexString(regexStr);
    if (!validation.isValid) {
        logError(`Invalid regex pattern "${regexStr}": ${validation.error}`);
        return undefined;
    }

    try {
        if (regexStr.startsWith('/') && regexStr.length > 1) {
            const lastSlashIndex = regexStr.lastIndexOf('/');
            if (lastSlashIndex > 0) {
                const pattern = regexStr.slice(1, lastSlashIndex);
                const flags = regexStr.slice(lastSlashIndex + 1);
                const safeFlags = flags.replace(/[gy]/g, '');
                return new RegExp(pattern, safeFlags);
            } else {
                return new RegExp(regexStr.slice(1));
            }
        } else {
            return new RegExp(regexStr);
        }
    } catch (error) {
        logError(`Error parsing regex "${regexStr}":`, error);
        return undefined;
    }
}

function validateRegexPatterns(groups: Config['groups']): string[] {
    const errors: string[] = [];

    for (const group of groups) {
        const groupWithOriginal = group as ConfigGroup & { originalMatchString?: string };
        const matchString = groupWithOriginal.originalMatchString;

        if (matchString !== undefined && matchString !== null) {
            const validation = validateRegexString(matchString);
            if (!validation.isValid) {
                errors.push(`Invalid regex pattern in group "${group.name}": ${validation.error}`);
            }
        } else if (group.match !== undefined) {
            try {
                if (group.match instanceof RegExp) {
                    group.match.test('test');
                } else {
                    new RegExp(group.match as string);
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown regex error';
                errors.push(`Invalid regex pattern in group "${group.name}": ${errorMessage}`);
            }
        }
    }

    return errors;
}

function validateSortOrders(groups: Config['groups']): string[] {
    const errors: string[] = [];

    for (const group of groups) {
        if (group.sortOrder !== undefined) {
            if (group.sortOrder !== 'alphabetic' && !Array.isArray(group.sortOrder)) {
                errors.push(`Invalid sortOrder in group "${group.name}": must be 'alphabetic' or an array of strings`);
            } else if (Array.isArray(group.sortOrder)) {
                if (group.sortOrder.length === 0) {
                    errors.push(`Invalid sortOrder in group "${group.name}": array cannot be empty`);
                } else if (!group.sortOrder.every(item => typeof item === 'string')) {
                    errors.push(`Invalid sortOrder in group "${group.name}": all array items must be strings`);
                } else {
                    const uniquePatterns = [...new Set(group.sortOrder)];
                    if (uniquePatterns.length !== group.sortOrder.length) {
                        errors.push(`Invalid sortOrder in group "${group.name}": duplicate patterns found`);
                    }
                }
            }
        }
    }

    return errors;
}

export function validateConfiguration(config: Config): ConfigValidation {
    const errors: string[] = [];
    const defaultGroups = config.groups.filter(group => group.default === true);

    if (defaultGroups.length === 0) {
        errors.push('No group is marked as default. At least one group must be the default.');
    } else if (defaultGroups.length > 1) {
        const groupNames = defaultGroups.map(g => `"${g.name}"`).join(', ');
        errors.push(`Multiple groups are marked as default: ${groupNames}. Only one group can be the default.`);
    }

    const names = config.groups.map(g => g.name);
    const uniqueNames = [...new Set(names)];
    if (names.length !== uniqueNames.length) {
        const duplicateNames = names.filter((name, index) => names.indexOf(name) !== index);
        const uniqueDuplicateNames = [...new Set(duplicateNames)];
        errors.push(`Duplicate group names found: ${uniqueDuplicateNames.join(', ')}. Each group must have a unique name.`);
    }

    errors.push(...validateRegexPatterns(config.groups));
    errors.push(...validateSortOrders(config.groups));

    return {
        isValid: errors.length === 0,
        errors
    };
}

export function sortGroupsForParser(groups: Config['groups']): Config['groups'] {
    const sorted = groups.map(g => ({
        ...g,
        default: !!g.default,
    }));

    sorted.sort((a, b) => {
        if (a.order !== b.order) {
            return a.order - b.order;
        }
        if (a.default && !b.default) {return 1;}
        if (!a.default && b.default) {return -1;}

        return a.name.localeCompare(b.name);
    });

    return sorted;
}

export function loadSettingsConfiguration(settings: SettingsReader): Config {
    try {
        const config = cloneConfig(DEFAULT_CONFIG);
        const customGroupsSetting = settings.get<{
            name: string;
            match?: string;
            order: number;
            default?: boolean;
            isDefault?: boolean;
            sortOrder?: 'alphabetic' | string[];
        }[]>('groups');

        if (customGroupsSetting !== undefined) {
            const rawGroups = customGroupsSetting.map(group => {
                if ('isDefault' in group && group.isDefault !== undefined) {
                    logDebug(`Detected isDefault property on group: ${JSON.stringify(group)}`);
                    logError(`DEPRECATION WARNING: Group "${group.name}" uses deprecated property "isDefault". Please use "default" instead. The "isDefault" property will be removed in a future version.`);

                    if (group.default === undefined) {
                        logDebug(`Auto-migrating "isDefault" to "default" for group "${group.name}"`);
                    } else {
                        logError(`Group "${group.name}" has both "isDefault" and "default" properties. Using "default" value and ignoring "isDefault".`);
                    }
                }

                return {
                    name: group.name,
                    match: group.match ? parseRegexString(group.match) : undefined,
                    order: group.order,
                    default: group.default !== undefined ? !!group.default : ('isDefault' in group ? !!group.isDefault : false),
                    sortOrder: group.sortOrder,
                    originalMatchString: group.match,
                };
            });

            config.groups = computeAutoOrder(rawGroups);
        }
        const formatSettings = {
            indent: settings.get<number>('format.indent'),
            removeUnusedImports: settings.get<boolean>('format.removeUnusedImports'),
            removeMissingModules: settings.get<boolean>('format.removeMissingModules'),
            singleQuote: settings.get<boolean>('format.singleQuote'),
            bracketSpacing: settings.get<boolean>('format.bracketSpacing'),
            sortEnumMembers: settings.get<boolean>('format.sortEnumMembers'),
            sortExports: settings.get<boolean>('format.sortExports'),
            sortClassProperties: settings.get<boolean>('format.sortClassProperties'),
            sortTypeMembers: settings.get<boolean>('format.sortTypeMembers'),
            preserveComments: settings.get<boolean>('format.preserveComments'),
            organizeReExports: settings.get<boolean>('format.organizeReExports'),
            enforceNewlineAfterImports: settings.get<boolean>('format.enforceNewlineAfterImports'),
            blankLinesBetweenGroups: settings.get<number>('format.blankLinesBetweenGroups'),
            trailingComma: settings.get<string>('format.trailingComma'),
            sortSpecifiers: settings.get<string | false>('format.sortSpecifiers'),
            maxLineWidth: settings.get<number>('format.maxLineWidth'),
        };

        for (const [key, value] of Object.entries(formatSettings)) {
            if (value !== undefined) {
                (config.format as Record<string, unknown>)[key] = value;
            }
        }
        const importOrder = settings.get<Config['importOrder']>('importOrder');
        if (importOrder) {
            config.importOrder = { ...importOrder };
        }
        const debug = settings.get<boolean>('debug');
        if (debug !== undefined) {
            config.debug = debug;
        }
        const excludedFolders = settings.get<string[]>('excludedFolders');
        if (excludedFolders !== undefined) {
            config.excludedFolders = [...excludedFolders];
        }

        const pathResolutionMode = settings.get<'relative' | 'absolute' | false>('pathResolution.mode');
        const pathResolutionAliases = settings.get<string[]>('pathResolution.preferredAliases');

        if (pathResolutionMode !== undefined) {
            config.pathResolution = config.pathResolution || {};
            config.pathResolution.mode = pathResolutionMode;
        }
        if (pathResolutionAliases !== undefined) {
            config.pathResolution = config.pathResolution || {};
            config.pathResolution.preferredAliases = [...pathResolutionAliases];
        }

        const customAliases = settings.get<Record<string, string[]>>('pathResolution.aliases');
        if (customAliases !== undefined && Object.keys(customAliases).length > 0) {
            config.pathResolution = config.pathResolution || {};
            config.pathResolution.aliases = customAliases;
        }

        return config;

    } catch (error) {
        logError('Error loading configuration:', error);
        return cloneConfig(DEFAULT_CONFIG);
    }
}

export function extractSettingsConfig(settings: SettingsReader): Partial<Config> {
    const config: Partial<Config> = {};

    if (settings.has('debug')) {
        config.debug = settings.get('debug');
    }

    if (settings.has('groups')) {
        const groups = settings.get<{
            name: string;
            order?: number;
            default?: boolean;
            match?: string;
            priority?: number;
            sortOrder?: 'alphabetic' | string[];
        }[]>('groups');
        if (groups) {
            config.groups = groups.map(group => ({
                ...group,
                order: group.order ?? 999,
                match: group.match ? new RegExp(group.match) : undefined,
            }));
        }
    }

    if (settings.has('importOrder')) {
        config.importOrder = settings.get('importOrder');
    }

    if (settings.has('format')) {
        config.format = settings.get('format');
    }

    if (settings.has('pathResolution')) {
        config.pathResolution = settings.get('pathResolution');
    }

    if (settings.has('excludedFolders')) {
        config.excludedFolders = settings.get('excludedFolders');
    }

    return config;
}

export function mergeConfigs(base: Config, override: Partial<Config>): Config {
    const result = cloneConfig(base);

    if (override.debug !== undefined) {
        result.debug = override.debug;
    }

    if (override.groups !== undefined) {
        result.groups = override.groups;
    }

    if (override.importOrder) {
        result.importOrder = { ...result.importOrder, ...override.importOrder };
    }

    if (override.format) {
        result.format = { ...result.format, ...override.format };
    }

    if (override.pathResolution) {
        result.pathResolution = { ...result.pathResolution, ...override.pathResolution };
    }

    if (override.excludedFolders !== undefined) {
        result.excludedFolders = override.excludedFolders;
    }

    return result;
}

export function resolveAliasesAgainstRoot(config: Config, rootPath: string | undefined): void {
    const aliases = config.pathResolution?.aliases;
    if (!aliases || Object.keys(aliases).length === 0) { return; }
    if (!rootPath) { return; }

    config.pathResolution!.aliases = Object.fromEntries(
        Object.entries(aliases).map(([pattern, paths]) => [
            pattern,
            paths.map(p => path.isAbsolute(p) ? p : path.resolve(rootPath, p))
        ])
    );
}

export async function findNearestConfigFile(filePath: string, workspaceRoot: string | undefined): Promise<string | null> {
    let currentDir = path.dirname(filePath);
    const rootDir = workspaceRoot ?? path.parse(currentDir).root;

    logDebug(`Searching for config file starting from: ${currentDir}`);

    while (currentDir && currentDir !== path.dirname(currentDir)) {
        for (const configFileName of CONFIG_FILE_NAMES) {
            const configPath = path.join(currentDir, configFileName);
            try {
                await fs.promises.access(configPath, fs.constants.R_OK);
                logDebug(`Found config file: ${configPath}`);
                return configPath;
            } catch {
                // File doesn't exist or isn't readable, continue searching
            }
        }

        if (currentDir === rootDir) {
            break;
        }

        currentDir = path.dirname(currentDir);
    }

    logDebug('No config file found');
    return null;
}

export function mergeFileConfigs(base: TidyJSConfigFile, override: TidyJSConfigFile): TidyJSConfigFile {
    return {
        ...base,
        ...override,
        importOrder: {
            ...base.importOrder,
            ...override.importOrder,
        },
        format: {
            ...base.format,
            ...override.format,
        },
        pathResolution: {
            ...base.pathResolution,
            ...override.pathResolution,
        },
        groups: override.groups || base.groups,
        excludedFolders: override.excludedFolders || base.excludedFolders,
    };
}

export async function loadConfigFile(configPath: string): Promise<TidyJSConfigFile | null> {
    try {
        const content = await fs.promises.readFile(configPath, 'utf8');
        const config = JSON.parse(content) as TidyJSConfigFile;

        logDebug(`Loaded config from ${configPath}`);

        if (config.extends) {
            const baseConfigPath = path.resolve(path.dirname(configPath), config.extends);
            const baseConfig = await loadConfigFile(baseConfigPath);
            if (baseConfig) {
                return mergeFileConfigs(baseConfig, config);
            }
        }

        return config;
    } catch (error) {
        logDebug(`Failed to load config file ${configPath}: ${error}`);
        return null;
    }
}

export function convertFileConfigToConfig(fileConfig: TidyJSConfigFile, configPath?: string): Partial<Config> {
    const config: Partial<Config> = {
        excludedFolders: fileConfig.excludedFolders,
    };

    if (fileConfig.groups) {
        config.groups = fileConfig.groups.map((group: ImportGroupFile) => {
            if ('isDefault' in group && group.isDefault !== undefined) {
                logDebug(`Detected isDefault property on group in config file: ${JSON.stringify(group)}`);
                logError(`DEPRECATION WARNING: Group "${group.name}" in config file uses deprecated property "isDefault". Please use "default" instead. The "isDefault" property will be removed in a future version.`);

                if (group.default === undefined) {
                    logDebug(`Auto-migrating "isDefault" to "default" for group "${group.name}" in config file`);
                } else {
                    logError(`Group "${group.name}" in config file has both "isDefault" and "default" properties. Using "default" value and ignoring "isDefault".`);
                }
            }

            return {
                ...group,
                order: group.order ?? 999,
                default: group.default !== undefined ? group.default : ('isDefault' in group ? group.isDefault : false),
                match: group.match ? new RegExp(group.match) : undefined,
            };
        });
    }

    if (fileConfig.importOrder) {
        config.importOrder = {
            default: fileConfig.importOrder.default ?? 1,
            named: fileConfig.importOrder.named ?? 2,
            typeOnly: fileConfig.importOrder.typeOnly ?? 3,
            sideEffect: fileConfig.importOrder.sideEffect ?? 0,
        };
    }

    if (fileConfig.format) {
        config.format = fileConfig.format;
    }

    if (fileConfig.pathResolution) {
        config.pathResolution = { ...fileConfig.pathResolution };
        if (fileConfig.pathResolution.aliases && configPath) {
            const configDir = path.dirname(configPath);
            config.pathResolution.aliases = Object.fromEntries(
                Object.entries(fileConfig.pathResolution.aliases).map(([pattern, paths]) => [
                    pattern,
                    paths.map(p => path.resolve(configDir, p))
                ])
            );
        }
    }

    return config;
}

export class FileConfigSources {
    private cache = new Map<string, ConfigSource | null>();

    clear(): void {
        this.cache.clear();
        logDebug('ConfigLoader cache cleared');
    }

    async getSource(filePath: string, workspaceRoot: string | undefined): Promise<ConfigSource | null> {
        const configPath = await findNearestConfigFile(filePath, workspaceRoot);
        logDebug(`Nearest config file search result: ${configPath || 'none found'}`);

        if (!configPath) {
            return null;
        }

        const cachedConfig = this.cache.get(configPath);
        if (cachedConfig !== undefined) {
            logDebug(`Using cached config for ${configPath}`);
            return cachedConfig;
        }

        logDebug(`Loading fresh config from ${configPath}`);
        const fileConfig = await loadConfigFile(configPath);
        if (!fileConfig) {
            this.cache.set(configPath, null);
            return null;
        }

        const config = convertFileConfigToConfig(fileConfig, configPath);
        logDebug(`Loaded config from file:`, fileConfig);
        logDebug(`Converted config:`, config);
        const source: ConfigSource = {
            type: 'file',
            path: configPath,
            config,
        };
        this.cache.set(configPath, source);
        return source;
    }
}

export function mergeConfigSources(sources: ConfigSource[]): Config {
    let mergedConfig = cloneConfig(DEFAULT_CONFIG);

    logDebug(`Merging ${sources.length} config sources for URI`);

    for (let i = sources.length - 1; i >= 0; i--) {
        const source = sources[i];
        logDebug(`Applying config source ${i}: ${source.type} from ${source.path}`, {
            hasFormat: !!source.config.format,
            formatConfig: source.config.format
        });
        mergedConfig = mergeConfigs(mergedConfig, source.config);
    }

    if (mergedConfig.groups) {
        mergedConfig.groups = computeAutoOrder(mergedConfig.groups);
    }

    return mergedConfig;
}

export interface ConfigResolutionContext {
    workspaceRoot: string | undefined;
    fileSources: FileConfigSources;
    workspaceSettings?: SettingsReader;
    globalSettings: SettingsReader;
    fallbackConfig?: () => Config;
}

export async function collectConfigSources(filePath: string, context: ConfigResolutionContext): Promise<ConfigSource[]> {
    const sources: ConfigSource[] = [];

    logDebug(`ConfigLoader.getConfigForDocument called for: ${filePath}`);

    const fileSource = await context.fileSources.getSource(filePath, context.workspaceRoot);
    if (fileSource) {
        sources.push(fileSource);
    }

    if (context.workspaceRoot !== undefined && context.workspaceSettings) {
        const workspaceConfig = extractSettingsConfig(context.workspaceSettings);
        if (Object.keys(workspaceConfig).length > 0) {
            sources.push({
                type: 'vscode',
                path: context.workspaceRoot,
                config: workspaceConfig,
            });
        }
    }

    const globalConfig = extractSettingsConfig(context.globalSettings);
    if (Object.keys(globalConfig).length > 0) {
        sources.push({
            type: 'vscode',
            path: 'global',
            config: globalConfig,
        });
    }

    return sources;
}

export async function resolveConfigForFile(filePath: string, context: ConfigResolutionContext): Promise<Config> {
    const sources = await collectConfigSources(filePath, context);

    if (sources.length === 0) {
        const config = context.fallbackConfig ? context.fallbackConfig() : loadSettingsConfiguration(context.globalSettings);
        resolveAliasesAgainstRoot(config, context.workspaceRoot);
        return config;
    }

    const mergedConfig = mergeConfigSources(sources);

    logDebug(`Config loaded for ${filePath} from ${sources.length} sources`);
    logDebug(`Final merged config format:`, {
        indent: mergedConfig.format?.indent,
        singleQuote: mergedConfig.format?.singleQuote,
        bracketSpacing: mergedConfig.format?.bracketSpacing,
        removeUnusedImports: mergedConfig.format?.removeUnusedImports
    });

    resolveAliasesAgainstRoot(mergedConfig, context.workspaceRoot);
    return mergedConfig;
}
