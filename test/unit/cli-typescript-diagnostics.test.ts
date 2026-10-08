import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { loadTypeScript, TypeScriptDiagnosticsProvider } from '../../src/cli/typescript-diagnostics';

import type { TypeScriptEditorSettings } from '../../src/cli/typescript-diagnostics';

const repoRoot = path.resolve(__dirname, '../..');

const defaultSettings: TypeScriptEditorSettings = {
    validateTypeScript: true,
    validateJavaScript: true,
    suggestionsTypeScript: true,
    suggestionsJavaScript: true,
    implicitCheckJs: false,
    implicitExperimentalDecorators: false,
    implicitStrictNullChecks: true,
    implicitStrictFunctionTypes: true,
    implicitStrict: true,
};

describe('TypeScriptDiagnosticsProvider', () => {
    let root: string;

    function write(relativePath: string, content: string): string {
        const fullPath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, 'utf8');
        return fullPath;
    }

    function provider(settings: Partial<TypeScriptEditorSettings> = {}): TypeScriptDiagnosticsProvider {
        return new TypeScriptDiagnosticsProvider(repoRoot, { ...defaultSettings, ...settings });
    }

    async function codes(filePath: string, instance = provider()): Promise<(string | number | undefined)[]> {
        return (await instance.getDiagnostics(filePath, fs.readFileSync(filePath, 'utf8'), root)).map((diagnostic) => diagnostic.code);
    }

    beforeEach(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tidyjs-ts-')));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('reports unused imports as hints and missing modules as errors in a configured project', async () => {
        write('tsconfig.json', '{ "compilerOptions": { "strict": true, "types": [] }, "include": ["src"] }');
        write('src/lib.ts', 'export const used = 1; export const unused = 2;');
        const file = write('src/main.ts', "import { used, unused } from './lib';\nimport { x } from 'nope';\nexport const y = [used, x];\n");

        const diagnostics = await provider().getDiagnostics(file, fs.readFileSync(file, 'utf8'), root);

        expect(diagnostics).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 6133, severity: 'hint', message: "'unused' is declared but its value is never read." }),
            expect.objectContaining({ code: 2307, severity: 'error', message: "Cannot find module 'nope' or its corresponding type declarations." }),
        ]));
        expect(await provider().describe(file, root)).toMatchObject({ kind: 'configured', configPath: path.join(root, 'tsconfig.json') });
    });

    test('reports unused imports as errors when noUnusedLocals is on', async () => {
        write('tsconfig.json', '{ "compilerOptions": { "noUnusedLocals": true, "types": [] } }');
        write('lib.ts', 'export const a = 1;');
        const file = write('main.ts', "import { a } from './lib';\nexport {};\n");

        const diagnostic = (await provider().getDiagnostics(file, fs.readFileSync(file, 'utf8'), root)).find((item) => item.code === 6133);
        expect(diagnostic?.severity).toBe('error');
    });

    test('skips a nearer tsconfig that does not include the file and uses an ancestor', async () => {
        write('tsconfig.json', '{ "compilerOptions": { "types": [] } }');
        write('packages/a/tsconfig.json', '{ "compilerOptions": { "types": [] }, "files": [] }');
        const file = write('packages/a/index.ts', 'export const a = 1;\n');

        expect(await provider().describe(file, root)).toMatchObject({ kind: 'configured', configPath: path.join(root, 'tsconfig.json') });
    });

    test('finds the referenced project of a solution-style tsconfig', async () => {
        write('tsconfig.json', '{ "files": [], "references": [{ "path": "./app" }] }');
        write('app/tsconfig.json', '{ "compilerOptions": { "composite": true, "types": [] }, "include": ["**/*.ts"] }');
        const file = write('app/main.ts', 'export const a = 1;\n');

        expect(await provider().describe(file, root)).toMatchObject({ kind: 'configured', configPath: path.join(root, 'app', 'tsconfig.json') });
    });

    test('uses jsconfig.json for JavaScript files and reports unused imports there', async () => {
        write('jsconfig.json', '{ "compilerOptions": { "types": [] } }');
        write('lib.js', 'export const a = 1; export const b = 2;');
        const file = write('main.js', "import { a, b } from './lib';\nexport const c = a;\n");

        expect(await provider().describe(file, root)).toMatchObject({ kind: 'configured', configPath: path.join(root, 'jsconfig.json') });
        expect(await codes(file)).toContain(6133);
    });

    test('falls back to an inferred project for a file outside any tsconfig', async () => {
        write('tsconfig.json', '{ "compilerOptions": { "types": [] }, "include": ["src"] }');
        const file = write('scripts/tool.ts', "import { readFileSync } from 'fs';\nexport {};\n");

        expect(await provider().describe(file, root)).toMatchObject({ kind: 'inferred' });
        expect(await codes(file)).toContain(6133);
    });

    test('gives inferred projects the VS Code options, including strict from js/ts.implicitProjectConfig', async () => {
        const file = write('loose/tool.ts', 'export function identity(value) { return value; }\n');

        expect(await codes(file)).toContain(7006);
        expect(await codes(file, provider({ implicitStrict: false }))).not.toContain(7006);
    });

    test('honours typescript.suggestionActions.enabled and typescript.validate.enable', async () => {
        write('tsconfig.json', '{ "compilerOptions": { "types": [] } }');
        write('lib.ts', 'export const a = 1;');
        const file = write('main.ts', "import { a } from './lib';\nexport {};\n");

        expect(await codes(file, provider({ suggestionsTypeScript: false }))).not.toContain(6133);
        expect(await codes(file, provider({ validateTypeScript: false }))).toEqual([]);
    });

    test.each([
        ['link.ts', "import { a, b } from './lib';\n/** See {@link a}. */\nexport const x = 1;\n"],
        ['all-unused.ts', "import { a, b } from './lib';\nexport const x = 1;\n"],
        ['nocheck.ts', "// @ts-nocheck\nimport { a } from './lib';\nexport const x = 1;\n"],
        ['assigned.ts', "import { a } from './lib';\n// @ts-ignore\na = 2;\nexport const x = 1;\n"],
        ['classic.tsx', "/** @jsx h */\nimport { h, a } from './lib';\nexport const X = () => <div />;\n"],
        ['types.d.ts', "import { a } from './lib';\nexport declare const x: number;\n"],
        ['jsdoc.js', "import { a, b } from './lib';\n/** @type {typeof a} */\nexport const x = 1;\n"],
        ['checked.js', "// @ts-check\nimport { a } from './lib';\nexport const x = 1;\n"],
    ])('file-only analysis of %s reports the same unused names as the full program', async (name, content) => {
        write('tsconfig.json', '{ "compilerOptions": { "strict": true, "allowJs": true, "checkJs": true, "jsx": "react", "types": [] } }');
        write('lib.ts', 'export const a = 1; export const b = 2; export const h = (): null => null;');
        const file = write(name, content);
        const unusedCodes = ['6133', '6192', '6196'];
        const full = (await provider().getDiagnostics(file, content, root))
            .filter((diagnostic) => unusedCodes.includes(String(diagnostic.code)))
            .map((diagnostic) => `${diagnostic.code}:${diagnostic.start}:${diagnostic.message}`);
        const fileOnly = provider().fileOnlyUnusedDiagnostics(file, content, root)
            .map((diagnostic) => `${diagnostic.code}:${diagnostic.start}:${diagnostic.message}`);
        expect(fileOnly).toEqual(full);
    });

    test('file-only analysis keeps only unused-name diagnostics', () => {
        write('tsconfig.json', '{ "compilerOptions": { "types": [] } }');
        const content = "import { a } from './nowhere';\nimport { b } from './lib';\nexport const x = a;\n";
        write('lib.ts', 'export const b = 1;');
        const file = write('main.ts', content);
        expect(provider().fileOnlyUnusedDiagnostics(file, content, root).map((diagnostic) => diagnostic.code)).toEqual([6133]);
    });

    test('loadTypeScript prefers the first directory that resolves the module', async () => {
        expect(loadTypeScript([root])).toBeNull();
        expect(loadTypeScript([root, repoRoot])?.modulePath).toBe(require.resolve('typescript'));
    });
});
