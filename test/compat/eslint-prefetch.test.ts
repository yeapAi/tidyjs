import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { RemoteEslintLinter } from '../../src/cli/eslint-host';
import { readEslintEditorSettings } from '../../src/cli/eslint-diagnostics';
import { createSettingsReader } from '../../src/core/settings';

const repoRoot = path.resolve(__dirname, '../..');

describe('ESLint host prefetch', () => {
    let root: string;
    let linter: RemoteEslintLinter;

    beforeEach(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tidyjs-prefetch-')));
        fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir');
        fs.writeFileSync(path.join(root, 'package.json'), '{ "type": "module" }');
        fs.writeFileSync(path.join(root, 'eslint.config.mjs'), `import tseslint from 'typescript-eslint';
export default [{ files: ['**/*.ts'], languageOptions: { parser: tseslint.parser }, plugins: { '@typescript-eslint': tseslint.plugin }, rules: { '@typescript-eslint/no-unused-vars': 'warn' } }];
`);
        linter = new RemoteEslintLinter(path.join(repoRoot, 'dist/cli.js'), readEslintEditorSettings(createSettingsReader({})));
    });

    afterEach(() => {
        linter.dispose();
        fs.rmSync(root, { recursive: true, force: true });
    });

    const names = (result: { diagnostics: { message: string }[] }) => result.diagnostics.map((diagnostic) => diagnostic.message.split("'")[1]);

    test('returns the prefetched result when the text is the one on disk', async () => {
        const file = path.join(root, 'a.ts');
        const text = "import { a, b } from './x';\nexport const c = a;\n";
        fs.writeFileSync(file, `\uFEFF${text}`);

        linter.prefetch([{ filePath: file, workspaceRoot: root }]);
        expect(names(await linter.lint(file, text, root))).toEqual(['b']);
    });

    test('lints the given text again when it differs from what was prefetched', async () => {
        const file = path.join(root, 'a.ts');
        fs.writeFileSync(file, "import { a, b } from './x';\nexport const c = a;\n");

        linter.prefetch([{ filePath: file, workspaceRoot: root }]);
        expect(names(await linter.lint(file, "import { a, b } from './x';\nexport const c = b;\n", root))).toEqual(['a']);
    });

    test('answers a direct request before the remaining prefetched files', async () => {
        const text = "import { a, b } from './x';\nexport const c = a;\n";
        const files = Array.from({ length: 20 }, (_, index) => {
            const file = path.join(root, `f${index}.ts`);
            fs.writeFileSync(file, text);
            return file;
        });

        linter.prefetch(files.map((filePath) => ({ filePath, workspaceRoot: root })));
        const first = await Promise.race([
            linter.fixAll(files[0], text, root).then(() => 'fixAll'),
            linter.lint(files[19], text, root).then(() => 'prefetch'),
        ]);
        expect(first).toBe('fixAll');
    });
});
