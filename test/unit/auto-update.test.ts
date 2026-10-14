import { createHash } from 'node:crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AutoUpdater } from '../../src/vscode/auto-update';
import { buildZip } from '../zip-fixture';

import type { ReleaseSource } from '../../src/vscode/auto-update';

const mockExecuteCommand = jest.fn();
const mockShowInformationMessage = jest.fn();
const mockShowErrorMessage = jest.fn();
const mockGetConfiguration = jest.fn();

jest.mock('vscode', () => ({
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    Uri: { file: (fsPath: string) => ({ fsPath, scheme: 'file' }) },
    commands: { executeCommand: (...args: unknown[]) => mockExecuteCommand(...args) },
    window: {
        showInformationMessage: (...args: unknown[]) => mockShowInformationMessage(...args),
        showErrorMessage: (...args: unknown[]) => mockShowErrorMessage(...args),
    },
    workspace: { getConfiguration: (...args: unknown[]) => mockGetConfiguration(...args) },
}));

jest.mock('../../src/utils/log', () => ({ logDebug: jest.fn(), logError: jest.fn() }));

const { logError } = jest.requireMock('../../src/utils/log') as { logError: jest.Mock };

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function fakeVsix(version: string): { content: Buffer; release: Awaited<ReturnType<ReleaseSource['latestRelease']>> } {
    const content = buildZip([
        ['extension/package.json', `{ "version": "${version}" }`],
        [`extension/dist/parser.${process.platform}-${process.arch}.node`, `version ${version}`],
    ]);
    return {
        content,
        release: {
            tag_name: `v${version}`,
            assets: [{
                name: `tidyjs-${version}.vsix`,
                size: content.length,
                browser_download_url: `https://github.com/yeapAi/tidyjs/releases/download/v${version}/tidyjs-${version}.vsix`,
                digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
            }],
        },
    };
}

