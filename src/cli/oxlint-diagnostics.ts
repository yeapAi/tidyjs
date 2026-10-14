import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

import { DiagnosticsUnavailableError } from './diagnostic-errors';
import { LanguageServerConnection } from './lsp-connection';
import { languageIdFor } from './workspace';

import type { SettingsReader } from '../core/config';
import type { TidyDiagnostic, TidyDiagnosticSeverity } from '../core/diagnostics';
import type { Linter, LinterFixResult, LinterLintResult } from './linter';

const SERVER_CONFIGURATION_SECTION = 'oxc_language_server';
const FIX_ALL_KIND = 'source.fixAll.oxc';
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);
const SEVERITY_BY_LSP: Record<number, TidyDiagnosticSeverity> = { 1: 'error', 2: 'warning', 3: 'info', 4: 'hint' };
const SHOW_MESSAGE_ERROR = 1;

export interface OxlintServerOptions {
    configPath?: string;
    tsConfigPath?: string;
    unusedDisableDirectives?: string;
    typeAware?: boolean;
    disableNestedConfig: boolean;
    fixKind?: string;
    rulesCustomization?: unknown;
    run: 'onType';
    flags: Record<string, string>;
}

export interface OxlintEditorSettings {
    enable: boolean;
    binaryPath?: string;
    server: OxlintServerOptions;
}

interface LspPosition { line: number; character: number }
interface LspRange { start: LspPosition; end: LspPosition }
interface LspTextEdit { range: LspRange; newText: string }

interface LspDiagnostic {
    range: LspRange;
    severity?: number;
    code?: string | number | { value: string | number };
    source?: string;
    message: string;
}

interface LspCodeAction {
    kind?: string;
    edit?: {
        changes?: Record<string, LspTextEdit[]>;
        documentChanges?: { textDocument: { uri: string }; edits: LspTextEdit[] }[];
    };
}

interface OxlintExecutable {
    command: string;
    args: string[];
    path: string;
}

function asBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

export function readOxlintEditorSettings(reader: SettingsReader): OxlintEditorSettings {
    const flags = reader.get<unknown>('flags');
    const flagValues = typeof flags === 'object' && flags !== null && !Array.isArray(flags) ? flags as Record<string, unknown> : {};
    const fixKind = asString(reader.get('fixKind')) ?? asString(flagValues.fix_kind);
    const disableNestedConfig = asBoolean(reader.get('disableNestedConfig')) === true || flagValues.disable_nested_config === 'true';

    return {
        enable: asBoolean(reader.get('enable.oxlint')) ?? asBoolean(reader.get('enable')) ?? true,
        binaryPath: asString(reader.get('path.oxlint')),
        server: {
            configPath: asString(reader.get('configPath')),
            tsConfigPath: asString(reader.get('tsConfigPath')),
            unusedDisableDirectives: asString(reader.get('unusedDisableDirectives')),
            typeAware: asBoolean(reader.get('typeAware')),
            disableNestedConfig,
            fixKind,
            rulesCustomization: reader.get<unknown>('lint.customization') ?? undefined,
            run: 'onType',
            flags: { disable_nested_config: String(disableNestedConfig), ...fixKind ? { fix_kind: fixKind } : {} },
        },
    };
}

function computeLineStarts(text: string): number[] {
    const starts = [0];
    for (let index = 0; index < text.length; index++) {
        if (text.charCodeAt(index) === 10) {
            starts.push(index + 1);
        }
    }
    return starts;
}

function offsetAt(lineStarts: number[], position: LspPosition, textLength: number): number {
    return position.line >= lineStarts.length ? textLength : Math.min(lineStarts[position.line] + position.character, textLength);
}

export function applyTextEdits(text: string, edits: LspTextEdit[]): string {
    const lineStarts = computeLineStarts(text);
    return edits
        .map((edit) => ({ start: offsetAt(lineStarts, edit.range.start, text.length), end: offsetAt(lineStarts, edit.range.end, text.length), newText: edit.newText }))
        .sort((left, right) => right.start - left.start || right.end - left.end)
        .reduce((result, edit) => result.slice(0, edit.start) + edit.newText + result.slice(edit.end), text);
}

