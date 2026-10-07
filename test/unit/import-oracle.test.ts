import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';

import { ImportOracle } from '../../src/cli/import-oracle';
import { findImportBindingSpans } from '../../src/core/diagnostics';

import type { OracleProject } from '../../src/cli/import-oracle';

const OPTIONS: ts.CompilerOptions = {
    strict: true,
    allowJs: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
    noEmit: true,
    types: [],
};

const CASES: Record<string, string> = {
    'used.ts': "import { a, b } from './lib';\nexport const x = a;\n",
    'unused-single.ts': "import { a } from './lib';\nexport const x = 1;\n",
    'all-unused.ts': "import { a, b } from './lib';\nexport const x = 1;\n",
    'same-name-param.ts': "import { a } from './lib';\nexport const x = a;\nexport const f = (a: number): number => 1;\n",
    'prose.ts': "import { a } from './lib';\n/** Uses a in prose. */\nexport const x = 1;\n",
    'link.ts': "import { a } from './lib';\n/** See {@link a}. */\nexport const x = 1;\n",
    'js-type.js': "import { a } from './lib';\n/** @type {typeof a} */\nexport const x = 1;\n",
    'js-prose.js': "import { a } from './lib';\n/** Uses a in prose. */\nexport const x = 1;\n",
    'nocheck.ts': "// @ts-nocheck\nimport { a } from './lib';\nexport const x = 1;\n",
    'missing.ts': "import { a } from './nowhere';\nexport const x = a;\n",
    'ambient.ts': "import styles from './styles.css';\nexport const x = styles;\n",
    'react-automatic.tsx': "import React from 'react';\nexport const X = () => <div />;\n",
    'type-only.ts': "import type { T } from './lib';\nexport type U = T;\n",
    'declaration.d.ts': "import { a } from './lib';\nexport declare const x: number;\n",
    'missing-and-link.ts': "import { a } from './lib';\nimport { z } from './nowhere';\n/** See {@link a}. */\nexport const x = z;\n",
};

describe('ImportOracle', () => {
    let root: string;
    let project: OracleProject;
    let languageService: ts.LanguageService;

    beforeAll(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tidyjs-oracle-')));
        fs.writeFileSync(path.join(root, 'lib.ts'), 'export const a = 1; export const b = 2; export type T = number;\n');
        fs.writeFileSync(path.join(root, 'globals.d.ts'), "declare module '*.css' { const value: Record<string, string>; export default value; }\ndeclare module 'react' { const React: unknown; export default React; }\ndeclare module 'react/jsx-runtime' { export const jsx: unknown; export const jsxs: unknown; }\n");
        for (const [name, content] of Object.entries(CASES)) {
            fs.writeFileSync(path.join(root, name), content);
        }
        const fileNames = [path.join(root, 'lib.ts'), path.join(root, 'globals.d.ts'), ...Object.keys(CASES).map((name) => path.join(root, name))];
        project = { key: root, directory: root, options: OPTIONS, fileNames };
        languageService = ts.createLanguageService({
            getCompilationSettings: () => OPTIONS,
            getScriptFileNames: () => fileNames,
            getScriptVersion: () => '0',
            getScriptSnapshot: (file) => {
                const text = ts.sys.readFile(file);
                return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
            },
            getCurrentDirectory: () => root,
            getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
            fileExists: ts.sys.fileExists,
            readFile: ts.sys.readFile,
            readDirectory: ts.sys.readDirectory,
            directoryExists: ts.sys.directoryExists,
            getDirectories: ts.sys.getDirectories,
        });
    });

    afterAll(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    function verdict(name: string) {
        const file = path.join(root, name);
        return new ImportOracle(ts).analyze(file, fs.readFileSync(file, 'utf8'), project, { suggestionsEnabled: true });
    }

    function typescriptUnusedAtImports(name: string): string[] {
        const file = path.join(root, name);
        const spans = findImportBindingSpans(fs.readFileSync(file, 'utf8'), file);
        return [...languageService.getSemanticDiagnostics(file), ...languageService.getSuggestionDiagnostics(file)]
            .filter((diagnostic) => diagnostic.code === 6133 && spans.some((span) => (diagnostic.start ?? -1) >= span.start && (diagnostic.start ?? -1) < span.end))
            .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ').split("'")[1])
            .sort();
    }

    test.each([
        ['used.ts', ['b']],
        ['unused-single.ts', ['a']],
        ['same-name-param.ts', []],
        ['prose.ts', ['a']],
        ['js-prose.js', ['a']],
        ['ambient.ts', []],
        ['react-automatic.tsx', ['React']],
        ['type-only.ts', []],
    ])('%s is decided and matches the names TypeScript reports at the import', (name, expected) => {
        const result = verdict(name);
        expect(result.decided).toBe(true);
        const names = result.decided ? result.diagnostics.map((diagnostic) => diagnostic.message.split("'")[1]).sort() : [];
        expect(names).toEqual(expected);
        expect(typescriptUnusedAtImports(name)).toEqual(expected);
    });

    test('positions point into the import declaration', () => {
        const result = verdict('unused-single.ts');
        const text = CASES['unused-single.ts'];
        expect(result.decided && result.diagnostics[0].start).toBe(text.indexOf('a }'));
    });

    test.each([
        ['all-unused.ts', 'every binding', 'file'],
        ['link.ts', 'JSDoc', 'file'],
        ['js-type.js', 'JSDoc', 'file'],
        ['nocheck.ts', '@ts-', 'file'],
        ['declaration.d.ts', 'declaration file', 'file'],
        ['missing.ts', 'does not resolve', 'program'],
        ['missing-and-link.ts', 'does not resolve', 'program'],
    ])('%s falls back because of "%s" to the %s stage', (name, reason, stage) => {
        const result = verdict(name);
        expect(result.decided).toBe(false);
        expect(result.decided ? '' : result.reason).toContain(reason);
        expect(result.decided ? '' : result.stage).toBe(stage);
    });

    test('defers to the file-only analysis when suggestions are disabled and noUnusedLocals is off', () => {
        const file = path.join(root, 'unused-single.ts');
        const result = new ImportOracle(ts).analyze(file, CASES['unused-single.ts'], project, { suggestionsEnabled: false });
        expect(result).toEqual({ decided: false, reason: 'TypeScript suggestions disabled', stage: 'file' });
    });

    test('sends files using decorator metadata to the full analysis', () => {
        const file = path.join(root, 'used.ts');
        const result = new ImportOracle(ts).analyze(file, CASES['used.ts'] + '@decorator\nexport class C {}\n', { ...project, options: { ...OPTIONS, experimentalDecorators: true, emitDecoratorMetadata: true } }, { suggestionsEnabled: true });
        expect(result).toEqual({ decided: false, reason: 'decorator metadata may reference imports', stage: 'program' });
    });
});
