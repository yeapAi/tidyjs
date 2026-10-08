import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { expandTargets, isGlobPattern } from '../../src/cli/files';
import { findWorkspaceRoot, loadWorkspaceSettings } from '../../src/cli/workspace';

describe('CLI targets and workspace', () => {
    let root: string;

    function touch(relativePath: string, content = ''): string {
        const fullPath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
        return fullPath;
    }

    beforeEach(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tidyjs-files-')));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('expands directories like Format Folder and sorts the result', async () => {
        touch('src/b.ts');
        touch('src/a.tsx');
        touch('src/style.css');
        touch('node_modules/pkg/index.js');
        touch('dist/out.js');

        const expansion = await expandTargets(['.'], root);
        expect(expansion.files).toEqual([path.join(root, 'src/a.tsx'), path.join(root, 'src/b.ts')]);
    });

    test('expands quoted globs and skips the always-skipped folders', async () => {
        touch('src/a.ts');
        touch('src/deep/b.js');
        touch('src/build/c.ts');
        touch('src/d.css');

        const expansion = await expandTargets(['src/**/*'], root);
        expect(expansion.files).toEqual([path.join(root, 'src/a.ts'), path.join(root, 'src/deep/b.js')]);
    });

    test('keeps an explicit file even inside a skipped folder and reports other targets', async () => {
        const explicit = touch('dist/kept.ts');
        touch('notes.md');

        const expansion = await expandTargets(['dist/kept.ts', 'notes.md', 'missing.ts', 'nothing/**/*.ts'], root);
        expect(expansion.files).toEqual([explicit]);
        expect(expansion.unsupported).toEqual([path.join(root, 'notes.md')]);
        expect(expansion.missing).toEqual(['missing.ts', 'nothing/**/*.ts']);
    });

    test('recognizes glob patterns', () => {
        expect(isGlobPattern('src/**/*.ts')).toBe(true);
        expect(isGlobPattern('src/{a,b}.ts')).toBe(true);
        expect(isGlobPattern('src/file.ts')).toBe(false);
    });

    test('finds the workspace root from .git or .vscode, else keeps the start directory', () => {
        fs.mkdirSync(path.join(root, 'repo/.git'), { recursive: true });
        fs.mkdirSync(path.join(root, 'repo/packages/a/src'), { recursive: true });
        fs.mkdirSync(path.join(root, 'plain/sub'), { recursive: true });

        expect(findWorkspaceRoot(path.join(root, 'repo/packages/a/src'))).toBe(path.join(root, 'repo'));
        expect(findWorkspaceRoot(path.join(root, 'plain/sub'))).toBe(path.join(root, 'plain/sub'));
    });

    test('reads .vscode/settings.json as JSONC, ignores language blocks and reports syntax errors', () => {
        touch('.vscode/settings.json', '{\n // c\n "tidyjs.format.indent": 2,\n "[typescript]": { "editor.tabSize": 8 },\n "broken": \n}');

        const loaded = loadWorkspaceSettings(root);
        expect(loaded.tree).toEqual({ tidyjs: { format: { indent: 2 } }, broken: undefined });
        expect(loaded.warning).toMatch(/JSON syntax error/);
    });
});
