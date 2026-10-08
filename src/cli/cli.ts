import * as fs from 'fs';
import * as path from 'path';

import { createSettingsReader, getSettingsSection } from '../core/settings';
import { setLogSink } from '../utils/log';
import { HELP_TEXT, parseCliArguments, UsageError } from './args';
import { CliDiagnostics, LazyEslintLinter, LocalEslintLinter } from './diagnostics';
import { EslintDiagnosticsProvider, readEslintEditorSettings } from './eslint-diagnostics';
import { RemoteEslintLinter } from './eslint-host';
import { expandTargets } from './files';
import { gitSelectedFiles } from './git';
import { automaticJobCount, runInWorkers } from './parallel';
import { Reporter } from './reporter';
import { FileRunner } from './runner';
import { readTypeScriptEditorSettings, TypeScriptDiagnosticsProvider } from './typescript-diagnostics';
import { createCliWorkspace, findWorkspaceRoot } from './workspace';

import type { CliArguments } from './args';
import type { EslintLinter } from './eslint-host';
import type { WorkerTask } from './parallel';
import type { OutputStreams } from './reporter';
import type { FileReport } from './runner';

export interface CliEnvironment extends OutputStreams {
    cwd: string;
    packageJson: { version?: string; contributes?: unknown };
    fallbackModulesDir?: string;
    selfScript?: string;
}

export const EXIT_SUCCESS = 0;
export const EXIT_CHECK_FAILED = 1;
export const EXIT_ERROR = 2;

interface SessionOptions {
    args: CliArguments;
    root: string;
    packageJson: CliEnvironment['packageJson'];
    fallbackModulesDir?: string;
    selfScript?: string;
}

interface Session {
    run(filePath: string): Promise<FileReport>;
    prepare(files: string[]): Promise<void>;
    dispose(): Promise<void>;
}

function installLogSink(args: CliArguments, write: (text: string) => void): void {
    setLogSink({
        isDebugEnabled: () => args.debug,
        debug: (message) => write(`${message}\n`),
        error: (message) => {
            if (args.debug || args.verbose) {
                write(`${message}\n`);
            }
        },
    });
}

function createSession(options: SessionOptions): Session {
    const { args, root } = options;
    const workspace = createCliWorkspace(root, options.packageJson);
    const settingsSection = (section: string) => createSettingsReader(getSettingsSection(workspace.settings, section));

    const typescript = args.typescript
        ? new TypeScriptDiagnosticsProvider(options.fallbackModulesDir, readTypeScriptEditorSettings({
            typescript: settingsSection('typescript'),
            javascript: settingsSection('javascript'),
            jsts: settingsSection('js/ts'),
        }), args.typescriptPath ? path.resolve(args.typescriptPath) : undefined)
        : undefined;

    let eslint: EslintLinter | undefined;
    if (args.eslint) {
        const eslintSettings = readEslintEditorSettings(workspace.eslintSettings);
        const selfScript = options.selfScript;
        eslint = new LazyEslintLinter(() => selfScript
            ? new RemoteEslintLinter(selfScript, eslintSettings)
            : new LocalEslintLinter(new EslintDiagnosticsProvider(eslintSettings)));
    }

    const diagnostics = typescript || eslint ? new CliDiagnostics(typescript, eslint, args.fastAnalysis) : undefined;
    const runner = new FileRunner(workspace, diagnostics, {
        mode: args.mode,
        profile: args.profile,
        keepContents: args.diff,
    }, eslint);

    return {
        run: (filePath) => runner.run(filePath),
        prepare: async (files) => {
            if (args.profile !== 'editor' || files.length === 0) {
                return;
            }
            typescript?.prepare(files);
            if (!eslint || args.fastAnalysis) {
                return;
            }
            eslint.warm(files[0], workspace.rootFor(files[0]));
            const needed: { filePath: string; workspaceRoot: string | undefined }[] = [];
            for (const filePath of files) {
                if (await runner.needsUnusedImportDiagnostics(filePath)) {
                    needed.push({ filePath, workspaceRoot: workspace.rootFor(filePath) });
                }
            }
            eslint.prefetch(needed);
        },
        dispose: async () => {
            runner.dispose();
            eslint?.dispose();
            await typescript?.dispose();
        },
    };
}

