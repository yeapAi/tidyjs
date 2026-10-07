import { parseArgs } from 'util';

import type { FormatProfile } from '../core/pipeline';
import type { RunMode } from './runner';

export interface CliArguments {
    targets: string[];
    mode: RunMode;
    jobs?: number;
    gitSelection?: 'changed' | 'staged';
    typescriptPath?: string;
    fastAnalysis: boolean;
    diff: boolean;
    root?: string;
    profile: FormatProfile;
    typescript: boolean;
    eslint: boolean;
    verbose: boolean;
    quiet: boolean;
    debug: boolean;
    help: boolean;
    version: boolean;
}

export class UsageError extends Error {}

export const HELP_TEXT = `Usage: tidyjs [options] <file | directory | glob>...

Organizes imports with the engine, configuration and diagnostics rules of
the TidyJS VS Code extension (format on save).
Without --write or --check, files are only reported, never modified.

Modes:
  -w, --write            Write the formatted files
  -c, --check            Exit with code 1 when a file would change
      --diff             Print a unified diff of every change

Context:
      --root <dir>       Workspace root, as the folder opened in VS Code
                         (default: nearest ancestor with .git or .vscode)
      --profile <name>   "editor" (format on save, default) or "folder"
                         (Format Folder command: no diagnostics)
      --no-typescript    Do not compute TypeScript diagnostics
      --no-eslint        Do not run ESLint
      --no-diagnostics   Same as --no-typescript --no-eslint
      --no-fast-analysis Always run the TypeScript checker and ESLint instead of
                         deciding unused and missing imports from syntax first
      --typescript <dir> Use this TypeScript package instead of the project's
                         (TypeScript 7 runs through its native API)

Selection and speed:
      --changed          Only files changed since HEAD, plus untracked files
      --staged           Only staged files
  -j, --jobs <n>         Worker processes (default: automatic, 1 for small runs)

Output:
  -v, --verbose          Report unchanged and skipped files, diagnostics sources
  -q, --quiet            Only report errors
      --debug            Print TidyJS debug logs to stderr
  -h, --help             Show this help
      --version          Show the version

Exit codes: 0 success, 1 --check found files to format, 2 errors.`;

export function parseCliArguments(argv: string[]): CliArguments {
    let parsed;
    try {
        parsed = parseArgs({
            args: argv,
            allowPositionals: true,
            strict: true,
            options: {
                write: { type: 'boolean', short: 'w' },
                check: { type: 'boolean', short: 'c' },
                diff: { type: 'boolean' },
                root: { type: 'string' },
                profile: { type: 'string' },
                'no-typescript': { type: 'boolean' },
                'no-eslint': { type: 'boolean' },
                'no-diagnostics': { type: 'boolean' },
                'no-fast-analysis': { type: 'boolean' },
                typescript: { type: 'string' },
                changed: { type: 'boolean' },
                staged: { type: 'boolean' },
                jobs: { type: 'string', short: 'j' },
                verbose: { type: 'boolean', short: 'v' },
                quiet: { type: 'boolean', short: 'q' },
                debug: { type: 'boolean' },
                help: { type: 'boolean', short: 'h' },
                version: { type: 'boolean' },
            },
        });
    } catch (error) {
        throw new UsageError(error instanceof Error ? error.message : String(error));
    }

    const { values, positionals } = parsed;

    if (values.write && values.check) {
        throw new UsageError('--write and --check cannot be used together');
    }
    if (values.verbose && values.quiet) {
        throw new UsageError('--verbose and --quiet cannot be used together');
    }

    const profile = values.profile ?? 'editor';
    if (profile !== 'editor' && profile !== 'folder') {
        throw new UsageError(`Unknown profile "${profile}". Use "editor" or "folder".`);
    }

    if (values.changed && values.staged) {
        throw new UsageError('--changed and --staged cannot be used together');
    }
    const gitSelection = values.changed ? 'changed' : values.staged ? 'staged' : undefined;

    let jobs: number | undefined;
    if (values.jobs !== undefined) {
        jobs = Number(values.jobs);
        if (!Number.isInteger(jobs) || jobs < 1) {
            throw new UsageError(`--jobs expects a positive integer, got "${values.jobs}"`);
        }
    }

    const help = values.help === true;
    const version = values.version === true;
    if (!help && !version && positionals.length === 0 && !gitSelection) {
        throw new UsageError('No file, directory or glob given. Use "tidyjs ." to process the current directory.');
    }

    return {
        targets: positionals.length > 0 ? positionals : ['.'],
        jobs,
        gitSelection,
        typescriptPath: values.typescript,
        fastAnalysis: !values['no-fast-analysis'],
        mode: values.write ? 'write' : values.check ? 'check' : 'list',
        diff: values.diff === true,
        root: values.root,
        profile,
        typescript: !values['no-typescript'] && !values['no-diagnostics'],
        eslint: !values['no-eslint'] && !values['no-diagnostics'],
        verbose: values.verbose === true,
        quiet: values.quiet === true,
        debug: values.debug === true,
        help,
        version,
    };
}
