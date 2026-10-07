import * as fs from 'fs';
import * as nodePath from 'path';
import { createRequire } from 'module';
import { parse as parseJsonc } from 'jsonc-parser';

import type { ParseError } from 'jsonc-parser';

import { logDebug, logError } from './log';

export interface PathMapping {
    pattern: string;
    paths: string[];
}

interface PathResolverConfig {
    mode: 'relative' | 'absolute';
    preferredAliases?: string[];
    aliases?: Record<string, string[]>;
}

/**
 * Compute a specificity score for a path mapping pattern.
 * Higher score = more specific. Accounts for fixed segments count,
 * pattern length, and wildcard count.
 */
function patternSpecificity(pattern: string): number {
    const wildcards = (pattern.match(/\*/g) || []).length;
    const fixedSegments = pattern.replace(/\*/g, '').split('/').filter(Boolean).length;
    // Fixed segments weigh most, then total length, then fewer wildcards
    return fixedSegments * 1000 + pattern.length * 10 - wildcards;
}

function safeRegExp(pattern: string): RegExp | null {
    try {
        return new RegExp(pattern);
    } catch {
        logError(`Invalid regex pattern: ${pattern}`);
        return null;
    }
}

interface TsConfigPathOptions {
    baseUrl?: string;
    paths?: Record<string, string[]>;
    pathsBasePath?: string;
}

function ownPathOptions(configPath: string, config: unknown): TsConfigPathOptions {
    const compilerOptions = (config as { compilerOptions?: { baseUrl?: unknown; paths?: unknown } } | null)?.compilerOptions;
    if (!compilerOptions || typeof compilerOptions !== 'object') { return {}; }

    const configDir = nodePath.dirname(configPath);
    const options: TsConfigPathOptions = {};
    if (typeof compilerOptions.baseUrl === 'string' && compilerOptions.baseUrl) {
        options.baseUrl = nodePath.resolve(configDir, compilerOptions.baseUrl);
    }
    if (compilerOptions.paths && typeof compilerOptions.paths === 'object') {
        options.paths = compilerOptions.paths as Record<string, string[]>;
        options.pathsBasePath = configDir;
    }
    return options;
}

function mappingsFromPathOptions(options: TsConfigPathOptions): PathMapping[] {
    const mappings: PathMapping[] = [];

    if (options.paths && Object.keys(options.paths).length > 0) {
        const base = options.baseUrl ?? options.pathsBasePath!;
        for (const [pattern, paths] of Object.entries(options.paths)) {
            mappings.push({
                pattern,
                paths: paths.map(p => nodePath.resolve(base, p))
            });
        }
    } else if (options.baseUrl) {
        mappings.push({
            pattern: '*',
            paths: [nodePath.resolve(options.baseUrl, '*')]
        });
        logDebug(`Using baseUrl fallback mapping: * -> ${options.baseUrl}/*`);
    }

    return mappings;
}

/**
 * Extract path mappings from a parsed tsconfig/jsconfig JSON object (pure Node.js, no VS Code APIs).
 */
export function extractTsConfigPaths(configPath: string, config: unknown): PathMapping[] {
    if (!config || typeof config !== 'object') { return []; }
    return mappingsFromPathOptions(ownPathOptions(configPath, config));
}

function resolveExtendedConfig(specifier: string, fromDir: string): string | undefined {
    if (specifier.startsWith('.') || nodePath.isAbsolute(specifier)) {
        const candidate = nodePath.resolve(fromDir, specifier);
        return [candidate, `${candidate}.json`].find(file => fs.existsSync(file) && fs.statSync(file).isFile());
    }

    const localRequire = createRequire(nodePath.join(fromDir, 'tsconfig.json'));
    for (const request of [specifier, `${specifier}.json`, `${specifier}/tsconfig.json`]) {
        try {
            return localRequire.resolve(request);
        } catch {
            continue;
        }
    }
    return undefined;
}

export function readTsConfigPathOptions(configPath: string, seen = new Set<string>()): TsConfigPathOptions | null {
    if (seen.has(configPath)) { return {}; }
    seen.add(configPath);

    let content: string;
    try {
        content = fs.readFileSync(configPath, 'utf-8');
    } catch {
        return null;
    }

    const errors: ParseError[] = [];
    const json: unknown = parseJsonc(content, errors, { allowTrailingComma: true });
    if (!json || typeof json !== 'object' || Array.isArray(json)) { return null; }

    const extendsValue = (json as { extends?: unknown }).extends;
    const bases = Array.isArray(extendsValue) ? extendsValue : [extendsValue];

    let options: TsConfigPathOptions = {};
    for (const base of bases) {
        if (typeof base !== 'string') { continue; }
        const basePath = resolveExtendedConfig(base, nodePath.dirname(configPath));
        const inherited = basePath ? readTsConfigPathOptions(basePath, seen) : null;
        if (inherited) {
            options = { ...options, ...inherited };
        }
    }

    return { ...options, ...ownPathOptions(configPath, json) };
}

