import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../..');
const cliPath = path.join(repoRoot, 'dist/cli.js');

const ESLINT_CONFIG = `import tseslint from 'typescript-eslint';
export default [{
    files: ['**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: { '@typescript-eslint/no-unused-vars': 'warn' },
}];
`;

const SOURCE = "import { join, resolve } from 'path';\nimport { readFileSync } from 'fs';\n\nexport const read = readFileSync;\n";
const WITHOUT_UNUSED = "// Other\nimport { readFileSync } from 'fs';\n\nexport const read = readFileSync;\n";
const ONLY_FORMATTED = "// Other\nimport { readFileSync } from 'fs';\nimport {\n    join,\n    resolve\n}                       from 'path';\n\nexport const read = readFileSync;\n";

describe('ESLint diagnostics through the built CLI', () => {
    let root: string;

    function write(relativePath: string, content: string): void {
        const fullPath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, 'utf8');
    }

    function setup(options: { eslintConfig?: string; settings?: Record<string, unknown>; installModules?: boolean }): void {
        write('package.json', '{ "type": "module" }');
        write('tsconfig.json', '{ "compilerOptions": { "strict": true, "types": ["node"] } }');
        write('tidyjs.json', JSON.stringify({ format: { removeUnusedImports: true } }));
        write('src/a.ts', SOURCE);
        if (options.eslintConfig !== undefined) {
            write('eslint.config.mjs', options.eslintConfig);
        }
        if (options.settings) {
            write('.vscode/settings.json', JSON.stringify(options.settings));
        }
        if (options.installModules !== false) {
            fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
        }
    }

    function run(): { status: number | null; stdout: string; stderr: string; output: string } {
        const result = spawnSync(process.execPath, [cliPath, '--write', '--verbose', '--root', root, 'src'], { cwd: root, encoding: 'utf8' });
        return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: fs.readFileSync(path.join(root, 'src/a.ts'), 'utf8') };
    }

    beforeEach(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tidyjs-eslint-cli-')));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('ESLint reports each unused specifier, which TypeScript 6192 does not name', () => {
        setup({ eslintConfig: ESLINT_CONFIG });
        const result = run();

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('eslint: used (linted');
        expect(result.output).toBe(WITHOUT_UNUSED);
    });

    test('without ESLint installed, TypeScript alone keeps the fully unused import', () => {
        setup({ installModules: false });
        const result = run();

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('eslint: unavailable (not-installed');
        expect(result.stdout).toContain('typescript: used');
        expect(result.stderr).not.toContain('warning');
        expect(result.output).toBe(ONLY_FORMATTED);
    });

    test('a broken ESLint configuration is a warning, not an engine error', () => {
        setup({ eslintConfig: 'export default [ {' });
        const result = run();

        expect(result.status).toBe(0);
        expect(result.stderr).toContain('warning  src/a.ts  eslint diagnostics failed: ESLint failed:');
        expect(result.output).toBe(ONLY_FORMATTED);
    });

    test('a project without ESLint configuration is reported as not configured', () => {
        setup({});
        const result = run();

        expect(result.stdout).toContain('eslint: unavailable (not-configured');
        expect(result.stderr).not.toContain('warning');
    });

    test.each([
        ['eslint.enable is false', { 'eslint.enable': false }],
        ['the rule is customized to info', { 'eslint.rules.customizations': [{ rule: '*no-unused-vars', severity: 'info' }] }],
        ['eslint.quiet drops warnings', { 'eslint.quiet': true }],
        ['typescript is not validated', { 'eslint.validate': ['javascript'] }],
    ])('ESLint diagnostics are not used when %s', (_label, settings) => {
        setup({ eslintConfig: ESLINT_CONFIG, settings });
        expect(run().output).toBe(ONLY_FORMATTED);
    });

    test('a customization that upgrades the rule keeps the removal', () => {
        setup({ eslintConfig: ESLINT_CONFIG, settings: { 'eslint.rules.customizations': [{ rule: '@typescript-eslint/*', severity: 'upgrade' }] } });
        expect(run().output).toBe(WITHOUT_UNUSED);
    });
});
