import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';

import { parseConfigWithCache } from '../../src/cli/tsconfig-cache';

describe('parseConfigWithCache', () => {
    let root: string;
    let cacheDir: string;

    function write(relativePath: string, content: string): string {
        const fullPath = path.join(root, relativePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, 'utf8');
        return fullPath;
    }

    function parsedByTypeScript(configPath: string) {
        const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined })!;
        const options: ts.CompilerOptions = { ...parsed.options };
        delete options.configFile;
        return { options, fileNames: parsed.fileNames, projectReferences: parsed.projectReferences };
    }

    beforeEach(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tidyjs-tsconfig-')));
        cacheDir = path.join(root, '.cache');
        write('base.json', '{ "compilerOptions": { "strict": true, "paths": { "@app/*": ["./src/app/*"] } } }');
        write('tsconfig.json', '{ "extends": "./base.json", "include": ["src/**/*.ts", "src/**/*.tsx"], "exclude": ["src/ignored"] }');
        write('src/a.ts', 'export const a = 1;');
        write('src/app/b.tsx', 'export const b = 1;');
        write('src/ignored/c.ts', 'export const c = 1;');
        write('src/d.js', 'export const d = 1;');
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('returns what TypeScript parses, then the same result from the cache', () => {
        const configPath = path.join(root, 'tsconfig.json');
        const expected = parsedByTypeScript(configPath);

        expect(parseConfigWithCache(ts, configPath, undefined, cacheDir)).toEqual(expected);
        expect(fs.readdirSync(cacheDir)).toHaveLength(1);
        expect(parseConfigWithCache(ts, configPath, undefined, cacheDir)).toEqual(expected);
    });

    test.each([
        ['a file added to an included folder', () => write('src/app/e.ts', 'export const e = 1;')],
        ['a folder added with a file', () => write('src/app/deep/f.ts', 'export const f = 1;')],
        ['a file removed', () => fs.rmSync(path.join(root, 'src/a.ts'))],
        ['the extended config changed', () => write('base.json', '{ "compilerOptions": { "strict": false } }')],
        ['the include changed', () => write('tsconfig.json', '{ "extends": "./base.json", "include": ["src/**/*.ts"] }')],
    ])('invalidates the cache when %s', (_label, change) => {
        const configPath = path.join(root, 'tsconfig.json');
        parseConfigWithCache(ts, configPath, undefined, cacheDir);

        change();

        expect(parseConfigWithCache(ts, configPath, undefined, cacheDir)).toEqual(parsedByTypeScript(configPath));
    });
});