/**
 * Walk up from the file directory to the workspace root,
 * looking for tsconfig.json / jsconfig.json (pure Node.js, no VS Code APIs).
 */
function loadTsConfigMappingsFromFs(filePath: string, workspaceRoot: string): PathMapping[] {
    let currentDir = nodePath.dirname(filePath);

    while (currentDir.startsWith(workspaceRoot)) {
        for (const name of ['tsconfig.json', 'jsconfig.json']) {
            const options = readTsConfigPathOptions(nodePath.join(currentDir, name));
            const mappings = options ? mappingsFromPathOptions(options) : [];
            if (mappings.length > 0) { return mappings; }
        }
        const parent = nodePath.dirname(currentDir);
        if (parent === currentDir) { break; }
        currentDir = parent;
    }
    return [];
}

export class PathResolver {
    private configCache = new Map<string, PathMapping[]>();

    constructor(private config: PathResolverConfig) {}

    /**
     * Load path mappings from .tidyjsrc aliases (priority) and tsconfig (fallback).
     * Uses Node.js fs instead of VS Code workspace APIs.
     */
    private loadPathMappingsBatch(filePath: string, workspaceRoot: string): PathMapping[] {
        const cacheKey = workspaceRoot;
        const cached = this.configCache.get(cacheKey);
        if (cached) { return [...cached]; }

        const allMappings: PathMapping[] = [];

        // 1. .tidyjsrc / config aliases (high priority)
        if (this.config.aliases) {
            for (const [pattern, paths] of Object.entries(this.config.aliases)) {
                allMappings.push({ pattern, paths });
            }
        }

        // 2. tsconfig.json / jsconfig.json (low priority)
        try {
            const tsMappings = loadTsConfigMappingsFromFs(filePath, workspaceRoot);
            const existing = new Set(allMappings.map(m => m.pattern));
            for (const m of tsMappings) {
                if (!existing.has(m.pattern)) { allMappings.push(m); }
            }
        } catch (error) {
            logError('Error loading tsconfig paths (batch):', error);
        }

        const sorted = [...allMappings].sort((a, b) =>
            patternSpecificity(b.pattern) - patternSpecificity(a.pattern)
        );

        this.configCache.set(cacheKey, sorted);
        logDebug(`Loaded ${sorted.length} path mappings (batch): ${sorted.map(m => m.pattern).join(', ')}`);

        return [...sorted];
    }

    /**
     * Convert an import path based on the configured mode (batch, no VS Code APIs).
     */
    public convertImportPathBatch(
        importPath: string,
        filePath: string,
        workspaceRoot: string
    ): string | null {
        const isRelativePath = importPath.startsWith('.');

        if (this.config.mode === 'relative' && isRelativePath) {
            return null;
        }

        const mappings = this.loadPathMappingsBatch(filePath, workspaceRoot);
        if (mappings.length === 0) {
            logDebug(`No path mappings found for ${importPath}`);
            return null;
        }

        const isPotentialAlias = importPath.startsWith('@') || importPath.startsWith('~');
        const matchesAlias = mappings.some(mapping => this.matchesPattern(importPath, mapping.pattern));

        if (!isRelativePath && !isPotentialAlias && !matchesAlias) {
            return null;
        }

        if (this.config.mode === 'absolute') {
            return this.convertToAbsoluteBatch(importPath, filePath, mappings);
        } else {
            return this.convertToRelativeBatch(importPath, filePath, mappings);
        }
    }

