import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface Divergence {
    path: string;
    cause: 'environment' | 'intentional' | 'core';
    avoidable: boolean;
    acceptable: boolean;
    cli: 'untouched';
    explanation: string;
}

const repoRoot = path.resolve(__dirname, '../..');
const cliPath = path.join(repoRoot, 'dist/cli.js');
const fixtureRoot = path.join(__dirname, 'fixtures/workspace');
const expectedRoot = path.join(__dirname, 'expected');
const divergences: Divergence[] = JSON.parse(fs.readFileSync(path.join(__dirname, 'divergences.json'), 'utf8'));

function listFiles(directory: string, base = directory): string[] {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const fullPath = path.join(directory, entry.name);
        return entry.isDirectory() ? listFiles(fullPath, base) : [path.relative(base, fullPath).split(path.sep).join('/')];
    });
}

function runCli(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [cliPath, ...args], { cwd, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const typescript7 = path.join(repoRoot, '.vscode-test/ts7/node_modules/typescript');
const variants: [string, string[]][] = [
    ['default options', []],
    ['three worker processes', ['--jobs', '3']],
    ['full TypeScript and ESLint analysis', ['--no-fast-analysis']],
];
if (fs.existsSync(path.join(typescript7, 'package.json'))) {
    variants.push(['TypeScript 7 native API', ['--typescript', typescript7]]);
}

describe.each(variants)('CLI output matches the output recorded in VS Code (%s)', (_label, extraArgs) => {
    const recordedFiles = listFiles(path.join(expectedRoot, 'src')).map((file) => `src/${file}`).sort();
    let workspace: string;
    let firstRun: ReturnType<typeof runCli>;

    beforeAll(() => {
        workspace = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tidyjs-compat-'))), 'workspace');
        fs.cpSync(fixtureRoot, workspace, { recursive: true });
        fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(workspace, 'node_modules'), 'dir');
        firstRun = runCli(workspace, ['--write', ...extraArgs, '--root', workspace, '.']);
    }, 120000);

    afterAll(() => {
        fs.rmSync(path.dirname(workspace), { recursive: true, force: true });
    });

    test('records every fixture file', () => {
        const fixtureFiles = listFiles(path.join(fixtureRoot, 'src'))
            .filter((file) => /\.(tsx?|jsx?)$/.test(file))
            .map((file) => `src/${file}`)
            .sort();
        expect(recordedFiles).toEqual(fixtureFiles);
    });

    test('documents every divergence with its cause', () => {
        for (const divergence of divergences) {
            expect(recordedFiles).toContain(divergence.path);
            expect(divergence.explanation.length).toBeGreaterThan(20);
        }
    });

    test('fails only on the syntax error and the invalid configuration', () => {
        expect(firstRun.status).toBe(2);
        const errorLines = firstRun.stderr.split('\n').filter((line) => line.startsWith('error  '));
        expect(errorLines).toHaveLength(2);
        expect(errorLines[0]).toContain('src/invalid-config/file.ts  config: Invalid configuration');
        expect(errorLines[1]).toContain('src/invalid/syntax-error.ts  parse: Syntax error during parsing');
        expect(firstRun.stderr).not.toContain('warning');
    });

    test.each(recordedFiles)('%s', (file) => {
        const vscodeOutput = fs.readFileSync(path.join(expectedRoot, file), 'utf8');
        const cliOutput = fs.readFileSync(path.join(workspace, file), 'utf8');
        const divergence = divergences.find((entry) => entry.path === file);

        if (!divergence) {
            expect(cliOutput).toBe(vscodeOutput);
            return;
        }

        expect(cliOutput).not.toBe(vscodeOutput);
        expect(cliOutput).toBe(fs.readFileSync(path.join(fixtureRoot, file), 'utf8'));
    });

    test('a second run has nothing left to format', () => {
        const secondRun = runCli(workspace, ['--check', ...extraArgs, '--root', workspace, '.']);
        expect(secondRun.stderr).toContain(': 0 to format,');
    });
});
