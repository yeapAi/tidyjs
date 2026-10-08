import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type * as TS from 'typescript';

type TypeScriptModule = typeof TS;

interface FileSystemEntries {
    files: string[];
    directories: string[];
}

type MatchFiles = (
    root: string,
    extensions: readonly string[] | undefined,
    excludes: readonly string[] | undefined,
    includes: readonly string[] | undefined,
    useCaseSensitiveFileNames: boolean,
    currentDirectory: string,
    depth: number | undefined,
    getEntries: (directory: string) => FileSystemEntries,
    realpath: (file: string) => string
) => string[];

export type ParsedConfig = Pick<TS.ParsedCommandLine, 'options' | 'fileNames' | 'projectReferences'>;

interface Stamp {
    path: string;
    mtimeMs: number;
    size: number;
}

interface CacheEntry {
    key: string;
    files: Stamp[];
    absent: string[];
    directories: Stamp[];
    result: ParsedConfig;
}

export const TSCONFIG_CACHE_DIR = path.join(os.tmpdir(), 'tidyjs-tsconfig-cache');

function stampOf(file: string): Stamp | undefined {
    try {
        const stat = fs.statSync(file);
        return { path: file, mtimeMs: stat.mtimeMs, size: stat.isDirectory() ? 0 : stat.size };
    } catch {
        return undefined;
    }
}

function isFresh(entry: CacheEntry): boolean {
    for (const recorded of [...entry.files, ...entry.directories]) {
        const current = stampOf(recorded.path);
        if (!current || current.mtimeMs !== recorded.mtimeMs || current.size !== recorded.size) {
            return false;
        }
    }
    return entry.absent.every((file) => !fs.existsSync(file));
}

function readEntry(cacheFile: string, key: string): CacheEntry | undefined {
    try {
        const entry = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as CacheEntry;
        return entry.key === key && isFresh(entry) ? entry : undefined;
    } catch {
        return undefined;
    }
}

function writeEntry(cacheFile: string, entry: CacheEntry): void {
    try {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        const temporary = `${cacheFile}.${process.pid}.tmp`;
        fs.writeFileSync(temporary, JSON.stringify(entry));
        fs.renameSync(temporary, cacheFile);
    } catch {
        return;
    }
}

function fileSystemEntries(directory: string): FileSystemEntries {
    const files: string[] = [];
    const directories: string[] = [];
    let dirents: fs.Dirent[];
    try {
        dirents = fs.readdirSync(directory || '.', { withFileTypes: true });
    } catch {
        return { files, directories };
    }
    for (const dirent of dirents) {
        let kind: fs.Dirent | fs.Stats = dirent;
        if (dirent.isSymbolicLink()) {
            try {
                kind = fs.statSync(path.join(directory, dirent.name));
            } catch {
                continue;
            }
        }
        if (kind.isFile()) {
            files.push(dirent.name);
        } else if (kind.isDirectory()) {
            directories.push(dirent.name);
        }
    }
    files.sort();
    directories.sort();
    return { files, directories };
}

export function parseConfigWithCache(ts: TypeScriptModule, configPath: string, existingOptions: TS.CompilerOptions | undefined, cacheDir = TSCONFIG_CACHE_DIR): ParsedConfig | null {
    const matchFiles = (ts as unknown as { matchFiles?: MatchFiles }).matchFiles;
    const key = JSON.stringify([ts.version, path.resolve(configPath), existingOptions ?? null]);
    const cacheFile = path.join(cacheDir, `${crypto.createHash('sha1').update(key).digest('hex')}.json`);

    if (typeof matchFiles === 'function') {
        const cached = readEntry(cacheFile, key);
        if (cached) {
            return cached.result;
        }
    }

    const readFiles = new Set<string>();
    const absent = new Set<string>();
    const visited = new Set<string>();
    const host: TS.ParseConfigFileHost = {
        useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
        getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
        fileExists: (file) => {
            const exists = ts.sys.fileExists(file);
            if (!exists) {
                absent.add(file);
            }
            return exists;
        },
        readFile: (file) => {
            const text = ts.sys.readFile(file);
            if (text === undefined) {
                absent.add(file);
            } else {
                readFiles.add(file);
            }
            return text;
        },
        readDirectory: (root, extensions, excludes, includes, depth) => {
            if (typeof matchFiles !== 'function') {
                return ts.sys.readDirectory(root, extensions, excludes, includes, depth);
            }
            return matchFiles(root, extensions, excludes, includes, ts.sys.useCaseSensitiveFileNames, process.cwd(), depth, (directory) => {
                visited.add(path.resolve(directory || '.'));
                return fileSystemEntries(directory);
            }, (file) => (ts.sys.realpath ? ts.sys.realpath(file) : file));
        },
        onUnRecoverableConfigFileDiagnostic: () => undefined,
    };

    let parsed: TS.ParsedCommandLine | undefined;
    try {
        parsed = ts.getParsedCommandLineOfConfigFile(configPath, existingOptions, host);
    } catch {
        parsed = undefined;
    }
    if (!parsed) {
        return null;
    }

    const options: TS.CompilerOptions = { ...parsed.options };
    delete options.configFile;
    const result: ParsedConfig = { options, fileNames: parsed.fileNames, projectReferences: parsed.projectReferences };

    if (typeof matchFiles === 'function') {
        writeEntry(cacheFile, {
            key,
            files: [...readFiles].map(stampOf).filter((stamp): stamp is Stamp => stamp !== undefined),
            absent: [...absent],
            directories: [...visited].map(stampOf).filter((stamp): stamp is Stamp => stamp !== undefined),
            result,
        });
    }
    return result;
}
