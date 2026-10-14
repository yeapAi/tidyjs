import { createHash } from 'node:crypto';

import { isNewerVersion, listZipEntries, parseVersion, selectUpdate, verifyVsix } from '../../src/core/release-update';
import { buildZip } from '../zip-fixture';

import type { ReleaseInfo, UpdateCandidate } from '../../src/core/release-update';

const REPOSITORY = 'yeapAi/tidyjs';

function release(overrides: Partial<ReleaseInfo> = {}, tag = 'v2.0.2'): ReleaseInfo {
    const version = tag.replace(/^v/, '');
    return {
        tag_name: tag,
        draft: false,
        prerelease: false,
        assets: [{
            name: `tidyjs-${version}.vsix`,
            size: 1234,
            browser_download_url: `https://github.com/${REPOSITORY}/releases/download/${tag}/tidyjs-${version}.vsix`,
            digest: `sha256:${'a'.repeat(64)}`,
        }],
        ...overrides,
    };
}

describe('parseVersion', () => {
    test('reads a version with or without the v prefix', () => {
        expect(parseVersion('2.0.1')).toEqual([2, 0, 1]);
        expect(parseVersion('v10.20.30')).toEqual([10, 20, 30]);
    });

    test.each(['', 'v2', '2.0', '2.0.1-beta.1', '2.0.1.4', 'latest', 'v2.0.x'])('rejects "%s"', (text) => {
        expect(parseVersion(text)).toBeUndefined();
    });
});

describe('isNewerVersion', () => {
    test('compares each part as a number', () => {
        expect(isNewerVersion('2.0.2', '2.0.1')).toBe(true);
        expect(isNewerVersion('2.0.10', '2.0.9')).toBe(true);
        expect(isNewerVersion('2.1.0', '2.0.99')).toBe(true);
        expect(isNewerVersion('3.0.0', '2.99.99')).toBe(true);
        expect(isNewerVersion('v2.0.2', '2.0.1')).toBe(true);
    });

    test('is false for an equal, older or unreadable version', () => {
        expect(isNewerVersion('2.0.1', '2.0.1')).toBe(false);
        expect(isNewerVersion('2.0.0', '2.0.1')).toBe(false);
        expect(isNewerVersion('1.99.99', '2.0.0')).toBe(false);
        expect(isNewerVersion('next', '2.0.1')).toBe(false);
        expect(isNewerVersion('2.0.2', 'dev')).toBe(false);
    });
});

describe('selectUpdate', () => {
    test('selects the package of a newer release, with the digest published by GitHub', () => {
        expect(selectUpdate(release(), '2.0.1', REPOSITORY)).toEqual({
            version: '2.0.2',
            assetName: 'tidyjs-2.0.2.vsix',
            url: 'https://github.com/yeapAi/tidyjs/releases/download/v2.0.2/tidyjs-2.0.2.vsix',
            size: 1234,
            sha256: 'a'.repeat(64),
        });
    });

    test('has no digest when GitHub publishes none or another algorithm', () => {
        const withoutDigest = release();
        withoutDigest.assets[0].digest = undefined;
        const otherAlgorithm = release();
        otherAlgorithm.assets[0].digest = `sha1:${'b'.repeat(40)}`;

        expect(selectUpdate(withoutDigest, '2.0.1', REPOSITORY)?.sha256).toBeUndefined();
        expect(selectUpdate(otherAlgorithm, '2.0.1', REPOSITORY)?.sha256).toBeUndefined();
    });

    test.each([
        ['an equal version', release({}, 'v2.0.1')],
        ['an older version', release({}, 'v2.0.0')],
        ['a draft', release({ draft: true })],
        ['a prerelease', release({ prerelease: true })],
        ['a tag that is not a version', release({}, 'nightly')],
        ['a tag with a suffix', release({}, 'v2.0.2-rc.1')],
        ['a release without package', release({ assets: [] })],
        ['a package named for another version', release({ assets: [{ ...release().assets[0], name: 'tidyjs-2.0.3.vsix' }] })],
        ['another file type', release({ assets: [{ ...release().assets[0], name: 'tidyjs-2.0.2.zip' }] })],
        ['a package hosted elsewhere', release({ assets: [{ ...release().assets[0], browser_download_url: 'https://example.invalid/tidyjs-2.0.2.vsix' }] })],
        ['a package of another repository', release({ assets: [{ ...release().assets[0], browser_download_url: 'https://github.com/someone/tidyjs/releases/download/v2.0.2/tidyjs-2.0.2.vsix' }] })],
        ['a package downloaded over http', release({ assets: [{ ...release().assets[0], browser_download_url: 'http://github.com/yeapAi/tidyjs/releases/download/v2.0.2/tidyjs-2.0.2.vsix' }] })],
        ['an empty package', release({ assets: [{ ...release().assets[0], size: 0 }] })],
    ])('selects nothing for %s', (_label, candidate) => {
        expect(selectUpdate(candidate, '2.0.1', REPOSITORY)).toBeUndefined();
    });

    test('selects nothing when the installed version is not a release version', () => {
        expect(selectUpdate(release(), 'dev', REPOSITORY)).toBeUndefined();
    });
});

