import * as fs from 'fs';
import * as path from 'path';

import { formatSource, isFileInExcludedFolder, ParserCache } from './core/pipeline';
import { logDebug, logError } from './utils/log';

import type { FailureStage, UnchangedReason } from './core/pipeline';
import type { ImportParser } from './parser';
import type { Config } from './types';

export { isFileInExcludedFolder };

// --- Types ---

interface BatchFormatResult {
    formatted: number;
    skipped: number;
    errors: { filePath: string; error: string }[];
    totalFiles: number;
}

interface BatchFormatCallbacks {
    onProgress: (current: number, total: number, filePath: string) => void;
    isCancelled: () => boolean;
    resolveConfig: (filePath: string) => Promise<Config>;
    fallbackConfig: () => Config;
}

// --- Constants ---

export const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);

export const ALWAYS_SKIP_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', 'out',
    '.next', 'coverage', '.cache', '.turbo',
]);

// --- Internal functions ---

export async function discoverFiles(folderPath: string): Promise<string[]> {
    const files: string[] = [];
    const visited = new Set<string>();

    async function walk(dir: string): Promise<void> {
        let realDir: string;
        try {
            realDir = await fs.promises.realpath(dir);
        } catch {
            return;
        }

        if (visited.has(realDir)) {
            return;
        }
        visited.add(realDir);

        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                if (!ALWAYS_SKIP_DIRS.has(entry.name)) {
                    await walk(fullPath);
                }
            } else if (entry.isFile()) {
                const ext = path.extname(entry.name).toLowerCase();
                if (SUPPORTED_EXTENSIONS.has(ext)) {
                    files.push(fullPath);
                }
            }
        }
    }

    await walk(folderPath);
    return files;
}

interface SingleFileResult {
    changed: boolean;
    error?: string;
    skipReason?: UnchangedReason;
}

export async function formatSingleFile(
    filePath: string,
    config: Config,
    parserCache: Map<string, ImportParser>,
    workspaceRoot?: string
): Promise<SingleFileResult> {
    let sourceText: string;
    try {
        sourceText = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
        return { changed: false, error: `Failed to read file: ${error}` };
    }

    const outcome = await formatSource({
        text: sourceText,
        filePath,
        config,
        workspaceRoot,
        parsers: new ParserCache(parserCache),
        profile: 'folder',
    });

    if (outcome.status === 'unchanged') {
        return { changed: false, skipReason: outcome.reason };
    }

    if (outcome.status === 'failed') {
        return { changed: false, error: describeFailure(outcome.stage, outcome.message) };
    }

    try {
        await fs.promises.writeFile(filePath, outcome.text, 'utf8');
    } catch (error) {
        return { changed: false, error: `Failed to write file: ${error}` };
    }

    return { changed: true };
}

function describeFailure(stage: FailureStage, message: string): string {
    switch (stage) {
        case 'invalid-imports':
            return `Invalid imports: ${message}`;
        case 'format':
            return `Format error: ${message}`;
        case 'validation':
            return `Post-format validation failed: ${message}`;
        default:
            return `Parse error: ${message}`;
    }
}

// --- Main export ---

export async function formatFolder(
    folderPath: string,
    workspaceRoot: string | undefined,
    callbacks: BatchFormatCallbacks
): Promise<BatchFormatResult> {
    const result: BatchFormatResult = {
        formatted: 0,
        skipped: 0,
        errors: [],
        totalFiles: 0,
    };

    const parserCache = new Map<string, ImportParser>();
    const skipCounts: Record<string, number> = {};

    function trackSkip(reason: string, filePath: string): void {
        skipCounts[reason] = (skipCounts[reason] || 0) + 1;
        result.skipped++;
        logDebug(`  SKIP [${reason}] ${filePath}`);
    }

    try {
        logDebug(`Batch format: discovering files in ${folderPath}`);
        const files = await discoverFiles(folderPath);
        result.totalFiles = files.length;
        logDebug(`Batch format: found ${files.length} files`);

        for (let i = 0; i < files.length; i++) {
            if (callbacks.isCancelled()) {
                logDebug(`Batch format: cancelled at file ${i + 1}/${files.length}`);
                break;
            }

            const filePath = files[i];
            const relativePath = workspaceRoot
                ? path.relative(workspaceRoot, filePath)
                : path.basename(filePath);
            callbacks.onProgress(i + 1, files.length, filePath);

            // Load config for this specific file
            let config: Config;
            try {
                config = await callbacks.resolveConfig(filePath);
            } catch (error) {
                logError(`Batch format: failed to load config for ${filePath}:`, error);
                config = callbacks.fallbackConfig();
            }

            // Check excluded folders
            if (isFileInExcludedFolder(filePath, config, workspaceRoot)) {
                trackSkip('excluded', relativePath);
                continue;
            }

            // Format the file
            const formatResult = await formatSingleFile(filePath, config, parserCache, workspaceRoot);

            if (formatResult.error) {
                result.errors.push({ filePath, error: formatResult.error });
                logDebug(`  ERROR ${relativePath}: ${formatResult.error}`);
            } else if (formatResult.changed) {
                result.formatted++;
                logDebug(`  FORMATTED ${relativePath}`);
            } else {
                trackSkip(formatResult.skipReason ?? 'unchanged', relativePath);
            }
        }
    } finally {
        // Dispose all cached parsers
        for (const parser of parserCache.values()) {
            parser.dispose();
        }
        parserCache.clear();
    }

    // Detailed summary
    const skipDetails = Object.entries(skipCounts)
        .map(([reason, count]) => `${reason}: ${count}`)
        .join(', ');
    logDebug(`Batch format complete: ${result.formatted} formatted, ${result.skipped} skipped (${skipDetails || 'none'}), ${result.errors.length} errors`);
    return result;
}
