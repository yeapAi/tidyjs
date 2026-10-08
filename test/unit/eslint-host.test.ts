import * as childProcess from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DiagnosticsUnavailableError } from '../../src/cli/diagnostic-errors';
import { readEslintEditorSettings } from '../../src/cli/eslint-diagnostics';
import { RemoteEslintLinter } from '../../src/cli/eslint-host';
import { createSettingsReader } from '../../src/core/settings';

jest.mock('child_process', () => {
    const actual = jest.requireActual('child_process');
    return { ...actual, fork: jest.fn(actual.fork) };
});

describe('RemoteEslintLinter', () => {
    let root: string;

    beforeEach(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tidyjs-eslint-host-')));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('rejects requests once the host closed its channel but is still running', async () => {
        const script = path.join(root, 'host.cjs');
        fs.writeFileSync(script, 'process.disconnect();\nsetTimeout(() => {}, 600);\n');
        const linter = new RemoteEslintLinter(script, readEslintEditorSettings(createSettingsReader({})));
        await new Promise((resolve) => setTimeout(resolve, 300));

        await expect(linter.lint(path.join(root, 'a.ts'), '', root)).rejects.toBeInstanceOf(DiagnosticsUnavailableError);
        await expect(linter.fixAll(path.join(root, 'a.ts'), '', root)).rejects.toBeInstanceOf(DiagnosticsUnavailableError);
        linter.dispose();
        await new Promise((resolve) => setTimeout(resolve, 500));
    });

    test('rejects requests without throwing when the host could not be spawned', async () => {
        const child = Object.assign(new EventEmitter(), { connected: false });
        process.nextTick(() => child.emit('error', Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' })));
        jest.mocked(childProcess.fork).mockReturnValueOnce(child as unknown as childProcess.ChildProcess);
        const file = path.join(root, 'a.ts');

        const linter = new RemoteEslintLinter('host.js', readEslintEditorSettings(createSettingsReader({})));
        linter.warm(file, root);
        linter.prefetch([{ filePath: file, workspaceRoot: root }]);

        await expect(linter.lint(file, '', root)).rejects.toBeInstanceOf(DiagnosticsUnavailableError);
        await expect(linter.fixAll(file, '', root)).rejects.toBeInstanceOf(DiagnosticsUnavailableError);
        linter.dispose();
    });
});