const MANIFEST: [string, string] = ['extension/package.json', '{}'];
const BINDING: [string, string] = ['extension/dist/parser.darwin-arm64.node', 'binary'];

describe('listZipEntries', () => {
    test('lists the entries of the central directory', () => {
        expect(listZipEntries(buildZip([MANIFEST, BINDING, ['extension/dist/extension.js', 'code']]))).toEqual([
            'extension/package.json',
            'extension/dist/parser.darwin-arm64.node',
            'extension/dist/extension.js',
        ]);
    });

    test('finds the end of the directory before an archive comment', () => {
        const archive = buildZip([MANIFEST]);
        const comment = Buffer.from('built by CI');
        archive.writeUInt16LE(comment.length, archive.length - 2);

        expect(listZipEntries(Buffer.concat([archive, comment]))).toEqual(['extension/package.json']);
    });

    test('works on a view that does not start at the beginning of its buffer', () => {
        const archive = buildZip([MANIFEST, BINDING]);
        const shifted = new Uint8Array(new ArrayBuffer(archive.length + 8), 8);
        shifted.set(archive);

        expect(listZipEntries(shifted)).toEqual(['extension/package.json', 'extension/dist/parser.darwin-arm64.node']);
    });

    test('reads an archive without entries', () => {
        expect(listZipEntries(buildZip([]))).toEqual([]);
    });

    test.each([
        ['an empty file', () => Buffer.alloc(0)],
        ['text', () => Buffer.from('<html>rate limited</html>')],
        ['an archive cut before its end', () => buildZip([MANIFEST, BINDING]).subarray(0, -10)],
        ['an archive cut inside its entries', () => buildZip([MANIFEST, BINDING]).subarray(0, 40)],
        ['an end record that announces more entries than the directory holds', () => {
            const archive = buildZip([MANIFEST]);
            archive.writeUInt16LE(2, archive.length - 12);
            return archive;
        }],
        ['a directory that does not end where the end record says', () => {
            const archive = buildZip([MANIFEST]);
            archive.writeUInt32LE(archive.readUInt32LE(archive.length - 10) + 1, archive.length - 10);
            return archive;
        }],
        ['an entry whose local header is missing', () => {
            const archive = buildZip([MANIFEST]);
            archive.writeUInt32LE(0, 0);
            return archive;
        }],
        ['a directory entry that points outside the archive', () => {
            const archive = buildZip([MANIFEST]);
            const central = archive.readUInt32LE(archive.length - 6);
            archive.writeUInt32LE(archive.length, central + 42);
            return archive;
        }],
    ])('rejects %s', (_label, make) => {
        expect(listZipEntries(make())).toBeUndefined();
    });
});

