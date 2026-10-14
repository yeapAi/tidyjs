import * as fs from 'fs';
import * as path from 'path';
import { commands, ExtensionMode, Uri, window, workspace } from 'vscode';

import { selectUpdate, verifyVsix } from '../core/release-update';
import { logDebug, logError } from '../utils/log';

import type { Disposable, ExtensionContext } from 'vscode';
import type { ReleaseInfo, UpdateCandidate } from '../core/release-update';

export const UPDATE_REPOSITORY = 'yeapAi/tidyjs';

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;
const LAST_CHECK_KEY = 'tidyjs.autoUpdate.lastCheck';
const USER_AGENT = 'tidyjs-vscode-extension';

export type UpdateOutcome = 'up-to-date' | 'installed' | 'failed' | 'skipped';

export interface ReleaseSource {
    latestRelease(): Promise<ReleaseInfo>;
    download(candidate: UpdateCandidate): Promise<Uint8Array>;
}

export class GitHubReleaseSource implements ReleaseSource {
    constructor(private readonly repository: string) {}

    async latestRelease(): Promise<ReleaseInfo> {
        const response = await fetch(`https://api.github.com/repos/${this.repository}/releases/latest`, {
            headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': USER_AGENT },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) {
            throw new Error(`GitHub answered ${response.status} for the latest release`);
        }
        return await response.json() as ReleaseInfo;
    }

    async download(candidate: UpdateCandidate): Promise<Uint8Array> {
        if (candidate.size > MAX_PACKAGE_BYTES) {
            throw new Error(`${candidate.assetName} is ${candidate.size} bytes, above the ${MAX_PACKAGE_BYTES} bytes allowed`);
        }
        const response = await fetch(candidate.url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (!response.ok) {
            throw new Error(`GitHub answered ${response.status} for ${candidate.assetName}`);
        }
        return new Uint8Array(await response.arrayBuffer());
    }
}

export class AutoUpdater implements Disposable {
    private timer: NodeJS.Timeout | undefined;
    private running = false;

    constructor(
        private readonly context: ExtensionContext,
        private readonly source: ReleaseSource = new GitHubReleaseSource(UPDATE_REPOSITORY),
        private readonly now: () => number = Date.now
    ) {}

    schedule(): void {
        if (!this.isInstalledPackage()) {
            logDebug('Automatic update skipped: the extension is not running from an installed package');
            return;
        }
        if (!workspace.getConfiguration('tidyjs').get<boolean>('autoUpdate', true)) {
            logDebug('Automatic update disabled by tidyjs.autoUpdate');
            return;
        }
        const lastCheck = this.context.globalState.get<number>(LAST_CHECK_KEY, 0);
        if (this.now() - lastCheck < CHECK_INTERVAL_MS) {
            return;
        }
        this.timer = setTimeout(() => void this.checkNow(false), STARTUP_DELAY_MS);
    }

    async checkNow(interactive = true): Promise<UpdateOutcome> {
        if (!this.isInstalledPackage()) {
            logDebug('Update check skipped: the extension is not running from an installed package');
            if (interactive) {
                void window.showInformationMessage('TidyJS only updates itself when it runs from an installed package.');
            }
            return 'skipped';
        }
        if (this.running) {
            return 'up-to-date';
        }
        this.running = true;
        try {
            await this.context.globalState.update(LAST_CHECK_KEY, this.now());
            return await this.checkAndInstall(interactive);
        } finally {
            this.running = false;
        }
    }

    dispose(): void {
        clearTimeout(this.timer);
    }

    private isInstalledPackage(): boolean {
        return this.context.extensionMode === ExtensionMode.Production;
    }

    private async checkAndInstall(interactive: boolean): Promise<UpdateOutcome> {
        const currentVersion = this.context.extension.packageJSON.version as string;
        try {
            const candidate = selectUpdate(await this.source.latestRelease(), currentVersion, UPDATE_REPOSITORY);
            if (!candidate) {
                logDebug(`TidyJS ${currentVersion} is up to date`);
                if (interactive) {
                    void window.showInformationMessage(`TidyJS ${currentVersion} is up to date.`);
                }
                return 'up-to-date';
            }

            const content = await this.source.download(candidate);
            const problem = verifyVsix(content, candidate, process.platform, process.arch);
            if (problem) {
                throw new Error(`${candidate.assetName} rejected: ${problem}`);
            }
            await this.install(candidate, content);
            void this.offerReload(candidate.version);
            return 'installed';
        } catch (error) {
            logError('Automatic update failed:', error);
            if (interactive) {
                void window.showErrorMessage(`TidyJS could not check for updates: ${error instanceof Error ? error.message : String(error)}`);
            }
            return 'failed';
        }
    }

    private async install(candidate: UpdateCandidate, content: Uint8Array): Promise<void> {
        const directory = this.context.globalStorageUri.fsPath;
        const packagePath = path.join(directory, candidate.assetName);
        await fs.promises.mkdir(directory, { recursive: true });
        await fs.promises.writeFile(packagePath, content);
        try {
            await commands.executeCommand('workbench.extensions.installExtension', Uri.file(packagePath));
            logDebug(`TidyJS ${candidate.version} installed from ${candidate.url}`);
        } finally {
            await fs.promises.rm(packagePath, { force: true });
        }
    }

    private async offerReload(version: string): Promise<void> {
        const choice = await window.showInformationMessage(`TidyJS ${version} has been installed. Reload the window to use it.`, 'Reload');
        if (choice === 'Reload') {
            await commands.executeCommand('workbench.action.reloadWindow');
        }
    }
}
