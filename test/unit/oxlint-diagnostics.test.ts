import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DiagnosticsUnavailableError } from '../../src/cli/diagnostic-errors';
import { applyTextEdits, OxlintDiagnosticsProvider, readOxlintEditorSettings } from '../../src/cli/oxlint-diagnostics';
import { codeActionsRunOxlintFixAll } from '../../src/cli/workspace';
import { createFlatSettingsReader } from '../../src/core/settings';

import type { OxlintEditorSettings } from '../../src/cli/oxlint-diagnostics';

function settings(entries: Record<string, unknown>): OxlintEditorSettings {
    return readOxlintEditorSettings(createFlatSettingsReader('oxc', Object.fromEntries(Object.entries(entries).map(([key, value]) => [`oxc.${key}`, value]))));
}

describe('readOxlintEditorSettings', () => {
    test('defaults match the oxc extension', () => {
        expect(settings({})).toEqual({
            enable: true,
            binaryPath: undefined,
            server: {
                configPath: undefined,
                tsConfigPath: undefined,
                unusedDisableDirectives: undefined,
                typeAware: undefined,
                disableNestedConfig: false,
                fixKind: undefined,
                rulesCustomization: undefined,
                run: 'onType',
                flags: { disable_nested_config: 'false' },
            },
        });
    });

    test('reads the settings the oxc extension sends to the language server', () => {
        expect(settings({
            configPath: '.oxlintrc.json',
            tsConfigPath: 'tsconfig.app.json',
            unusedDisableDirectives: 'warn',
            typeAware: true,
            disableNestedConfig: true,
            fixKind: 'safe_fix_or_suggestion',
            'lint.customization': { rules: [] },
            'path.oxlint': './bin/oxlint',
        })).toMatchObject({
            binaryPath: './bin/oxlint',
            server: {
                configPath: '.oxlintrc.json',
                tsConfigPath: 'tsconfig.app.json',
                unusedDisableDirectives: 'warn',
                typeAware: true,
                disableNestedConfig: true,
                fixKind: 'safe_fix_or_suggestion',
                rulesCustomization: { rules: [] },
                flags: { disable_nested_config: 'true', fix_kind: 'safe_fix_or_suggestion' },
            },
        });
    });

    test('falls back to the legacy flags when the dedicated settings are unset', () => {
        expect(settings({ flags: { fix_kind: 'dangerous_fix', disable_nested_config: 'true' } }).server).toMatchObject({
            fixKind: 'dangerous_fix',
            disableNestedConfig: true,
        });
        expect(settings({ fixKind: 'safe_fix', flags: { fix_kind: 'dangerous_fix' } }).server.fixKind).toBe('safe_fix');
    });

    test('an explicit disableNestedConfig wins over the legacy flag, in both directions', () => {
        expect(settings({ disableNestedConfig: false, flags: { disable_nested_config: 'true' } }).server).toMatchObject({
            disableNestedConfig: false,
            flags: { disable_nested_config: 'false' },
        });
        expect(settings({ disableNestedConfig: true, flags: { disable_nested_config: 'false' } }).server.disableNestedConfig).toBe(true);
    });

    test('oxc.enable.oxlint wins over the master toggle oxc.enable, which is read independently', () => {
        expect(settings({ enable: false }).enable).toBe(false);
        expect(settings({ enable: false, 'enable.oxlint': true }).enable).toBe(true);
        expect(settings({ enable: true, 'enable.oxlint': false }).enable).toBe(false);
        expect(settings({ enable: null }).enable).toBe(true);
    });
});

describe('oxlint fixes on save', () => {
    test('codeActionsOnSave runs the oxlint fixes for source.fixAll.oxc or source.fixAll', () => {
        expect(codeActionsRunOxlintFixAll({ 'source.fixAll.oxc': 'explicit' })).toBe(true);
        expect(codeActionsRunOxlintFixAll({ 'source.fixAll.oxc': true })).toBe(true);
        expect(codeActionsRunOxlintFixAll({ 'source.fixAll': 'always' })).toBe(true);
        expect(codeActionsRunOxlintFixAll(['source.fixAll.oxc'])).toBe(true);
        expect(codeActionsRunOxlintFixAll({ 'source.fixAll': 'explicit', 'source.fixAll.oxc': 'never' })).toBe(false);
        expect(codeActionsRunOxlintFixAll({ 'source.fixAll.eslint': 'explicit' })).toBe(false);
        expect(codeActionsRunOxlintFixAll({ 'source.organizeImports': 'explicit' })).toBe(false);
        expect(codeActionsRunOxlintFixAll(undefined)).toBe(false);
    });
});