function isNodeScript(filePath: string): boolean {
    if (SCRIPT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
        return true;
    }
    try {
        const descriptor = fs.openSync(filePath, 'r');
        try {
            const head = Buffer.alloc(64);
            fs.readSync(descriptor, head, 0, head.length, 0);
            return /^#!.*\bnode\b/.test(head.toString('utf8'));
        } finally {
            fs.closeSync(descriptor);
        }
    } catch {
        return false;
    }
}

function executableFor(binaryPath: string): OxlintExecutable {
    return isNodeScript(binaryPath)
        ? { command: process.execPath, args: [binaryPath, '--lsp'], path: binaryPath }
        : { command: binaryPath, args: ['--lsp'], path: binaryPath };
}

function findInstalledOxlint(startDirectory: string): string | undefined {
    for (let directory = startDirectory; ; directory = path.dirname(directory)) {
        const manifestPath = path.join(directory, 'node_modules', 'oxlint', 'package.json');
        if (fs.existsSync(manifestPath)) {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { bin?: string | Record<string, string> };
            const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.oxlint;
            if (bin) {
                return path.join(path.dirname(manifestPath), bin);
            }
        }
        if (path.dirname(directory) === directory) {
            return undefined;
        }
    }
}

function resolveExecutable(settings: OxlintEditorSettings, filePath: string, workspaceRoot: string): OxlintExecutable | undefined {
    if (settings.binaryPath) {
        return executableFor(path.resolve(workspaceRoot, settings.binaryPath));
    }
    const installed = findInstalledOxlint(workspaceRoot) ?? findInstalledOxlint(path.dirname(filePath));
    return installed ? executableFor(installed) : undefined;
}

class OxlintServer {
    private constructor(private readonly connection: LanguageServerConnection, private readonly notices: string[]) {}

    static async start(executable: OxlintExecutable, workspaceRoot: string, options: OxlintServerOptions): Promise<OxlintServer> {
        const notices: string[] = [];
        const connection = new LanguageServerConnection(executable.command, executable.args, workspaceRoot, (method, params) => {
            if (method === 'workspace/configuration') {
                return (params as { items: { section?: string }[] }).items.map((item) => (item.section === SERVER_CONFIGURATION_SECTION ? options : null));
            }
            return null;
        }, (method, params) => {
            const { type, message } = params as { type?: number; message?: string };
            if (method === 'window/showMessage' && type === SHOW_MESSAGE_ERROR && message) {
                notices.push(message.replace(/\s*\n\s*/g, ' '));
            }
        });
        const workspaceUri = pathToFileURL(workspaceRoot).href;
        try {
            await connection.request('initialize', {
                processId: process.pid,
                rootUri: workspaceUri,
                workspaceFolders: [{ uri: workspaceUri, name: path.basename(workspaceRoot) }],
                capabilities: {
                    workspace: { configuration: true, workspaceFolders: true },
                    textDocument: {
                        publishDiagnostics: {},
                        diagnostic: { dynamicRegistration: true },
                        codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: [FIX_ALL_KIND] } } },
                    },
                },
                initializationOptions: [{ workspaceUri, options }],
            });
        } catch (error) {
            connection.dispose();
            throw error;
        }
        connection.notify('initialized', {});
        return new OxlintServer(connection, notices);
    }

    async diagnose(filePath: string, text: string): Promise<LspDiagnostic[]> {
        return this.withDocument(filePath, text, async (uri) => {
            const report = await this.connection.request<{ items?: LspDiagnostic[] } | null>('textDocument/diagnostic', { textDocument: { uri } });
            return report?.items ?? [];
        });
    }

    async fixAll(filePath: string, text: string): Promise<string> {
        return this.withDocument(filePath, text, async (uri) => {
            const actions = await this.connection.request<LspCodeAction[] | null>('textDocument/codeAction', {
                textDocument: { uri },
                range: { start: { line: 0, character: 0 }, end: { line: computeLineStarts(text).length, character: 0 } },
                context: { diagnostics: [], only: [FIX_ALL_KIND] },
            });
            const edits = (actions ?? [])
                .filter((action) => action.kind === FIX_ALL_KIND)
                .flatMap((action) => [
                    ...action.edit?.changes?.[uri] ?? [],
                    ...(action.edit?.documentChanges ?? []).filter((change) => change.textDocument.uri === uri).flatMap((change) => change.edits),
                ]);
            return applyTextEdits(text, edits);
        });
    }

    takeNotices(): string[] {
        return this.notices.splice(0);
    }

    dispose(): void {
        this.connection.dispose();
    }

    private async withDocument<Result>(filePath: string, text: string, action: (uri: string) => Promise<Result>): Promise<Result> {
        const uri = pathToFileURL(filePath).href;
        this.connection.notify('textDocument/didOpen', { textDocument: { uri, languageId: languageIdFor(filePath), version: 1, text } });
        try {
            return await action(uri);
        } finally {
            this.connection.notify('textDocument/didClose', { textDocument: { uri } });
        }
    }
}