    /**
     * Convert relative or aliased path to absolute (batch, no VS Code APIs).
     */
    private convertToAbsoluteBatch(
        importPath: string,
        filePath: string,
        mappings: PathMapping[]
    ): string | null {
        if (importPath.startsWith('.')) {
            const documentDir = nodePath.dirname(filePath);
            const absolutePath = nodePath.resolve(documentDir, importPath);

            for (const mapping of mappings) {
                for (const mappedPath of mapping.paths) {
                    const mappedPattern = mappedPath
                        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
                        .replace(/\*/g, '(.*?)');
                    const regex = safeRegExp(`^${mappedPattern}$`);
                    if (!regex) { continue; }

                    const match = absolutePath.match(regex);
                    if (match) {
                        let captureIndex = 1;
                        const aliasPath = mapping.pattern.replace(/\*/g, () => {
                            const captured = match[captureIndex++] || '';
                            return captured.replace(/(\.d\.(?:cts|mts|ts)|\.(?:tsx?|jsx?))$/, '');
                        });

                        const isValidAlias = aliasPath.startsWith('@') ||
                                           aliasPath.startsWith('~') ||
                                           aliasPath.includes('/');

                        if (!isValidAlias) { continue; }

                        logDebug(`Converted relative to alias (batch): ${importPath} → ${aliasPath}`);
                        return aliasPath;
                    }
                }
            }
        } else {
            for (const mapping of mappings) {
                if (this.matchesPattern(importPath, mapping.pattern)) {
                    return null;
                }
            }
        }

        return null;
    }

    /**
     * Convert absolute (aliased) path to relative (batch, no VS Code APIs).
     */
    private convertToRelativeBatch(
        importPath: string,
        filePath: string,
        mappings: PathMapping[]
    ): string | null {
        for (const mapping of mappings) {
            if (this.matchesPattern(importPath, mapping.pattern)) {
                const resolvedPath = this.resolveAliasToPathWithFallbacksFs(importPath, mapping);
                if (resolvedPath) {
                    if (resolvedPath.includes('node_modules')) { continue; }

                    const documentDir = nodePath.dirname(filePath);
                    let relativePath = this.getRelativePathFs(documentDir, resolvedPath);

                    if (!relativePath.startsWith('.')) {
                        relativePath = './' + relativePath;
                    }

                    return relativePath;
                }
            }
        }

        return null;
    }

    /**
     * Check if an import path matches a pattern
     */
    private matchesPattern(importPath: string, pattern: string): boolean {
        const regexPattern = pattern
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*');
        const regex = safeRegExp(`^${regexPattern}$`);
        return regex ? regex.test(importPath) : false;
    }

    /**
     * Resolve an aliased import to an absolute file path (batch, fs.existsSync).
     */
    private resolveAliasToPathWithFallbacksFs(importPath: string, mapping: PathMapping): string | null {
        const pattern = mapping.pattern;
        const regexPattern = pattern
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '(.*?)');
        const regex = safeRegExp(`^${regexPattern}$`);
        if (!regex) { return null; }
        const match = importPath.match(regex);

        if (match && mapping.paths.length > 0) {
            for (const pathTemplate of mapping.paths) {
                let resolvedPath = pathTemplate;
                let captureIndex = 1;

                resolvedPath = resolvedPath.replace(/\*/g, () => {
                    return match[captureIndex++] || '';
                });

                const pathWithoutExt = resolvedPath.replace(/(\.d\.(?:cts|mts|ts)|\.(?:tsx?|jsx?))$/, '');

                if (this.checkFileExistsFs(pathWithoutExt)) {
                    logDebug(`Resolved ${importPath} to ${pathWithoutExt} (batch)`);
                    return pathWithoutExt;
                }
            }
        }

        return null;
    }

    /**
     * Calculate relative path between two directory/file paths (pure strings).
     */
    private getRelativePathFs(fromDir: string, toPath: string): string {
        const fromParts = fromDir.split(/[/\\]/).filter(p => p.length > 0);
        const toParts = toPath.split(/[/\\]/).filter(p => p.length > 0);

        let commonLength = 0;
        for (let i = 0; i < Math.min(fromParts.length, toParts.length); i++) {
            if (fromParts[i] === toParts[i]) {
                commonLength++;
            } else {
                break;
            }
        }

        const upCount = fromParts.length - commonLength;
        const downPath = toParts.slice(commonLength);

        const parts: string[] = [];
        for (let i = 0; i < upCount; i++) {
            parts.push('..');
        }
        parts.push(...downPath);

        return parts.join('/') || '.';
    }

    /**
     * Check if a file or directory exists (batch, fs.existsSync).
     */
    private checkFileExistsFs(basePath: string): boolean {
        const possibleExtensions = [
            '',
            '.ts',
            '.tsx',
            '.js',
            '.jsx',
            '.d.ts',
            '.d.cts',
            '.d.mts',
            '/index.ts',
            '/index.tsx',
            '/index.js',
            '/index.jsx',
            '/index.d.ts',
            '/index.d.cts',
            '/index.d.mts'
        ];

        for (const ext of possibleExtensions) {
            if (fs.existsSync(basePath + ext)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Clear caches
     */
    public clearCache(): void {
        this.configCache.clear();
    }
}