function internalError(filePath: string, error: unknown): FileReport {
    return {
        filePath,
        status: 'error',
        written: false,
        errorStage: 'internal',
        message: error instanceof Error ? error.message : String(error),
        warnings: [],
        removedUnused: [],
        removedMissing: [],
        sources: [],
    };
}

async function runSequentially(options: SessionOptions, files: string[], onReport: (index: number, report: FileReport) => void): Promise<void> {
    const session = createSession(options);
    try {
        await session.prepare(files);
        for (const [index, filePath] of files.entries()) {
            try {
                onReport(index, await session.run(filePath));
            } catch (error) {
                onReport(index, internalError(filePath, error));
            }
        }
    } finally {
        await session.dispose();
    }
}

export function runWorker(): void {
    process.once('message', async (task: WorkerTask<SessionOptions>) => {
        installLogSink(task.options.args, (text) => process.stderr.write(text));
        await runSequentially(task.options, task.files, (index, report) => {
            process.send?.({ type: 'report', index, report });
        });
        process.send?.({ type: 'done' });
    });
}

export async function runCli(argv: string[], environment: CliEnvironment): Promise<number> {
    let args: CliArguments;
    try {
        args = parseCliArguments(argv);
    } catch (error) {
        if (error instanceof UsageError) {
            environment.stderr(`error  ${error.message}\n\n${HELP_TEXT}\n`);
            return EXIT_ERROR;
        }
        throw error;
    }

    if (args.help) {
        environment.stdout(`${HELP_TEXT}\n`);
        return EXIT_SUCCESS;
    }
    if (args.version) {
        environment.stdout(`${environment.packageJson.version ?? 'unknown'}\n`);
        return EXIT_SUCCESS;
    }

    installLogSink(args, environment.stderr);

    const root = path.resolve(environment.cwd, args.root ?? findWorkspaceRoot(environment.cwd));
    const workspace = createCliWorkspace(root, environment.packageJson);
    const reporter = new Reporter(args, environment.cwd, environment);

    if (args.verbose) {
        environment.stderr(`workspace root: ${root}${workspace.settingsPath ? ` (settings: ${workspace.settingsPath})` : ''}\n`);
    }
    if (workspace.settingsWarning) {
        reporter.warning(workspace.settingsWarning);
    }

    const expansion = await expandTargets(args.targets, environment.cwd);
    for (const missing of expansion.missing) {
        reporter.error(`${missing}  no such file, directory or matching file`);
    }
    for (const unsupported of expansion.unsupported) {
        if (args.verbose) {
            environment.stdout(`skipped  ${reporter.display(unsupported)}  (unsupported file type)\n`);
        }
    }

    let files = expansion.files;
    if (args.gitSelection) {
        let selected: Set<string>;
        try {
            selected = gitSelectedFiles(environment.cwd, args.gitSelection);
        } catch (error) {
            reporter.error(error instanceof Error ? error.message : String(error));
            return EXIT_ERROR;
        }
        files = files.filter((file) => selected.has(fs.realpathSync(file)));
    }

    const sessionOptions: SessionOptions = {
        args,
        root,
        packageJson: environment.packageJson,
        fallbackModulesDir: environment.fallbackModulesDir,
        selfScript: environment.selfScript,
    };

    const usesDiagnostics = args.profile === 'editor' && (args.typescript || args.eslint);
    const jobs = !environment.selfScript ? 1 : Math.min(files.length, args.jobs ?? (usesDiagnostics ? automaticJobCount(files.length) : 1)) || 1;

    const reports: (FileReport | undefined)[] = new Array(files.length);
    let nextToPrint = 0;
    const onReport = (index: number, report: FileReport) => {
        reports[index] = report;
        while (nextToPrint < files.length && reports[nextToPrint]) {
            reporter.file(reports[nextToPrint]!);
            nextToPrint++;
        }
    };

    if (jobs > 1) {
        await runInWorkers(environment.selfScript!, sessionOptions, files, jobs, onReport);
        for (let index = nextToPrint; index < files.length; index++) {
            if (!reports[index]) {
                onReport(index, internalError(files[index], new Error('the worker processing this file stopped unexpectedly')));
            }
        }
    } else {
        await runSequentially(sessionOptions, files, onReport);
    }

    reporter.finish();

    if (reporter.summary.errors > 0 || expansion.missing.length > 0) {
        return EXIT_ERROR;
    }
    if (args.mode === 'check' && reporter.summary.changed > 0) {
        return EXIT_CHECK_FAILED;
    }
    return EXIT_SUCCESS;
}
