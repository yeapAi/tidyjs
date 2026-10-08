import { parseCliArguments, UsageError } from '../../src/cli/args';

describe('parseCliArguments', () => {
    test('defaults to a safe listing mode with both diagnostics sources', () => {
        expect(parseCliArguments(['.'])).toMatchObject({
            targets: ['.'],
            mode: 'list',
            diff: false,
            profile: 'editor',
            typescript: true,
            eslint: true,
        });
    });

    test('maps modes and switches', () => {
        expect(parseCliArguments(['-w', 'src'])).toMatchObject({ mode: 'write' });
        expect(parseCliArguments(['--check', '--diff', 'a.ts'])).toMatchObject({ mode: 'check', diff: true });
        expect(parseCliArguments(['--no-eslint', 'a.ts'])).toMatchObject({ typescript: true, eslint: false });
        expect(parseCliArguments(['--no-diagnostics', 'a.ts'])).toMatchObject({ typescript: false, eslint: false });
        expect(parseCliArguments(['--profile', 'folder', '--root', '/repo', 'a.ts'])).toMatchObject({ profile: 'folder', root: '/repo' });
    });

    test('maps speed and selection options', () => {
        expect(parseCliArguments(['--jobs', '3', '--typescript', '/ts', 'src'])).toMatchObject({ jobs: 3, typescriptPath: '/ts' });
        expect(parseCliArguments(['--changed'])).toMatchObject({ gitSelection: 'changed', targets: ['.'] });
        expect(parseCliArguments(['--staged', 'src'])).toMatchObject({ gitSelection: 'staged', targets: ['src'] });
    });

    test('accepts --help and --version without targets', () => {
        expect(parseCliArguments(['--help']).help).toBe(true);
        expect(parseCliArguments(['--version']).version).toBe(true);
    });

    test.each([
        [[]],
        [['--write', '--check', '.']],
        [['--verbose', '--quiet', '.']],
        [['--profile', 'other', '.']],
        [['--unknown', '.']],
        [['--changed', '--staged']],
        [['--jobs', '0', '.']],
        [['--jobs', 'many', '.']],
    ])('rejects %j', (argv) => {
        expect(() => parseCliArguments(argv)).toThrow(UsageError);
    });
});
