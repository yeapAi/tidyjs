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
const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

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

export function verifyVsix(content: Uint8Array, candidate: UpdateCandidate, platform: string, arch: string): string | undefined {
    const buffer = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
    if (buffer.length !== candidate.size) {
        return `expected ${candidate.size} bytes, received ${buffer.length}`;
    }
    if (!buffer.subarray(0, ZIP_SIGNATURE.length).equals(ZIP_SIGNATURE)) {
        return 'the file is not a zip archive';
    }
    if (candidate.sha256 && createHash('sha256').update(buffer).digest('hex') !== candidate.sha256) {
        return 'the SHA-256 digest does not match the one published by GitHub';
    }
    if (!buffer.includes(`parser.${platform}-${arch}`)) {
        return `the package has no native binding for ${platform}-${arch}`;
    }
    return undefined;
}