export class OxlintDiagnosticsProvider implements Linter {
    readonly name = 'oxlint';
    private readonly servers = new Map<string, Promise<OxlintServer>>();

    constructor(private readonly settings: OxlintEditorSettings) {}

    private locate(filePath: string, workspaceRoot: string | undefined): { workingDirectory: string; executable: OxlintExecutable | undefined } {
        const workingDirectory = workspaceRoot ?? path.dirname(filePath);
        return { workingDirectory, executable: resolveExecutable(this.settings, filePath, workingDirectory) };
    }

    private serverFor(executable: OxlintExecutable, workingDirectory: string): Promise<OxlintServer> {
        const key = `${executable.path}\0${workingDirectory}`;
        let server = this.servers.get(key);
        if (!server) {
            server = OxlintServer.start(executable, workingDirectory, this.settings.server);
            this.servers.set(key, server);
        }
        return server;
    }

    async lint(filePath: string, text: string, workspaceRoot: string | undefined): Promise<LinterLintResult> {
        if (!this.settings.enable) {
            return { status: 'disabled', diagnostics: [] };
        }
        const { workingDirectory, executable } = this.locate(filePath, workspaceRoot);
        if (!executable) {
            return { status: 'not-installed', diagnostics: [], workingDirectory };
        }

        let reported: LspDiagnostic[];
        let warnings: string[];
        try {
            const server = await this.serverFor(executable, workingDirectory);
            reported = await server.diagnose(filePath, text);
            warnings = server.takeNotices();
        } catch (error) {
            throw new DiagnosticsUnavailableError('oxlint', `oxlint failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
        }

        const lineStarts = computeLineStarts(text);
        const diagnostics = reported.map((diagnostic): TidyDiagnostic => {
            const start = offsetAt(lineStarts, diagnostic.range.start, text.length);
            return {
                source: diagnostic.source ?? 'oxc',
                code: typeof diagnostic.code === 'object' ? diagnostic.code.value : diagnostic.code,
                message: diagnostic.message,
                severity: SEVERITY_BY_LSP[diagnostic.severity ?? 1] ?? 'error',
                start,
                length: offsetAt(lineStarts, diagnostic.range.end, text.length) - start,
            };
        });
        return { status: 'linted', diagnostics, warnings, workingDirectory };
    }

    async fixAll(filePath: string, text: string, workspaceRoot: string | undefined): Promise<LinterFixResult> {
        if (!this.settings.enable) {
            return { status: 'disabled' };
        }
        const { workingDirectory, executable } = this.locate(filePath, workspaceRoot);
        if (!executable) {
            return { status: 'not-installed', workingDirectory };
        }

        try {
            const output = await (await this.serverFor(executable, workingDirectory)).fixAll(filePath, text);
            return { status: 'linted', output, workingDirectory };
        } catch (error) {
            throw new DiagnosticsUnavailableError('oxlint', `oxlint fixes failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
        }
    }

    dispose(): void {
        for (const server of this.servers.values()) {
            server.then((started) => started.dispose(), () => undefined);
        }
        this.servers.clear();
    }
}
