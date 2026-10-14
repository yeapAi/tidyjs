import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '../..');
const cliPath = path.join(repoRoot, 'dist/cli.js');
const typescript7 = path.join(repoRoot, 'node_modules/@typescript/native');

const UNUSED_CONFIG = { rules: { 'no-unused-vars': 'warn' } };
const UNUSED_OFF_CONFIG = { rules: { 'no-unused-vars': 'off' } };
const FIX_CONFIG = { plugins: ['typescript'], rules: { 'typescript/consistent-type-imports': 'error' } };

const TYPE_SOURCE = "import { Stats, statSync } from 'fs';\n\nexport const stat = (file: string): Stats => statSync(file);\n";
const TYPE_FIXED = "// Other\nimport { statSync }   from 'fs';\nimport type { Stats } from 'fs';\n\nexport const stat = (file: string): Stats => statSync(file);\n";
const TYPE_SOURCE_WITH_UNUSED = "import { Stats, statSync } from 'fs';\nimport { join } from 'path';\n\nexport const stat = (file: string): Stats => statSync(file);\n";
const TYPE_FORMATTED_ONLY = "// Other\nimport {\n    Stats,\n    statSync\n}            from 'fs';\n\nexport const stat = (file: string): Stats => statSync(file);\n";

const SOURCE = "import { join, resolve } from 'path';\nimport { readFileSync } from 'fs';\n\nexport const read = readFileSync;\n";
const WITHOUT_UNUSED = "// Other\nimport { readFileSync } from 'fs';\n\nexport const read = readFileSync;\n";
const ONLY_FORMATTED = "// Other\nimport { readFileSync } from 'fs';\nimport {\n    join,\n    resolve\n}                       from 'path';\n\nexport const read = readFileSync;\n";

