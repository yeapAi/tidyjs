import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'tinyglobby';

import { ALWAYS_SKIP_DIRS, discoverFiles, SUPPORTED_EXTENSIONS } from '../batch-formatter';

export interface TargetExpansion {
    files: string[];
    unsupported: string[];
    missing: string[];
}

const GLOB_CHARACTERS = /[*?[\]{}!]/;

export function isGlobPattern(target: string): boolean {
    return GLOB_CHARACTERS.test(target);
}

export function isSupportedFile(filePath: string): boolean {
    return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function isInsideSkippedDirectory(filePath: string, baseDir: string): boolean {
    const relative = path.relative(baseDir, filePath);
    return relative.split(path.sep).slice(0, -1).some((segment) => ALWAYS_SKIP_DIRS.has(segment));
}

async function expandGlob(pattern: string, cwd: string): Promise<string[]> {
    const matches = await glob(pattern.replace(/\\/g, '/'), {
        cwd,
        absolute: true,
        onlyFiles: true,
        dot: true,
        ignore: [...ALWAYS_SKIP_DIRS].map((dir) => `**/${dir}/**`),
    });
    return matches
        .map((match) => path.resolve(match))
        .filter((match) => isSupportedFile(match) && !isInsideSkippedDirectory(match, cwd));
}

export async function expandTargets(targets: string[], cwd: string): Promise<TargetExpansion> {
    const files = new Set<string>();
    const unsupported: string[] = [];
    const missing: string[] = [];

    for (const target of targets) {
        const absolute = path.resolve(cwd, target);
        let stat: fs.Stats | undefined;
        try {
            stat = await fs.promises.stat(absolute);
        } catch {
            stat = undefined;
        }

        if (stat?.isDirectory()) {
            for (const file of await discoverFiles(absolute)) {
                files.add(path.resolve(file));
            }
        } else if (stat?.isFile()) {
            if (isSupportedFile(absolute)) {
                files.add(absolute);
            } else {
                unsupported.push(absolute);
            }
        } else if (isGlobPattern(target)) {
            const matches = await expandGlob(target, cwd);
            if (matches.length === 0) {
                missing.push(target);
            }
            for (const match of matches) {
                files.add(match);
            }
        } else {
            missing.push(target);
        }
    }

    return {
        files: [...files].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        unsupported,
        missing,
    };
}