describe('verifyVsix', () => {
    const platform = 'darwin';
    const arch = 'arm64';

    function vsix(entries: [string, string][] = [MANIFEST, BINDING]): { content: Buffer; candidate: UpdateCandidate } {
        const content = buildZip(entries);
        return {
            content,
            candidate: {
                version: '2.0.2',
                assetName: 'tidyjs-2.0.2.vsix',
                url: 'https://github.com/yeapAi/tidyjs/releases/download/v2.0.2/tidyjs-2.0.2.vsix',
                size: content.length,
                sha256: createHash('sha256').update(content).digest('hex'),
            },
        };
    }

    test('accepts an archive of the announced size and digest that holds the manifest and the native binding of the platform', () => {
        const { content, candidate } = vsix();

        expect(verifyVsix(content, candidate, platform, arch)).toBeUndefined();
    });

    test('accepts a package without published digest', () => {
        const { content, candidate } = vsix();

        expect(verifyVsix(content, { ...candidate, sha256: undefined }, platform, arch)).toBeUndefined();
    });

    test('accepts the native binding of a platform whose file name has a suffix', () => {
        const { content, candidate } = vsix([MANIFEST, ['extension/dist/parser.linux-x64-gnu.node', 'binary']]);

        expect(verifyVsix(content, candidate, 'linux', 'x64')).toBeUndefined();
    });

    test('rejects a size that differs from the announced one', () => {
        const { content, candidate } = vsix();

        expect(verifyVsix(content, { ...candidate, size: candidate.size + 1 }, platform, arch)).toMatch(/expected \d+ bytes, received \d+/);
    });

    test('rejects a digest that does not match', () => {
        const { content, candidate } = vsix();

        expect(verifyVsix(content, { ...candidate, sha256: 'c'.repeat(64) }, platform, arch)).toMatch(/SHA-256 digest does not match/);
    });

    test('rejects text, even when it starts like an archive and carries the name of the binding', () => {
        const content = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('<html>rate limited</html> extension/dist/parser.darwin-arm64.node')]);
        const candidate = { ...vsix().candidate, size: content.length, sha256: undefined };

        expect(verifyVsix(content, candidate, platform, arch)).toBe('the file is not a valid zip archive');
    });

    test('rejects a truncated archive of the announced size when GitHub publishes no digest', () => {
        const content = buildZip([MANIFEST, BINDING]).subarray(0, -5);
        const candidate = { ...vsix().candidate, size: content.length, sha256: undefined };

        expect(verifyVsix(content, candidate, platform, arch)).toBe('the file is not a valid zip archive');
    });

    test('rejects an archive that is not an extension package', () => {
        const { content, candidate } = vsix([BINDING]);

        expect(verifyVsix(content, candidate, platform, arch)).toBe('the archive has no extension/package.json');
    });

    test('rejects a package that only mentions the native binding in the content of a file', () => {
        const { content, candidate } = vsix([MANIFEST, ['extension/dist/extension.js', './parser.darwin-arm64.node']]);

        expect(verifyVsix(content, candidate, platform, arch)).toBe('the package has no native binding for darwin-arm64');
    });

    test('rejects a package built for another platform than the running one', () => {
        const { content, candidate } = vsix();

        expect(verifyVsix(content, candidate, 'win32', 'x64')).toBe('the package has no native binding for win32-x64');
        expect(verifyVsix(content, candidate, 'darwin', 'x64')).toBe('the package has no native binding for darwin-x64');
    });

    test('rejects a binding stored outside the dist folder of the extension', () => {
        const { content, candidate } = vsix([MANIFEST, ['other/parser.darwin-arm64.node', 'binary']]);

        expect(verifyVsix(content, candidate, platform, arch)).toBe('the package has no native binding for darwin-arm64');
    });
});