describe('AutoUpdater', () => {
    let storage: string;
    let state: Map<string, unknown>;
    let installedFiles: string[];

    function context(overrides: { mode?: number; version?: string } = {}) {
        return {
            extensionMode: overrides.mode ?? 1,
            extension: { packageJSON: { version: overrides.version ?? '2.0.1' } },
            globalState: {
                get: <T>(key: string, fallback: T): T => (state.has(key) ? state.get(key) as T : fallback),
                update: async (key: string, value: unknown): Promise<void> => { state.set(key, value); },
            },
            globalStorageUri: { fsPath: storage },
        } as never;
    }

    function source(version: string): { source: ReleaseSource & { latestRelease: jest.Mock; download: jest.Mock }; content: Buffer } {
        const { content, release } = fakeVsix(version);
        return {
            content,
            source: {
                latestRelease: jest.fn(async () => release),
                download: jest.fn(async () => new Uint8Array(content)),
            },
        };
    }

    beforeEach(() => {
        jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
        storage = fs.mkdtempSync(path.join(os.tmpdir(), 'tidyjs-update-'));
        state = new Map();
        installedFiles = [];
        mockExecuteCommand.mockReset().mockImplementation(async (command: string, uri?: { fsPath: string }) => {
            if (command === 'workbench.extensions.installExtension' && uri) {
                installedFiles.push(fs.readFileSync(uri.fsPath).toString('latin1'));
            }
        });
        mockShowInformationMessage.mockReset().mockResolvedValue(undefined);
        mockShowErrorMessage.mockReset();
        mockGetConfiguration.mockReset().mockReturnValue({ get: (_key: string, fallback: unknown) => fallback });
        logError.mockReset();
    });

    afterEach(() => {
        jest.useRealTimers();
        fs.rmSync(storage, { recursive: true, force: true });
    });

    describe('schedule', () => {
        test('checks once, after the startup delay, when the last check is older than a day', async () => {
            const { source: releases } = source('2.0.2');
            const updater = new AutoUpdater(context(), releases, () => NOW);

            updater.schedule();
            expect(releases.latestRelease).not.toHaveBeenCalled();
            await jest.advanceTimersByTimeAsync(14_000);
            expect(releases.latestRelease).not.toHaveBeenCalled();
            await jest.advanceTimersByTimeAsync(2_000);

            expect(releases.latestRelease).toHaveBeenCalledTimes(1);
            expect(state.get('tidyjs.autoUpdate.lastCheck')).toBe(NOW);
            updater.dispose();
        });

        test.each([
            ['the extension runs in development', { mode: 2 }, {}],
            ['the extension runs in a test host', { mode: 3 }, {}],
            ['tidyjs.autoUpdate is false', {}, { 'tidyjs.autoUpdate': false }],
        ])('does nothing when %s', async (_label, contextOptions, settings) => {
            mockGetConfiguration.mockReturnValue({ get: (key: string, fallback: unknown) => (`tidyjs.${key}` in settings ? (settings as Record<string, unknown>)[`tidyjs.${key}`] : fallback) });
            const { source: releases } = source('2.0.2');
            const updater = new AutoUpdater(context(contextOptions), releases, () => NOW);

            updater.schedule();
            await jest.advanceTimersByTimeAsync(60_000);

            expect(releases.latestRelease).not.toHaveBeenCalled();
            updater.dispose();
        });

        test('waits for a full day after the last check', async () => {
            const { source: releases } = source('2.0.2');
            state.set('tidyjs.autoUpdate.lastCheck', NOW - DAY + 1);
            new AutoUpdater(context(), releases, () => NOW).schedule();
            await jest.advanceTimersByTimeAsync(60_000);
            expect(releases.latestRelease).not.toHaveBeenCalled();

            state.set('tidyjs.autoUpdate.lastCheck', NOW - DAY);
            const updater = new AutoUpdater(context(), releases, () => NOW);
            updater.schedule();
            await jest.advanceTimersByTimeAsync(16_000);
            expect(releases.latestRelease).toHaveBeenCalledTimes(1);
            updater.dispose();
        });

        test('dispose cancels the pending check', async () => {
            const { source: releases } = source('2.0.2');
            const updater = new AutoUpdater(context(), releases, () => NOW);

            updater.schedule();
            updater.dispose();
            await jest.advanceTimersByTimeAsync(60_000);

            expect(releases.latestRelease).not.toHaveBeenCalled();
        });
    });

    describe('checkNow', () => {
        test.each([
            ['in development', 2],
            ['in a test host', 3],
        ])('installs nothing %s, even when asked', async (_label, mode) => {
            const { source: releases } = source('2.0.2');
            const updater = new AutoUpdater(context({ mode }), releases, () => NOW);

            expect(await updater.checkNow(true)).toBe('skipped');
            expect(await updater.checkNow(false)).toBe('skipped');

            expect(releases.latestRelease).not.toHaveBeenCalled();
            expect(releases.download).not.toHaveBeenCalled();
            expect(mockExecuteCommand).not.toHaveBeenCalled();
            expect(mockShowInformationMessage).toHaveBeenCalledTimes(1);
            expect(mockShowInformationMessage).toHaveBeenCalledWith('TidyJS only updates itself when it runs from an installed package.');
            expect(state.has('tidyjs.autoUpdate.lastCheck')).toBe(false);
        });

        test('installs a newer release through the VS Code command, then removes the downloaded package', async () => {
            const { source: releases, content } = source('2.0.2');

            const outcome = await new AutoUpdater(context(), releases, () => NOW).checkNow();

            expect(outcome).toBe('installed');
            expect(mockExecuteCommand).toHaveBeenCalledWith('workbench.extensions.installExtension', { fsPath: path.join(storage, 'tidyjs-2.0.2.vsix'), scheme: 'file' });
            expect(installedFiles).toEqual([content.toString('latin1')]);
            expect(fs.readdirSync(storage)).toEqual([]);
        });

        test('offers a reload and reloads the window when accepted', async () => {
            mockShowInformationMessage.mockResolvedValue('Reload');
            const { source: releases } = source('2.0.2');

            await new AutoUpdater(context(), releases, () => NOW).checkNow(false);
            await jest.advanceTimersByTimeAsync(0);

            expect(mockShowInformationMessage).toHaveBeenCalledWith('TidyJS 2.0.2 has been installed. Reload the window to use it.', 'Reload');
            expect(mockExecuteCommand).toHaveBeenLastCalledWith('workbench.action.reloadWindow');
        });

        test('does not reload when the offer is dismissed', async () => {
            const { source: releases } = source('2.0.2');

            await new AutoUpdater(context(), releases, () => NOW).checkNow(false);
            await jest.advanceTimersByTimeAsync(0);

            expect(mockExecuteCommand).not.toHaveBeenCalledWith('workbench.action.reloadWindow');
        });

        test('reports an up-to-date version only when asked, and downloads nothing', async () => {
            const { source: releases } = source('2.0.1');

            expect(await new AutoUpdater(context(), releases, () => NOW).checkNow(false)).toBe('up-to-date');
            expect(mockShowInformationMessage).not.toHaveBeenCalled();
            expect(await new AutoUpdater(context(), releases, () => NOW).checkNow(true)).toBe('up-to-date');
            expect(mockShowInformationMessage).toHaveBeenCalledWith('TidyJS 2.0.1 is up to date.');
            expect(releases.download).not.toHaveBeenCalled();
            expect(mockExecuteCommand).not.toHaveBeenCalled();
        });

        test('never downgrades', async () => {
            const { source: releases } = source('2.0.0');

            expect(await new AutoUpdater(context(), releases, () => NOW).checkNow(false)).toBe('up-to-date');
            expect(releases.download).not.toHaveBeenCalled();
        });

        test('installs nothing when the download does not match the digest published by GitHub', async () => {
            const { source: releases, content } = source('2.0.2');
            const tampered = Buffer.from(content);
            tampered[tampered.length - 1] ^= 0xff;
            releases.download.mockResolvedValue(new Uint8Array(tampered));

            const outcome = await new AutoUpdater(context(), releases, () => NOW).checkNow(true);

            expect(outcome).toBe('failed');
            expect(mockExecuteCommand).not.toHaveBeenCalled();
            expect(fs.readdirSync(storage)).toEqual([]);
            expect(mockShowErrorMessage).toHaveBeenCalledWith(expect.stringContaining('SHA-256 digest does not match'));
            expect(logError).toHaveBeenCalled();
        });

        test('is silent about a failure unless asked', async () => {
            const { source: releases } = source('2.0.2');
            releases.latestRelease.mockRejectedValue(new Error('offline'));

            expect(await new AutoUpdater(context(), releases, () => NOW).checkNow(false)).toBe('failed');
            expect(mockShowErrorMessage).not.toHaveBeenCalled();
            expect(logError).toHaveBeenCalledWith('Automatic update failed:', expect.objectContaining({ message: 'offline' }));

            expect(await new AutoUpdater(context(), releases, () => NOW).checkNow(true)).toBe('failed');
            expect(mockShowErrorMessage).toHaveBeenCalledWith('TidyJS could not check for updates: offline');
        });

        test('removes the downloaded package when VS Code refuses to install it', async () => {
            const { source: releases } = source('2.0.2');
            mockExecuteCommand.mockRejectedValue(new Error('not allowed'));

            expect(await new AutoUpdater(context(), releases, () => NOW).checkNow(false)).toBe('failed');
            expect(fs.readdirSync(storage)).toEqual([]);
            expect(mockShowInformationMessage).not.toHaveBeenCalled();
        });

        test('records the check before running it, so a failing check is not repeated at every startup', async () => {
            const { source: releases } = source('2.0.2');
            releases.latestRelease.mockRejectedValue(new Error('offline'));

            await new AutoUpdater(context(), releases, () => NOW).checkNow(false);

            expect(state.get('tidyjs.autoUpdate.lastCheck')).toBe(NOW);
        });

        test('ignores a second check while one is running', async () => {
            const { source: releases } = source('2.0.2');
            let release!: () => void;
            releases.latestRelease.mockImplementationOnce(() => new Promise((resolve) => {
                release = () => resolve(fakeVsix('2.0.2').release);
            }));
            const updater = new AutoUpdater(context(), releases, () => NOW);

            const first = updater.checkNow(false);
            await jest.advanceTimersByTimeAsync(0);
            expect(await updater.checkNow(false)).toBe('up-to-date');
            release();
            expect(await first).toBe('installed');

            expect(releases.latestRelease).toHaveBeenCalledTimes(1);
        });
    });
});
