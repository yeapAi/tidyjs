import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { resolveConfigForFile, serializeConfig } from '../../src/core/config';
import {
    contributedDefaults,
    createSettingsReader,
    getSettingsSection,
    mergeSettingsTrees,
    settingsTreeFromFlatEntries,
} from '../../src/core/settings';
import { createCliWorkspace } from '../../src/cli/workspace';

jest.mock('../../src/utils/log', () => ({
    logDebug: jest.fn(),
    logError: jest.fn(),
}));

const mockState: { root: string; settings: Record<string, unknown> } = { root: '', settings: {} };

jest.mock('vscode', () => {
    const actual = jest.requireActual('../../test/mocks/vscode');
    return {
        ...actual,
        workspace: {
            ...actual.workspace,
            onDidChangeConfiguration: () => ({ dispose: () => undefined }),
            getWorkspaceFolder: (uri: { fsPath: string }) => (uri.fsPath.startsWith(mockState.root)
                ? { uri: { fsPath: mockState.root }, name: 'ws', index: 0 }
                : undefined),
            getConfiguration: () => mockState.settings,
        },
    };
});

import { Uri } from 'vscode';
import { configManager } from '../../src/vscode/config-manager';

const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));

function write(relativePath: string, content: string): string {
    const fullPath = path.join(mockState.root, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
    return fullPath;
}

function useWorkspaceSettings(entries: Record<string, unknown>): void {
    write('.vscode/settings.json', JSON.stringify(entries));
    const tree = mergeSettingsTrees(settingsTreeFromFlatEntries(contributedDefaults(packageJson)), settingsTreeFromFlatEntries(entries));
    mockState.settings = createSettingsReader(getSettingsSection(tree, 'tidyjs')) as unknown as Record<string, unknown>;
}

async function resolveBoth(filePath: string): Promise<[string, string]> {
    configManager.clearDocumentCache();
    const vscodeConfig = await configManager.getConfigForUri(Uri.file(filePath) as never);
    const cliWorkspace = createCliWorkspace(mockState.root, packageJson);
    const cliConfig = await resolveConfigForFile(filePath, cliWorkspace.resolutionContext(filePath));
    return [serializeConfig(vscodeConfig), serializeConfig(cliConfig)];
}

describe('config resolution parity between the VS Code and CLI adapters', () => {
    beforeEach(() => {
        mockState.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tidyjs-parity-')));
    });

    afterEach(() => {
        fs.rmSync(mockState.root, { recursive: true, force: true });
    });

    test('defaults only', async () => {
        useWorkspaceSettings({});
        const [vscodeConfig, cliConfig] = await resolveBoth(write('src/a.ts', ''));
        expect(cliConfig).toBe(vscodeConfig);
    });

    test('workspace settings under a tidyjs.json with extends and groups without order', async () => {
        useWorkspaceSettings({
            'tidyjs.format.bracketSpacing': false,
            'tidyjs.importOrder': { default: 5 },
            'tidyjs.pathResolution.aliases': { '@x/*': ['src/x/*'] },
            'tidyjs.excludedFolders': ['dist'],
        });
        write('tidyjs.json', JSON.stringify({ format: { indent: 2, removeUnusedImports: true }, excludedFolders: ['legacy'] }));
        write('app/tidyjs.json', JSON.stringify({
            extends: '../tidyjs.json',
            groups: [{ name: 'React', match: '^react' }, { name: 'Other', default: true }],
            pathResolution: { mode: 'absolute' },
        }));

        const [vscodeConfig, cliConfig] = await resolveBoth(write('app/src/b.tsx', ''));
        expect(cliConfig).toBe(vscodeConfig);
        expect(JSON.parse(cliConfig).format.bracketSpacing).toBe(false);
        expect(JSON.parse(cliConfig).groups.map((group: { order: number }) => group.order)).toEqual([999, 1000]);
    });

    test('groups declared in workspace settings', async () => {
        useWorkspaceSettings({ 'tidyjs.groups': [{ name: 'Lib', match: '^lib' }, { name: 'Rest', default: true, order: 1 }] });
        const [vscodeConfig, cliConfig] = await resolveBoth(write('c.js', ''));
        expect(cliConfig).toBe(vscodeConfig);
    });
});
