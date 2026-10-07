import { execFileSync } from 'child_process';
import * as path from 'path';

export type GitSelection = 'changed' | 'staged';

function git(cwd: string, args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

function nulSeparated(output: string): string[] {
    return output.split('\0').filter(Boolean);
}

export function gitSelectedFiles(cwd: string, selection: GitSelection): Set<string> {
    let topLevel: string;
    try {
        topLevel = git(cwd, ['rev-parse', '--show-toplevel']).trim();
    } catch {
        throw new Error(`--${selection} needs a Git repository, and ${cwd} is not inside one`);
    }

    const relativePaths = new Set<string>();
    if (selection === 'staged') {
        for (const file of nulSeparated(git(topLevel, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']))) {
            relativePaths.add(file);
        }
    } else {
        let tracked: string;
        try {
            tracked = git(topLevel, ['diff', 'HEAD', '--name-only', '-z', '--diff-filter=ACMR']);
        } catch {
            tracked = git(topLevel, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']);
        }
        for (const file of nulSeparated(tracked)) {
            relativePaths.add(file);
        }
        for (const file of nulSeparated(git(topLevel, ['ls-files', '--others', '--exclude-standard', '-z']))) {
            relativePaths.add(file);
        }
    }

    return new Set([...relativePaths].map((file) => path.resolve(topLevel, file)));
}
