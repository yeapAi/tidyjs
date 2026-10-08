import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { runCli } from '../../src/cli/cli';
import { setLogSink } from '../../src/utils/log';

const repoRoot = path.resolve(__dirname, '../..');
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

const UNFORMATTED = "import { b } from 'b';\nimport { a, aa } from 'a';\n\nexport const x = [a, aa, b];\n";
const FORMATTED = "// Other\nimport {\n    a,\n    aa\n}            from 'a';\nimport { b } from 'b';\n\nexport const x = [a, aa, b];\n";

describe('runCli', () => {
    let root: string;
    let stdout: string;
    let stderr: string;

    function write(relativePath: string, content: string): string {
        const fullPath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, 'utf8');
        return fullPath;
    }

    function read(relativePath: string): string {
        return fs.readFileSync(path.join(root, relativePath), 'utf8');
    }

    async function run(argv: string[], fallbackModulesDir: string | null = repoRoot): Promise<number> {
        stdout = '';
        stderr = '';
        return runCli(['--root', root, '--no-eslint', ...argv], {
            cwd: root,
            stdout: (text) => { stdout += text; },
            stderr: (text) => { stderr += text; },
            packageJson,
            fallbackModulesDir: fallbackModulesDir ?? undefined,
        });
    }

    beforeEach(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tidyjs-cli-')));
    });

    afterEach(() => {
        setLogSink(null);
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('lists files without writing by default', async () => {
        write('src/a.ts', UNFORMATTED);

        expect(await run(['src'])).toBe(0);
        expect(stdout).toBe('would format  src/a.ts\n');
        expect(stderr).toContain('1 file(s): 1 to format');
        expect(read('src/a.ts')).toBe(UNFORMATTED);
    });

    test('--check fails while files need formatting and passes after --write', async () => {
        write('src/a.ts', UNFORMATTED);

        expect(await run(['--check', '.'])).toBe(1);
        expect(await run(['--write', '.'])).toBe(0);
        expect(stdout).toBe('formatted  src/a.ts\n');
        expect(read('src/a.ts')).toBe(FORMATTED);
        expect(await run(['--check', '.'])).toBe(0);
    });

    test('--diff prints a unified diff', async () => {
        write('src/a.ts', UNFORMATTED);

        await run(['--diff', 'src/a.ts']);
        expect(stdout).toContain('--- src/a.ts\n+++ src/a.ts\n');
        expect(stdout).toContain("+}            from 'a';");
    });

    test('applies tidyjs settings from .vscode/settings.json', async () => {
        write('.vscode/settings.json', '{\n  // jsonc\n  "tidyjs.format.bracketSpacing": false,\n}\n');
        write('a.ts', UNFORMATTED);

        await run(['--write', 'a.ts']);
        expect(read('a.ts')).toContain("import {b} from 'b';");
    });

    test('reports an invalid configuration as an error and leaves the file untouched', async () => {
        write('tidyjs.json', JSON.stringify({ groups: [{ name: 'A', default: true }, { name: 'B', default: true }] }));
        write('a.ts', UNFORMATTED);

        expect(await run(['--write', 'a.ts'])).toBe(2);
        expect(stderr).toMatch(/error {2}a\.ts {2}config: Invalid configuration \(.*tidyjs\.json\): Multiple groups are marked as default/);
        expect(read('a.ts')).toBe(UNFORMATTED);
    });

    test('reports a syntax error and leaves the file untouched', async () => {
        write('broken.ts', "import { b } from 'b';\nconst = 1;\n");

        expect(await run(['--write', 'broken.ts'])).toBe(2);
        expect(stderr).toContain('error  broken.ts  parse: Syntax error during parsing');
        expect(read('broken.ts')).toBe("import { b } from 'b';\nconst = 1;\n");
    });

    test('skips excluded folders, ignored files and reports unknown targets', async () => {
        write('tidyjs.json', JSON.stringify({ excludedFolders: ['legacy'] }));
        write('legacy/a.ts', UNFORMATTED);
        write('ignored.ts', `// tidyjs-ignore\n${UNFORMATTED}`);

        expect(await run(['--write', '--verbose', 'legacy', 'ignored.ts', 'missing-dir'])).toBe(2);
        expect(stdout).toContain('skipped  legacy/a.ts  (excluded)');
        expect(stdout).toContain('skipped  ignored.ts  (ignored)');
        expect(stderr).toContain('error  missing-dir  no such file, directory or matching file');
        expect(read('legacy/a.ts')).toBe(UNFORMATTED);
    });

    test('preserves a UTF-8 byte order mark', async () => {
        write('bom.ts', `﻿${UNFORMATTED}`);

        await run(['--write', 'bom.ts']);
        expect(read('bom.ts').startsWith("﻿// Other\n")).toBe(true);
    });

    test('removes unused imports from TypeScript diagnostics in the editor profile only', async () => {
        write('tsconfig.json', '{ "compilerOptions": { "strict": true, "types": [] } }');
        write('tidyjs.json', JSON.stringify({ format: { removeUnusedImports: true } }));
        write('lib.ts', 'export const used = 1; export const unused = 2;\n');
        const source = "import { used, unused } from './lib';\n\nexport const value = used;\n";
        write('a.ts', source);

        await run(['--profile', 'folder', '--write', 'a.ts']);
        expect(read('a.ts')).toContain('unused');

        write('a.ts', source);
        await run(['--write', '--verbose', 'a.ts']);
        expect(read('a.ts')).toBe("// Other\nimport { used } from './lib';\n\nexport const value = used;\n");
        expect(stdout).toContain('typescript: used (project, TypeScript');
        expect(stdout).toContain('unused names: unused');
    });

    test('warns and removes nothing when no diagnostics source can run', async () => {
        write('tidyjs.json', JSON.stringify({ format: { removeUnusedImports: true } }));
        write('lib.ts', 'export const used = 1; export const unused = 2;\n');
        write('a.ts', "import { used, unused } from './lib';\n\nexport const value = used;\n");

        expect(await run(['--write', 'a.ts'], null)).toBe(0);
        expect(stderr).toContain('warning  a.ts  unused and missing imports were not removed: no diagnostics source could analyse the file');
        expect(read('a.ts')).toContain('unused');
    });

    test('--changed and --staged restrict the run to files Git reports', async () => {
        const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
        git('init', '-q');
        git('-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-q', '--allow-empty', '-m', 'init');
        write('committed.ts', UNFORMATTED);
        git('add', 'committed.ts');
        git('-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', 'commit', '--no-verify', '-q', '-m', 'add');
        write('staged.ts', UNFORMATTED);
        git('add', 'staged.ts');
        write('untracked.ts', UNFORMATTED);

        await run(['--changed']);
        expect(stdout).toBe('would format  staged.ts\nwould format  untracked.ts\n');

        await run(['--staged', '.']);
        expect(stdout).toBe('would format  staged.ts\n');

        const link = `${root}-link`;
        fs.symlinkSync(root, link, 'dir');
        try {
            expect(await run(['--staged', link])).toBe(0);
            expect(stderr).toContain('1 file(s): 1 to format');
        } finally {
            fs.unlinkSync(link);
        }
    });

    test('--typescript uses the given TypeScript package', async () => {
        write('tsconfig.json', '{ "compilerOptions": { "types": [] } }');
        write('tidyjs.json', JSON.stringify({ format: { removeUnusedImports: true } }));
        write('lib.ts', 'export const used = 1; export const unused = 2;\n');
        write('a.ts', "import { used, unused } from './lib';\n\nexport const value = used;\n");

        await run(['--verbose', '--typescript', path.join(repoRoot, 'node_modules/typescript'), 'a.ts'], null);
        expect(stdout).toContain(`TypeScript ${require('typescript').version}`);
        expect(stdout).toContain('unused names: unused');

        await run(['--typescript', path.join(root, 'nowhere'), 'a.ts']);
        expect(stderr).toContain('typescript diagnostics failed: No TypeScript package found');
    });

    test('rejects invalid arguments with the usage text', async () => {
        expect(await run(['--write', '--check', '.'])).toBe(2);
        expect(stderr).toContain('--write and --check cannot be used together');
        expect(stderr).toContain('Usage: tidyjs');
    });
});
