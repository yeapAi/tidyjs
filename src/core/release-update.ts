import { createHash } from 'node:crypto';

export interface ReleaseAsset {
    name: string;
    size: number;
    browser_download_url: string;
    digest?: string | null;
}

export interface ReleaseInfo {
    tag_name: string;
    draft?: boolean;
    prerelease?: boolean;
    assets: ReleaseAsset[];
}

export interface UpdateCandidate {
    version: string;
    assetName: string;
    url: string;
    size: number;
    sha256?: string;
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;
const SHA256_DIGEST_PATTERN = /^sha256:([0-9a-f]{64})$/i;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_DIRECTORY_SIGNATURE = 0x06054b50;
const END_OF_DIRECTORY_SIZE = 22;
const CENTRAL_HEADER_SIZE = 46;
const MAX_ARCHIVE_COMMENT = 0xffff;
const MANIFEST_ENTRY = 'extension/package.json';

export function parseVersion(text: string): [number, number, number] | undefined {
    const match = VERSION_PATTERN.exec(text);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

export function isNewerVersion(candidate: string, current: string): boolean {
    const candidateParts = parseVersion(candidate);
    const currentParts = parseVersion(current);
    if (!candidateParts || !currentParts) {
        return false;
    }
    for (let index = 0; index < candidateParts.length; index++) {
        if (candidateParts[index] !== currentParts[index]) {
            return candidateParts[index] > currentParts[index];
        }
    }
    return false;
}

export function selectUpdate(release: ReleaseInfo, currentVersion: string, repository: string): UpdateCandidate | undefined {
    if (release.draft || release.prerelease || !parseVersion(release.tag_name)) {
        return undefined;
    }
    const version = release.tag_name.replace(/^v/, '');
    if (!isNewerVersion(version, currentVersion)) {
        return undefined;
    }

    const assetName = `tidyjs-${version}.vsix`;
    const asset = release.assets.find((candidate) => candidate.name === assetName);
    const expectedUrl = `https://github.com/${repository}/releases/download/${release.tag_name}/${assetName}`;
    if (!asset || asset.browser_download_url !== expectedUrl || !Number.isInteger(asset.size) || asset.size <= 0) {
        return undefined;
    }

    return { version, assetName, url: asset.browser_download_url, size: asset.size, sha256: SHA256_DIGEST_PATTERN.exec(asset.digest ?? '')?.[1].toLowerCase() };
}

function findEndOfDirectory(buffer: Buffer): number {
    const lowest = Math.max(0, buffer.length - END_OF_DIRECTORY_SIZE - MAX_ARCHIVE_COMMENT);
    for (let offset = buffer.length - END_OF_DIRECTORY_SIZE; offset >= lowest; offset--) {
        if (buffer.readUInt32LE(offset) === END_OF_DIRECTORY_SIGNATURE && offset + END_OF_DIRECTORY_SIZE + buffer.readUInt16LE(offset + 20) === buffer.length) {
            return offset;
        }
    }
    return -1;
}

export function listZipEntries(content: Uint8Array): string[] | undefined {
    const buffer = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
    const end = findEndOfDirectory(buffer);
    if (end < 0) {
        return undefined;
    }

    const entryCount = buffer.readUInt16LE(end + 10);
    const directorySize = buffer.readUInt32LE(end + 12);
    const directoryOffset = buffer.readUInt32LE(end + 16);
    if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff || directoryOffset + directorySize !== end) {
        return undefined;
    }

    const names: string[] = [];
    let offset = directoryOffset;
    for (let index = 0; index < entryCount; index++) {
        if (offset + CENTRAL_HEADER_SIZE > end || buffer.readUInt32LE(offset) !== CENTRAL_HEADER_SIGNATURE) {
            return undefined;
        }
        const nameLength = buffer.readUInt16LE(offset + 28);
        const next = offset + CENTRAL_HEADER_SIZE + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
        const localHeaderOffset = buffer.readUInt32LE(offset + 42);
        if (next > end || localHeaderOffset + 4 > directoryOffset || buffer.readUInt32LE(localHeaderOffset) !== LOCAL_HEADER_SIGNATURE) {
            return undefined;
        }
        names.push(buffer.toString('utf8', offset + CENTRAL_HEADER_SIZE, offset + CENTRAL_HEADER_SIZE + nameLength));
        offset = next;
    }
    return offset === end ? names : undefined;
}

export function verifyVsix(content: Uint8Array, candidate: UpdateCandidate, platform: string, arch: string): string | undefined {
    const buffer = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
    if (buffer.length !== candidate.size) {
        return `expected ${candidate.size} bytes, received ${buffer.length}`;
    }
    if (candidate.sha256 && createHash('sha256').update(buffer).digest('hex') !== candidate.sha256) {
        return 'the SHA-256 digest does not match the one published by GitHub';
    }
    const entries = listZipEntries(buffer);
    if (!entries) {
        return 'the file is not a valid zip archive';
    }
    if (!entries.includes(MANIFEST_ENTRY)) {
        return `the archive has no ${MANIFEST_ENTRY}`;
    }
    const bindingPrefix = `extension/dist/parser.${platform}-${arch}`;
    if (!entries.some((name) => name.startsWith(bindingPrefix) && name.endsWith('.node'))) {
        return `the package has no native binding for ${platform}-${arch}`;
    }
    return undefined;
}