describe('applyTextEdits', () => {
    const range = (line: number, from: number, to: number) => ({ start: { line, character: from }, end: { line, character: to } });

    test('applies the edits whatever their order', () => {
        const text = 'var a = 1;\nvar b = 2;\n';

        expect(applyTextEdits(text, [
            { range: range(0, 0, 3), newText: 'let' },
            { range: range(1, 0, 3), newText: 'const' },
        ])).toBe('let a = 1;\nconst b = 2;\n');
        expect(applyTextEdits(text, [
            { range: range(1, 0, 3), newText: 'const' },
            { range: range(0, 0, 3), newText: 'let' },
        ])).toBe('let a = 1;\nconst b = 2;\n');
    });

    test('counts characters in UTF-16 code units, as the protocol does', () => {
        expect(applyTextEdits("const s = '😀'; var x = 1;", [{ range: range(0, 16, 19), newText: 'let' }])).toBe("const s = '😀'; let x = 1;");
    });

    test('inserts at a position and clamps a position past the end of the text', () => {
        expect(applyTextEdits('a\n', [{ range: range(0, 1, 1), newText: 'b' }])).toBe('ab\n');
        expect(applyTextEdits('a', [{ range: { start: { line: 5, character: 0 }, end: { line: 5, character: 0 } }, newText: '!' }])).toBe('a!');
    });

    test('keeps the text when there is no edit', () => {
        expect(applyTextEdits('a', [])).toBe('a');
    });
});

const FAKE_OXLINT = `
let buffer = Buffer.alloc(0);
let nextId = 1000;
let initializationOptions;
let configuration;
const documents = new Map();

function send(message) {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
    process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\\r\\n\\r\\n'), body]));
}

function positionAt(text, offset) {
    const before = text.slice(0, offset);
    const lines = before.split('\\n');
    return { line: lines.length - 1, character: lines[lines.length - 1].length };
}

function diagnosticsFor(text) {
    if (text.includes('CRASH')) {
        return { error: { code: -32000, message: 'boom\\nsecond line' } };
    }
    if (text.includes('DIE')) {
        process.exit(4);
    }
    const items = [];
    for (const match of text.matchAll(/unusedName/g)) {
        items.push({
            range: { start: positionAt(text, match.index), end: positionAt(text, match.index + match[0].length) },
            severity: 2,
            code: { value: 'eslint(no-unused-vars)', target: 'https://example.invalid' },
            message: "Identifier 'unusedName' is imported but never used.",
        });
    }
    if (text.includes('INFO')) {
        items.push({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 3, code: 'plain', source: 'custom', message: JSON.stringify({ pid: process.pid, cwd: process.cwd(), initializationOptions, configuration, open: documents.size }) });
    }
    return { result: { kind: 'full', items } };
}

function answerOnceConfigured(message) {
    if (configuration === undefined) {
        return setTimeout(() => answerOnceConfigured(message), 5);
    }
    send({ id: message.id, ...diagnosticsFor(documents.get(message.params.textDocument.uri)) });
}

function handle(message) {
    switch (message.method) {
        case 'initialize':
            initializationOptions = message.params.initializationOptions;
            return send({ id: message.id, result: { capabilities: {} } });
        case 'initialized':
            send({ method: '$/progress' });
            send({ method: 'window/showMessage', params: { type: 1, message: 'Failed to parse config file.\\nEOF while parsing' } });
            send({ method: 'window/showMessage', params: { type: 3, message: 'Not an error' } });
            return send({ id: nextId++, method: 'workspace/configuration', params: { items: [{ scopeUri: 'file:///x', section: 'oxc_language_server' }, { scopeUri: 'file:///x', section: 'other' }] } });
        case undefined:
            configuration = message.result;
            return;
        case 'textDocument/didOpen':
            return documents.set(message.params.textDocument.uri, message.params.textDocument.text);
        case 'textDocument/didClose':
            return documents.delete(message.params.textDocument.uri);
        case 'textDocument/diagnostic':
            return answerOnceConfigured(message);
        case 'textDocument/codeAction': {
            const uri = message.params.textDocument.uri;
            const text = documents.get(uri);
            const edits = [...text.matchAll(/var /g)].map((match) => ({ range: { start: positionAt(text, match.index), end: positionAt(text, match.index + 3) }, newText: 'let' }));
            const edit = text.includes('DOCUMENT_CHANGES') ? { documentChanges: [{ textDocument: { uri }, edits }] } : { changes: { [uri]: edits } };
            return send({ id: message.id, result: edits.length === 0 ? null : [{ kind: 'quickfix', edit: { changes: {} } }, { kind: 'source.fixAll.oxc', edit }] });
        }
    }
}

process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
        const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
        if (headerEnd < 0) {
            return;
        }
        const length = Number(/Content-Length: (\\d+)/.exec(buffer.subarray(0, headerEnd).toString())[1]);
        if (buffer.length < headerEnd + 4 + length) {
            return;
        }
        const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
        buffer = buffer.subarray(headerEnd + 4 + length);
        handle(message);
    }
});
`;

