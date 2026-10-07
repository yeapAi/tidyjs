import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { readEslintEditorSettings, resolveEslintWorkingDirectory } from '../../src/cli/eslint-diagnostics';
import { createSettingsReader, settingsTreeFromFlatEntries, getSettingsSection } from '../../src/core/settings';

function settings(entries: Record<string, unknown>) {
    return readEslintEditorSettings(createSettingsReader(getSettingsSection(settingsTreeFromFlatEntries(entries), 'eslint')));
}

describe('ESLint working directory, as computed by the VS Code ESLint extension', () => {
    let root: string;

    function touch(relativePath: string, content = ''): string {
        const fullPath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
        return fullPath;
    }

    beforeEach(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tidyjs-eslint-')));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('location mode uses the directory of the nearest flat config', () => {
        touch('package.json');
        touch('apps/web/eslint.config.js');
        const file = touch('apps/web/src/a.ts');

        expect(resolveEslintWorkingDirectory(file, root, settings({})).workingDirectory)
            .toEqual({ directory: path.join(root, 'apps/web'), changeProcessCwd: true });
    });

    test('location mode stops at a package.json and falls back to the workspace root', () => {
        touch('eslint.config.js');
        touch('packages/lib/package.json');
        const file = touch('packages/lib/index.ts');

        expect(resolveEslintWorkingDirectory(file, root, settings({})).workingDirectory?.directory).toBe(root);
    });

    test('auto mode uses the nearest package.json directory', () => {
        touch('packages/lib/package.json');
        const file = touch('packages/lib/src/index.ts');

        expect(resolveEslintWorkingDirectory(file, root, settings({ 'eslint.workingDirectories': [{ mode: 'auto' }] })).workingDirectory?.directory)
            .toBe(path.join(root, 'packages/lib'));
    });

    test('explicit directories pick the longest match and honour !cwd and changeProcessCWD', () => {
        const file = touch('apps/paye/src/a.ts');
        const configured = settings({
            'eslint.workingDirectories': [
                './apps',
                { directory: './apps/paye', changeProcessCWD: true },
                { directory: './apps/pdf', '!cwd': true },
            ],
        });

        expect(resolveEslintWorkingDirectory(file, root, configured))
            .toEqual({ workingDirectory: { directory: path.join(root, 'apps/paye'), changeProcessCwd: true }, configured: true });

        const noCwd = settings({ 'eslint.workingDirectories': [{ directory: './apps', '!cwd': true }] });
        expect(resolveEslintWorkingDirectory(file, root, noCwd).workingDirectory?.changeProcessCwd).toBe(false);
    });

    test('pattern entries match the directory prefix', () => {
        const file = touch('packages/ui/src/button.tsx');
        const configured = settings({ 'eslint.workingDirectories': [{ pattern: './packages/*/' }] });

        expect(resolveEslintWorkingDirectory(file, root, configured).workingDirectory?.directory).toBe(path.join(root, 'packages/ui'));
    });
});

describe('readEslintEditorSettings', () => {
    test('reads the settings the ESLint extension applies to diagnostics', () => {
        expect(settings({
            'eslint.enable': false,
            'eslint.validate': ['typescript', { language: 'javascript' }],
            'eslint.quiet': true,
            'eslint.useFlatConfig': false,
            'eslint.options': { overrideConfigFile: 'x.js' },
            'eslint.rules.customizations': [{ rule: '*unused*', severity: 'info' }, { rule: 42, severity: 'off' }],
        })).toMatchObject({
            enable: false,
            validate: ['typescript', 'javascript'],
            quiet: true,
            useFlatConfig: false,
            options: { overrideConfigFile: 'x.js' },
            customizations: [{ rule: '*unused*', severity: 'info' }],
        });
    });

    test('defaults match the extension', () => {
        expect(settings({})).toMatchObject({ enable: true, validate: undefined, quiet: false, options: {}, customizations: [] });
        expect(settings({}).probe).toEqual(expect.arrayContaining(['javascript', 'javascriptreact', 'typescript', 'typescriptreact']));
    });
});