describe('oxlint diagnostics through the built CLI', () => {
    let root: string;

    function write(relativePath: string, content: string): void {
        const fullPath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, 'utf8');
    }

    function setup(options: { oxlintConfig?: object | string; files?: Record<string, string>; settings?: Record<string, unknown>; installModules?: boolean }): void {
        write('package.json', '{ "type": "module" }');
        write('tsconfig.json', '{ "compilerOptions": { "strict": true, "types": ["node"] } }');
        write('tidyjs.json', JSON.stringify({ format: { removeUnusedImports: true } }));
        write('src/a.ts', SOURCE);
        if (options.oxlintConfig !== undefined) {
            write('.oxlintrc.json', typeof options.oxlintConfig === 'string' ? options.oxlintConfig : JSON.stringify(options.oxlintConfig));
        }
        for (const [file, content] of Object.entries(options.files ?? {})) {
            write(file, content);
        }
        if (options.settings) {
            write('.vscode/settings.json', JSON.stringify(options.settings));
        }
        if (options.installModules !== false) {
            fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
        }
    }

    function run(extraArgs: string[] = []): { status: number | null; stdout: string; stderr: string; output: string } {
        const result = spawnSync(process.execPath, [cliPath, '--write', '--verbose', '--root', root, ...extraArgs, 'src'], { cwd: root, encoding: 'utf8' });
        return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: fs.readFileSync(path.join(root, 'src/a.ts'), 'utf8') };
    }

    beforeEach(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tidyjs-oxlint-cli-')));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('oxlint reports each unused specifier, which TypeScript 6192 does not name', () => {
        setup({ oxlintConfig: UNUSED_CONFIG });
        const result = run();

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('oxlint: used (linted');
        expect(result.output).toBe(WITHOUT_UNUSED);
    });

    test('the default rules of oxlint apply to a project without configuration', () => {
        setup({});
        const result = run();

        expect(result.stdout).toContain('oxlint: used (linted');
        expect(result.stderr).not.toContain('warning');
        expect(result.output).toBe(WITHOUT_UNUSED);
    });

    test('without oxlint installed, TypeScript alone keeps the fully unused import', () => {
        setup({ installModules: false });
        const result = run();

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('oxlint: unavailable (not-installed');
        expect(result.stdout).toContain('typescript: used');
        expect(result.stderr).not.toContain('warning');
        expect(result.output).toBe(ONLY_FORMATTED);
    });

    test.each([
        ['a broken configuration', '{ "rules": {'],
        ['an unknown rule', { rules: { 'no-such-rule': 'error' } }],
    ])('%s is a warning carrying the message of oxlint, which falls back to its default rules', (_label, oxlintConfig) => {
        setup({ oxlintConfig });
        const result = run();

        expect(result.status).toBe(0);
        expect(result.stderr).toMatch(/warning {2}src\/a\.ts {2}oxlint: (Failed to parse|Failed to build config)/);
        expect(result.output).toBe(WITHOUT_UNUSED);
    });

    test.each([
        ['oxc.enable is false', { 'oxc.enable': false }],
        ['oxc.enable.oxlint is false', { 'oxc.enable': true, 'oxc.enable.oxlint': false }],
        ['oxc.configPath points at a configuration without the rule', { 'oxc.configPath': 'quiet.json' }],
    ])('oxlint diagnostics are not used when %s', (_label, settings) => {
        setup({ oxlintConfig: UNUSED_CONFIG, files: { 'quiet.json': JSON.stringify(UNUSED_OFF_CONFIG) }, settings });
        expect(run().output).toBe(ONLY_FORMATTED);
    });

    test('a nested configuration applies unless oxc.disableNestedConfig is set', () => {
        setup({ oxlintConfig: UNUSED_CONFIG, files: { 'src/.oxlintrc.json': JSON.stringify(UNUSED_OFF_CONFIG) } });
        expect(run().output).toBe(ONLY_FORMATTED);

        fs.writeFileSync(path.join(root, 'src/a.ts'), SOURCE);
        fs.mkdirSync(path.join(root, '.vscode'));
        fs.writeFileSync(path.join(root, '.vscode/settings.json'), JSON.stringify({ 'oxc.disableNestedConfig': true }));
        expect(run().output).toBe(WITHOUT_UNUSED);
    });

    describe('oxlint fixes on save', () => {
        function runWithTypeSource(settings: Record<string, unknown>): ReturnType<typeof run> {
            setup({ oxlintConfig: FIX_CONFIG, settings });
            write('src/a.ts', TYPE_SOURCE);
            return run();
        }

        test('source.fixAll.oxc applies the oxlint fixes before TidyJS, as a save in VS Code does', () => {
            const result = runWithTypeSource({ 'editor.codeActionsOnSave': { 'source.fixAll.oxc': 'explicit' } });

            expect(result.status).toBe(0);
            expect(result.stdout).toContain('oxlint fixes: applied');
            expect(result.output).toBe(TYPE_FIXED);
        });

        test.each([
            ['fast import analysis', []],
            ['full analysis', ['--no-fast-analysis']],
            ['TypeScript 7 native API', ['--typescript', typescript7]],
        ] as [string, string[]][])('unused imports are found in the text fixed by oxlint, not in the file on disk (%s)', (_label, extraArgs) => {
            setup({ oxlintConfig: FIX_CONFIG, settings: { 'editor.codeActionsOnSave': { 'source.fixAll.oxc': 'explicit' } } });
            write('src/a.ts', TYPE_SOURCE_WITH_UNUSED);
            const result = run(extraArgs);

            expect(result.stdout).toContain('unused names: join');
            expect(result.output).toBe(TYPE_FIXED);
        });

        test('source.fixAll includes the oxlint fixes', () => {
            expect(runWithTypeSource({ 'editor.codeActionsOnSave': { 'source.fixAll': 'explicit' } }).output).toBe(TYPE_FIXED);
        });

        test.each([
            ['no code action runs on save', {}],
            ['source.fixAll.oxc is never', { 'editor.codeActionsOnSave': { 'source.fixAll': 'explicit', 'source.fixAll.oxc': 'never' } }],
            ['a language override disables it', {
                'editor.codeActionsOnSave': { 'source.fixAll.oxc': 'explicit' },
                '[typescript]': { 'editor.codeActionsOnSave': { 'source.fixAll.oxc': 'never' } },
            }],
            ['oxc.enable is false', { 'editor.codeActionsOnSave': { 'source.fixAll.oxc': 'explicit' }, 'oxc.enable': false }],
        ])('oxlint fixes are not applied when %s', (_label, settings) => {
            expect(runWithTypeSource(settings).output).toBe(TYPE_FORMATTED_ONLY);
        });
    });
});
