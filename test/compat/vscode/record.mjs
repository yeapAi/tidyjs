import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureRoot = path.join(repoRoot, 'test/compat/fixtures/workspace');
const expectedRoot = path.join(repoRoot, 'test/compat/expected');
const scratchRoot = path.join(repoRoot, '.vscode-test/compat');
const externalWorkspace = process.env.TIDYJS_COMPAT_WORKSPACE;
const workspaceCopy = externalWorkspace ?? path.join(scratchRoot, 'workspace');
const userDataDir = path.join(scratchRoot, 'ud');
const extensionsDir = path.join(scratchRoot, 'ext');
const outputDir = process.env.TIDYJS_COMPAT_OUT_DIR ?? path.join(scratchRoot, 'out');

const SUPPORTED = new Set(['.ts', '.tsx', '.js', '.jsx']);

function listFixtureFiles(directory, base = directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            return entry.name === 'node_modules' ? [] : listFixtureFiles(fullPath, base);
        }
        return SUPPORTED.has(path.extname(entry.name)) && !entry.name.endsWith('.config.mjs')
            ? [path.relative(base, fullPath).split(path.sep).join('/')]
            : [];
    }).sort();
}

function findEslintExtension() {
    if (process.env.TIDYJS_ESLINT_EXTENSION) {
        return process.env.TIDYJS_ESLINT_EXTENSION;
    }
    const userExtensions = path.join(os.homedir(), '.vscode', 'extensions');
    const candidates = fs.existsSync(userExtensions)
        ? fs.readdirSync(userExtensions).filter((name) => name.startsWith('dbaeumer.vscode-eslint-')).sort()
        : [];
    if (candidates.length === 0) {
        throw new Error('ESLint extension not found. Install dbaeumer.vscode-eslint or set TIDYJS_ESLINT_EXTENSION.');
    }
    return path.join(userExtensions, candidates[candidates.length - 1]);
}

function prepare() {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
    if (!externalWorkspace) {
        fs.cpSync(fixtureRoot, workspaceCopy, { recursive: true });
        fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(workspaceCopy, 'node_modules'), 'dir');
    }

    const eslintExtension = findEslintExtension();
    fs.mkdirSync(extensionsDir, { recursive: true });
    fs.cpSync(eslintExtension, path.join(extensionsDir, path.basename(eslintExtension)), { recursive: true });

    const tsdk = path.join(workspaceCopy, 'node_modules', 'typescript', 'lib');
    fs.mkdirSync(path.join(userDataDir, 'User'), { recursive: true });
    fs.writeFileSync(path.join(userDataDir, 'User', 'settings.json'), JSON.stringify({
        'security.workspace.trust.enabled': false,
        'typescript.tsdk': tsdk,
        'js/ts.tsdk.path': tsdk,
        'typescript.locale': 'en',
        'extensions.autoUpdate': false,
        'extensions.autoCheckUpdates': false,
        'telemetry.telemetryLevel': 'off',
        'workbench.startupEditor': 'none',
    }, null, 2));
}

async function main() {
    const files = process.env.TIDYJS_COMPAT_FILE_LIST
        ? fs.readFileSync(process.env.TIDYJS_COMPAT_FILE_LIST, 'utf8').split('\n').filter(Boolean)
        : listFixtureFiles(fixtureRoot);
    prepare();

    const vscodeExecutablePath = process.env.VSCODE_E2E_EXECUTABLE
        ?? (process.platform === 'darwin' && fs.existsSync('/Applications/Visual Studio Code.app/Contents/MacOS/Code')
            ? '/Applications/Visual Studio Code.app/Contents/MacOS/Code'
            : await downloadAndUnzipVSCode('stable'));

    await runTests({
        vscodeExecutablePath,
        extensionDevelopmentPath: repoRoot,
        extensionTestsPath: path.join(repoRoot, 'test/compat/vscode/suite.cjs'),
        extensionTestsEnv: {
            TIDYJS_COMPAT_OUT: outputDir,
            TIDYJS_COMPAT_FILES: JSON.stringify(files),
            TIDYJS_COMPAT_WARMUP: process.env.TIDYJS_COMPAT_WARMUP ?? 'src/unused/single-specifiers.ts',
        },
        launchArgs: [
            workspaceCopy,
            '--user-data-dir', userDataDir,
            '--extensions-dir', extensionsDir,
            '--disable-workspace-trust',
            '--disable-gpu',
            '--skip-welcome',
            '--skip-release-notes',
        ],
    });

    if (externalWorkspace) {
        console.log(`Recorded ${files.length} files from VS Code into ${outputDir}`);
        return;
    }
    fs.rmSync(expectedRoot, { recursive: true, force: true });
    fs.cpSync(outputDir, expectedRoot, { recursive: true });
    console.log(`Recorded ${files.length} files from VS Code into ${path.relative(repoRoot, expectedRoot)}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