describe('OxlintDiagnosticsProvider with a fake oxlint', () => {
    let directory: string;
    let fakeOxlint: string;
    let provider: OxlintDiagnosticsProvider | undefined;

    function providerFor(entries: Record<string, unknown> = {}): OxlintDiagnosticsProvider {
        provider = new OxlintDiagnosticsProvider(settings({ 'path.oxlint': fakeOxlint, ...entries }));
        return provider;
    }

    function fileIn(root: string, name = 'src/a.ts'): string {
        return path.join(root, name);
    }

    function infoOf(diagnostics: { source?: string; message: string }[]): { pid: number; cwd: string; initializationOptions: unknown; configuration: unknown; open: number } {
        return JSON.parse(diagnostics.find((diagnostic) => diagnostic.source === 'custom')!.message);
    }

    beforeAll(() => {
        directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tidyjs-oxlint-')));
        fakeOxlint = path.join(directory, 'fake-oxlint.cjs');
        fs.writeFileSync(fakeOxlint, FAKE_OXLINT);
        fs.mkdirSync(path.join(directory, 'one'));
        fs.mkdirSync(path.join(directory, 'two'));
    });

    afterAll(() => {
        fs.rmSync(directory, { recursive: true, force: true });
    });

    afterEach(() => {
        provider?.dispose();
        provider = undefined;
    });

    test('converts the diagnostics of the server with UTF-16 offsets, severities and object codes', async () => {
        const text = "const s = '😀';\nunusedName;\n";
        const result = await providerFor().lint(fileIn(directory), text, directory);

        expect(result.status).toBe('linted');
        expect(result.workingDirectory).toBe(directory);
        expect(result.diagnostics).toEqual([{
            source: 'oxc',
            code: 'eslint(no-unused-vars)',
            message: "Identifier 'unusedName' is imported but never used.",
            severity: 'warning',
            start: text.indexOf('unusedName'),
            length: 'unusedName'.length,
        }]);
    });

    test('keeps the source and the string code of the server and maps the information severity', async () => {
        const { diagnostics } = await providerFor().lint(fileIn(directory), 'INFO', directory);

        expect(diagnostics).toEqual([expect.objectContaining({ source: 'custom', code: 'plain', severity: 'info', start: 0, length: 1 })]);
    });

    test('sends the settings of the oxc extension at initialization and when the server asks for them', async () => {
        const { diagnostics } = await providerFor({ configPath: '.oxlintrc.json', fixKind: 'safe_fix' }).lint(fileIn(directory), 'INFO', directory);
        const info = infoOf(diagnostics);
        const options = expect.objectContaining({ configPath: '.oxlintrc.json', fixKind: 'safe_fix', run: 'onType', flags: { disable_nested_config: 'false', fix_kind: 'safe_fix' } });

        expect(info.initializationOptions).toEqual([{ workspaceUri: expect.stringMatching(/^file:\/\//), options }]);
        expect(info.configuration).toEqual([options, null]);
        expect(info.cwd).toBe(directory);
    });

    test('reports the error messages of the server once, as warnings, and ignores the other messages', async () => {
        const linter = providerFor();

        expect((await linter.lint(fileIn(directory), 'x', directory)).warnings).toEqual(['Failed to parse config file. EOF while parsing']);
        expect((await linter.lint(fileIn(directory, 'src/b.ts'), 'x', directory)).warnings).toEqual([]);
    });

    test('closes each document after the request and starts one server per workspace root', async () => {
        const linter = providerFor();
        const first = infoOf((await linter.lint(fileIn(directory), 'INFO', directory)).diagnostics);
        const second = infoOf((await linter.lint(fileIn(directory, 'src/b.ts'), 'INFO', directory)).diagnostics);
        const other = infoOf((await linter.lint(fileIn(path.join(directory, 'two')), 'INFO', path.join(directory, 'two'))).diagnostics);

        expect(second.pid).toBe(first.pid);
        expect(first.open).toBe(1);
        expect(other.pid).not.toBe(first.pid);
        expect(other.cwd).toBe(path.join(directory, 'two'));
    });

    test('uses the directory of the file as root outside a workspace', async () => {
        const { diagnostics, workingDirectory } = await providerFor().lint(fileIn(path.join(directory, 'one'), 'a.ts'), 'INFO', undefined);

        expect(workingDirectory).toBe(path.join(directory, 'one'));
        expect(infoOf(diagnostics).cwd).toBe(path.join(directory, 'one'));
    });

    test('stops the servers on dispose', async () => {
        const linter = providerFor();
        const { pid } = infoOf((await linter.lint(fileIn(directory), 'INFO', directory)).diagnostics);
        linter.dispose();

        await expect(new Promise<boolean>((resolve) => {
            const started = Date.now();
            const poll = (): void => {
                try {
                    process.kill(pid, 0);
                    return Date.now() - started > 3000 ? resolve(false) : void setTimeout(poll, 25);
                } catch {
                    resolve(true);
                }
            };
            poll();
        })).resolves.toBe(true);
    });

    test('runs a Node script without extension with Node, whatever its mode and the PATH', async () => {
        const script = path.join(directory, 'oxlint-bin');
        fs.writeFileSync(script, `#!/usr/bin/env node\n${FAKE_OXLINT}`, { mode: 0o644 });

        const result = await providerFor({ 'path.oxlint': script }).lint(fileIn(directory), 'unusedName', directory);

        expect(result.status).toBe('linted');
        expect(result.diagnostics).toHaveLength(1);
    });

    test('reports disabled and not installed without starting a server', async () => {
        expect(await providerFor({ 'enable.oxlint': false }).lint(fileIn(directory), 'x', directory)).toEqual({ status: 'disabled', diagnostics: [] });
        expect(await providerFor({ 'enable.oxlint': false }).fixAll(fileIn(directory), 'x', directory)).toEqual({ status: 'disabled' });

        const bare = new OxlintDiagnosticsProvider(settings({}));
        const result = await bare.lint(fileIn(directory), 'x', directory);
        expect(result).toMatchObject({ status: 'not-installed', diagnostics: [] });
        expect(await bare.fixAll(fileIn(directory), 'x', directory)).toMatchObject({ status: 'not-installed' });
    });

    test('wraps a server error in a DiagnosticsUnavailableError that keeps its first line', async () => {
        const failure = await providerFor().lint(fileIn(directory), 'CRASH', directory).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(DiagnosticsUnavailableError);
        expect(failure).toMatchObject({ source: 'oxlint', message: 'oxlint failed: boom' });
    });

    test('reports a server that stops during a request', async () => {
        const failure = await providerFor().lint(fileIn(directory), 'DIE', directory).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(DiagnosticsUnavailableError);
        expect((failure as Error).message).toContain('language server stopped (4)');
    });

    test('applies the source.fixAll.oxc edits and ignores the other actions', async () => {
        const result = await providerFor().fixAll(fileIn(directory), 'var a = 1;\nvar b = 2;\n', directory);

        expect(result).toEqual({ status: 'linted', output: 'let a = 1;\nlet b = 2;\n', warnings: ['Failed to parse config file. EOF while parsing'], workingDirectory: directory });
    });

    test('hands the error messages of the server to the fixes too, once', async () => {
        const linter = providerFor();

        expect((await linter.fixAll(fileIn(directory), 'let a = 1;\n', directory)).warnings).toEqual(['Failed to parse config file. EOF while parsing']);
        expect((await linter.fixAll(fileIn(directory, 'src/b.ts'), 'let a = 1;\n', directory)).warnings).toEqual([]);
    });

    test('applies the edits sent as document changes', async () => {
        const result = await providerFor().fixAll(fileIn(directory), 'var a = 1; // DOCUMENT_CHANGES\n', directory);

        expect(result.output).toBe('let a = 1; // DOCUMENT_CHANGES\n');
    });

    test('returns the text unchanged when the server proposes no fix', async () => {
        expect((await providerFor().fixAll(fileIn(directory), 'let a = 1;\n', directory)).output).toBe('let a = 1;\n');
    });
});
