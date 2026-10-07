import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { PathResolver, readTsConfigPathOptions } from '../../src/utils/path-resolver';

jest.mock('../../src/utils/log', () => ({
    logDebug: jest.fn(),
    logError: jest.fn(),
}));

function write(root: string, relativePath: string, content: string): string {
    const fullPath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
    return fullPath;
}

describe('tsconfig reading for path resolution', () => {
    let root: string;

    beforeEach(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tidyjs-tsconfig-')));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('reads JSONC where "/*" inside strings precedes "*/" in a later string', () => {
        const configPath = write(root, 'tsconfig.json', `{
            // comment
            "compilerOptions": { "paths": { "@app/*": ["./src/app/*"], }, },
            "include": ["src/**/*.ts"],
        }`);

        expect(readTsConfigPathOptions(configPath)).toEqual({
            paths: { '@app/*': ['./src/app/*'] },
            pathsBasePath: root,
        });
    });

    test('inherits paths from a relative extends and resolves them against the declaring file', () => {
        write(root, 'configs/base.json', '{ "compilerOptions": { "paths": { "@lib/*": ["../lib/*"] } } }');
        const configPath = write(root, 'app/tsconfig.json', '{ "extends": "../configs/base" }');

        expect(readTsConfigPathOptions(configPath)).toEqual({
            paths: { '@lib/*': ['../lib/*'] },
            pathsBasePath: path.join(root, 'configs'),
        });
    });

    test('resolves paths from an extending file against an inherited baseUrl', () => {
        write(root, 'base.json', '{ "compilerOptions": { "baseUrl": "./src" } }');
        const configPath = write(root, 'tsconfig.json', '{ "extends": ["./base.json"], "compilerOptions": { "paths": { "~/*": ["*"] } } }');

        const resolver = new PathResolver({ mode: 'absolute' });
        const filePath = write(root, 'src/feature/view.ts', '');
        write(root, 'src/shared/util.ts', 'export {};');

        expect(readTsConfigPathOptions(configPath)?.baseUrl).toBe(path.join(root, 'src'));
        expect(resolver.convertImportPathBatch('../shared/util', filePath, root)).toBe('~/shared/util');
    });

    test('follows a package specifier in extends through node_modules', () => {
        write(root, 'node_modules/shared-config/base.json', '{ "compilerOptions": { "baseUrl": "." } }');
        const configPath = write(root, 'tsconfig.json', '{ "extends": "shared-config/base.json" }');

        expect(readTsConfigPathOptions(configPath)).toEqual({ baseUrl: path.join(root, 'node_modules/shared-config') });
    });

    test('lets the extending file override inherited paths and survives extends cycles', () => {
        write(root, 'a.json', '{ "extends": "./tsconfig.json", "compilerOptions": { "paths": { "@a/*": ["a/*"] } } }');
        const configPath = write(root, 'tsconfig.json', '{ "extends": "./a.json", "compilerOptions": { "paths": { "@b/*": ["b/*"] } } }');

        expect(readTsConfigPathOptions(configPath)?.paths).toEqual({ '@b/*': ['b/*'] });
    });

    test('returns null for a missing file', () => {
        expect(readTsConfigPathOptions(path.join(root, 'missing.json'))).toBeNull();
    });
});
