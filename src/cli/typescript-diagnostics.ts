import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';

import { DiagnosticsUnavailableError } from './diagnostic-errors';
import { ImportOracle } from './import-oracle';
import { parseConfigWithCache } from './tsconfig-cache';

import type * as TS from 'typescript';
import type { SettingsReader } from '../core/config';
import { UNUSED_IMPORT_CODES } from '../core/diagnostics';

import type { TidyDiagnostic, TidyDiagnosticSeverity } from '../core/diagnostics';
import type { OracleVerdict } from './import-oracle';
import type { ParsedConfig } from './tsconfig-cache';

type TypeScriptModule = typeof TS;

const CONFIG_FILE_NAMES = ['tsconfig.json', 'jsconfig.json'];

const JSCONFIG_DEFAULTS: TS.CompilerOptions = {
    allowJs: true,
    maxNodeModuleJsDepth: 2,
    allowSyntheticDefaultImports: true,
    skipLibCheck: true,
    noEmit: true,
};

export interface TypeScriptRuntime {
    ts: TypeScriptModule;
    modulePath: string;
    version: string;
}

export interface TypeScriptEditorSettings {
    validateTypeScript: boolean;
    validateJavaScript: boolean;
    suggestionsTypeScript: boolean;
    suggestionsJavaScript: boolean;
    implicitCheckJs: boolean;
    implicitExperimentalDecorators: boolean;
    implicitStrictNullChecks: boolean;
    implicitStrictFunctionTypes: boolean;
    implicitStrict: boolean;
    implicitModule?: string;
    implicitTarget?: string;
}

export interface TypeScriptProjectDescription {
    kind: 'configured' | 'inferred';
    configPath?: string;
    typescriptVersion: string;
    typescriptPath: string;
}

export function readTypeScriptEditorSettings(settings: { typescript: SettingsReader; javascript: SettingsReader; jsts: SettingsReader }): TypeScriptEditorSettings {
    const readBoolean = (reader: SettingsReader, key: string, fallback: boolean): boolean => {
        const value = reader.get<unknown>(key);
        return typeof value === 'boolean' ? value : fallback;
    };
    const implicitValue = (key: string): unknown => {
        const modern = settings.jsts.get<unknown>(`implicitProjectConfig.${key}`);
        return modern !== undefined ? modern : settings.javascript.get<unknown>(`implicitProjectConfig.${key}`);
    };
    const implicit = (key: string, fallback: boolean): boolean => {
        const value = implicitValue(key);
        return typeof value === 'boolean' ? value : fallback;
    };
    const implicitString = (key: string): string | undefined => {
        const value = implicitValue(key);
        return typeof value === 'string' && value ? value : undefined;
    };

    return {
        validateTypeScript: readBoolean(settings.typescript, 'validate.enable', true),
        validateJavaScript: readBoolean(settings.javascript, 'validate.enable', true),
        suggestionsTypeScript: readBoolean(settings.typescript, 'suggestionActions.enabled', true),
        suggestionsJavaScript: readBoolean(settings.javascript, 'suggestionActions.enabled', true),
        implicitCheckJs: implicit('checkJs', false),
        implicitExperimentalDecorators: implicit('experimentalDecorators', false),
        implicitStrictNullChecks: implicit('strictNullChecks', true),
        implicitStrictFunctionTypes: implicit('strictFunctionTypes', true),
        implicitStrict: implicit('strict', true),
        implicitModule: implicitString('module'),
        implicitTarget: implicitString('target'),
    };
}

export function isJavaScriptFile(filePath: string): boolean {
    return /\.(?:[cm]?js|jsx)$/i.test(filePath);
}

export function loadTypeScript(searchFrom: string[]): TypeScriptRuntime | null {
    for (const directory of searchFrom) {
        try {
            const projectRequire = createRequire(path.join(directory, '__tidyjs_resolve__.js'));
            const modulePath = projectRequire.resolve('typescript');
            const ts = projectRequire(modulePath) as TypeScriptModule;
            return { ts, modulePath, version: ts.version };
        } catch {
            continue;
        }
    }
    return null;
}

interface ProjectSnapshot {
    key: string;
    kind: 'configured' | 'inferred';
    configPath?: string;
    currentDirectory: string;
    options: TS.CompilerOptions;
    rootNames: string[];
    projectReferences?: readonly TS.ProjectReference[];
}

class TypeScriptProject {
    readonly service: TS.LanguageService;
    private readonly rootNames: string[];
    private readonly rootKeys = new Set<string>();
    private projectVersion = 0;

    constructor(
        ts: TypeScriptModule,
        readonly snapshot: ProjectSnapshot,
        private readonly files: FileOverlay,
        registry: TS.DocumentRegistry
    ) {
        this.rootNames = [...snapshot.rootNames];
        for (const name of this.rootNames) {
            this.rootKeys.add(files.key(name));
        }

        const host: TS.LanguageServiceHost & { useSourceOfProjectReferenceRedirect?: () => boolean } = {
            getCompilationSettings: () => snapshot.options,
            getScriptFileNames: () => this.rootNames,
            getProjectVersion: () => `${this.projectVersion}:${files.version}`,
            getScriptVersion: (fileName) => files.versionOf(fileName),
            getScriptSnapshot: (fileName) => {
                const text = files.read(fileName);
                return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
            },
            getCurrentDirectory: () => snapshot.currentDirectory,
            getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
            fileExists: (fileName) => files.exists(fileName),
            readFile: (fileName) => files.read(fileName),
            readDirectory: ts.sys.readDirectory,
            directoryExists: ts.sys.directoryExists,
            getDirectories: ts.sys.getDirectories,
            realpath: ts.sys.realpath,
            useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
            getProjectReferences: () => snapshot.projectReferences,
            useSourceOfProjectReferenceRedirect: () => true,
        };

        this.service = ts.createLanguageService(host, registry);
    }

    ensureRoot(fileName: string): void {
        const key = this.files.key(fileName);
        if (!this.rootKeys.has(key)) {
            this.rootKeys.add(key);
            this.rootNames.push(fileName);
            this.projectVersion++;
        }
    }
}

class FileOverlay {
    version = 0;
    private readonly texts = new Map<string, string>();
    private readonly versions = new Map<string, number>();

    constructor(private readonly ts: TypeScriptModule) {}

    key(fileName: string): string {
        const normalized = path.resolve(fileName);
        return this.ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
    }

    set(fileName: string, text: string): void {
        const key = this.key(fileName);
        if (this.read(fileName) === text) {
            return;
        }
        this.texts.set(key, text);
        this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
        this.version++;
    }

    read(fileName: string): string | undefined {
        return this.texts.get(this.key(fileName)) ?? this.ts.sys.readFile(fileName);
    }

    exists(fileName: string): boolean {
        return this.texts.has(this.key(fileName)) || this.ts.sys.fileExists(fileName);
    }

    versionOf(fileName: string): string {
        return String(this.versions.get(this.key(fileName)) ?? 0);
    }
}

interface NativeDiagnostic {
    code: number;
    category: number;
    text: string;
    pos: number;
    end: number;
}

interface NativeProgram {
    getSyntacticDiagnostics(file: string): readonly NativeDiagnostic[];
    getSemanticDiagnostics(file: string): readonly NativeDiagnostic[];
    getSuggestionDiagnostics(file: string): readonly NativeDiagnostic[];
}

interface NativeProject {
    configFileName: string;
    program: NativeProgram;
}

interface NativeSnapshot {
    getDefaultProjectForFile(file: string): NativeProject | undefined;
    dispose(): void;
}

interface NativeApi {
    updateSnapshot(params: { openFiles: string[]; closeFiles?: string[]; fileChanges?: { changed: string[] } }): NativeSnapshot;
    close(): void;
}

type NativeApiConstructor = new (options: { cwd?: string; fs?: { readFile(fileName: string): string | undefined } }) => NativeApi;

interface NativeRuntime {
    packageDir: string;
    version: string;
}

type ResolvedRuntime = { kind: 'classic'; runtime: TypeScriptRuntime } | { kind: 'native'; runtime: NativeRuntime };

const SEVERITY_BY_CATEGORY: Record<number, TidyDiagnosticSeverity> = { 0: 'warning', 1: 'error', 2: 'hint', 3: 'info' };

function findPackageDir(modulePath: string): string {
    let directory = path.dirname(modulePath);
    while (!fs.existsSync(path.join(directory, 'package.json'))) {
        const parent = path.dirname(directory);
        if (parent === directory) {
            break;
        }
        directory = parent;
    }
    return directory;
}

function nativeRuntimeFrom(packageDir: string): NativeRuntime {
    const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')) as { version: string };
    return { packageDir, version: packageJson.version };
}

function resolveTypeScriptPackage(packageDir: string): ResolvedRuntime | null {
    const manifestPath = path.join(path.resolve(packageDir), 'package.json');
    let manifest: { name?: string; version?: string; main?: string };
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as typeof manifest;
    } catch {
        return null;
    }
    if (manifest.name !== 'typescript' || !manifest.version) {
        return null;
    }
    if (Number(manifest.version.split('.')[0]) >= 7) {
        return { kind: 'native', runtime: { packageDir: path.dirname(manifestPath), version: manifest.version } };
    }
    try {
        const modulePath = createRequire(manifestPath).resolve(path.join(path.dirname(manifestPath), manifest.main ?? 'lib/typescript.js'));
        const ts = createRequire(manifestPath)(modulePath) as TypeScriptModule;
        return { kind: 'classic', runtime: { ts, modulePath, version: ts.version } };
    } catch {
        return null;
    }
}

class NativeTypeScriptSession {
    private snapshot: NativeSnapshot | undefined;
    private readonly opened = new Set<string>();

    constructor(
        private readonly api: NativeApi,
        private readonly runtime: NativeRuntime,
        private readonly editorSettings: TypeScriptEditorSettings,
        private readonly overlay: Map<string, string>
    ) {}

    open(files: string[], changed: string[] = []): NativeSnapshot {
        const pinned = changed.filter((file) => this.opened.has(file));
        if (pinned.length > 0) {
            this.api.updateSnapshot({ openFiles: [], closeFiles: pinned }).dispose();
            for (const file of pinned) {
                this.opened.delete(file);
            }
        }
        const fresh = files.map(toTypeScriptFileName).filter((file) => !this.opened.has(file));
        if (fresh.length > 0 || changed.length > 0 || !this.snapshot) {
            const next = this.api.updateSnapshot(changed.length > 0 ? { openFiles: fresh, fileChanges: { changed } } : { openFiles: fresh });
            this.snapshot?.dispose();
            this.snapshot = next;
            for (const file of fresh) {
                this.opened.add(file);
            }
        }
        return this.snapshot;
    }

    private project(filePath: string, changed: string[] = []): NativeProject {
        const project = this.open([filePath], changed).getDefaultProjectForFile(toTypeScriptFileName(filePath));
        if (!project) {
            throw new DiagnosticsUnavailableError('typescript', `TypeScript ${this.runtime.version} found no project for ${filePath}`);
        }
        return project;
    }

    describe(filePath: string): TypeScriptProjectDescription {
        const project = this.project(filePath);
        const configured = /\.json$/i.test(project.configFileName) && fs.existsSync(project.configFileName);
        return {
            kind: configured ? 'configured' : 'inferred',
            configPath: configured ? path.resolve(project.configFileName) : undefined,
            typescriptVersion: this.runtime.version,
            typescriptPath: this.runtime.packageDir,
        };
    }

    getDiagnostics(filePath: string, text: string): TidyDiagnostic[] {
        const fileName = toTypeScriptFileName(filePath);
        const seenText = this.overlay.get(fileName) ?? fs.readFileSync(filePath, 'utf8');
        this.overlay.set(fileName, text);
        const program = this.project(filePath, seenText === text ? [] : [fileName]).program;
        const diagnostics = [
            ...program.getSyntacticDiagnostics(fileName),
            ...program.getSemanticDiagnostics(fileName),
        ];
        const suggestionsEnabled = isJavaScriptFile(filePath)
            ? this.editorSettings.suggestionsJavaScript
            : this.editorSettings.suggestionsTypeScript;
        if (suggestionsEnabled) {
            diagnostics.push(...program.getSuggestionDiagnostics(fileName));
        }

        return diagnostics.map((diagnostic) => ({
            source: 'ts',
            code: diagnostic.code,
            message: diagnostic.text,
            severity: SEVERITY_BY_CATEGORY[diagnostic.category] ?? 'error',
            start: diagnostic.pos,
            length: diagnostic.end - diagnostic.pos,
        }));
    }

    dispose(): void {
        this.snapshot?.dispose();
        this.api.close();
    }
}

export class TypeScriptDiagnosticsProvider {
    private readonly runtimes = new Map<string, ResolvedRuntime | null>();
    private readonly sessions = new Map<string, TypeScriptSession>();
    private readonly nativeSessions = new Map<string, Promise<NativeTypeScriptSession>>();
    private preparedFiles: string[] = [];

    constructor(
        private readonly fallbackResolveFrom: string | undefined,
        private readonly editorSettings: TypeScriptEditorSettings,
        private readonly typescriptPath?: string
    ) {}

    prepare(files: string[]): void {
        this.preparedFiles = files;
    }

    private resolveRuntime(filePath: string): ResolvedRuntime | null {
        if (this.typescriptPath) {
            return resolveTypeScriptPackage(this.typescriptPath);
        }
        const runtime = loadTypeScript([path.dirname(filePath), ...(this.fallbackResolveFrom ? [this.fallbackResolveFrom] : [])]);
        if (!runtime) {
            return null;
        }
        if (typeof runtime.ts.createLanguageService === 'function') {
            return { kind: 'classic', runtime };
        }
        return { kind: 'native', runtime: nativeRuntimeFrom(findPackageDir(runtime.modulePath)) };
    }

    private runtimeFor(filePath: string): ResolvedRuntime | null {
        const key = this.typescriptPath ? '' : path.dirname(filePath);
        if (!this.runtimes.has(key)) {
            this.runtimes.set(key, this.resolveRuntime(filePath));
        }
        return this.runtimes.get(key) ?? null;
    }

    private sessionFor(runtime: TypeScriptRuntime): TypeScriptSession {
        let session = this.sessions.get(runtime.modulePath);
        if (!session) {
            session = new TypeScriptSession(runtime, this.editorSettings);
            this.sessions.set(runtime.modulePath, session);
        }
        return session;
    }

    private nativeSessionFor(runtime: NativeRuntime, workspaceRoot: string | undefined, filePath: string): Promise<NativeTypeScriptSession> {
        let session = this.nativeSessions.get(runtime.packageDir);
        if (!session) {
            session = (async () => {
                const apiPath = createRequire(path.join(runtime.packageDir, 'package.json')).resolve('typescript/unstable/sync');
                const module = await import(pathToFileURL(apiPath).href) as { API: NativeApiConstructor };
                const overlay = new Map<string, string>();
                const api = new module.API({
                    cwd: workspaceRoot ?? path.dirname(filePath),
                    fs: { readFile: (fileName) => overlay.get(toTypeScriptFileName(fileName)) },
                });
                const native = new NativeTypeScriptSession(api, runtime, this.editorSettings, overlay);
                native.open(this.preparedFiles.length > 0 ? this.preparedFiles : [filePath]);
                return native;
            })();
            this.nativeSessions.set(runtime.packageDir, session);
        }
        return session;
    }

    async describe(filePath: string, workspaceRoot: string | undefined): Promise<TypeScriptProjectDescription | null> {
        const resolved = this.runtimeFor(filePath);
        if (!resolved) {
            return null;
        }
        if (resolved.kind === 'native') {
            return (await this.nativeSessionFor(resolved.runtime, workspaceRoot, filePath)).describe(filePath);
        }
        return this.sessionFor(resolved.runtime).describe(filePath, workspaceRoot);
    }

    async getDiagnostics(filePath: string, text: string, workspaceRoot: string | undefined): Promise<TidyDiagnostic[]> {
        const javascript = isJavaScriptFile(filePath);
        if (javascript ? !this.editorSettings.validateJavaScript : !this.editorSettings.validateTypeScript) {
            return [];
        }

        const resolved = this.runtimeFor(filePath);
        if (!resolved) {
            throw new DiagnosticsUnavailableError('typescript', this.typescriptPath
                ? `No TypeScript package found at ${this.typescriptPath}`
                : 'TypeScript is not installed in the project and no fallback copy was found');
        }

        if (resolved.kind === 'native') {
            return (await this.nativeSessionFor(resolved.runtime, workspaceRoot, filePath)).getDiagnostics(filePath, text);
        }
        return this.sessionFor(resolved.runtime).getDiagnostics(filePath, text, workspaceRoot);
    }

    fastAnalysis(filePath: string, text: string, workspaceRoot: string | undefined): OracleVerdict {
        const javascript = isJavaScriptFile(filePath);
        if (javascript ? !this.editorSettings.validateJavaScript : !this.editorSettings.validateTypeScript) {
            return { decided: false, reason: 'TypeScript validation disabled', stage: 'program' };
        }
        const resolved = this.runtimeFor(filePath);
        if (!resolved) {
            return { decided: false, reason: 'TypeScript not installed', stage: 'program' };
        }
        if (resolved.kind === 'native') {
            return { decided: false, reason: `TypeScript ${resolved.runtime.version} has no JavaScript API`, stage: 'program' };
        }
        return this.sessionFor(resolved.runtime).fastAnalysis(filePath, text, workspaceRoot);
    }

    fileOnlyUnusedDiagnostics(filePath: string, text: string, workspaceRoot: string | undefined): TidyDiagnostic[] {
        const resolved = this.runtimeFor(filePath);
        if (!resolved || resolved.kind !== 'classic') {
            throw new DiagnosticsUnavailableError('typescript', 'File-only analysis needs the TypeScript JavaScript API');
        }
        return this.sessionFor(resolved.runtime).fileOnlyUnusedDiagnostics(filePath, text, workspaceRoot);
    }

    async dispose(): Promise<void> {
        for (const session of this.nativeSessions.values()) {
            (await session).dispose();
        }
        this.nativeSessions.clear();
    }
}

class TypeScriptSession {
    private readonly ts: TypeScriptModule;
    private readonly registry: TS.DocumentRegistry;
    private readonly files: FileOverlay;
    private readonly parsedConfigs = new Map<string, TS.ParsedCommandLine | null>();
    private readonly cachedConfigs = new Map<string, ParsedConfig | null>();
    private readonly fastProjectByFile = new Map<string, ProjectSnapshot>();
    private readonly fileKeys = new WeakMap<readonly string[], Set<string>>();
    private readonly projects = new Map<string, TypeScriptProject>();
    private readonly projectByFile = new Map<string, ProjectSnapshot>();

    constructor(private readonly runtime: TypeScriptRuntime, private readonly editorSettings: TypeScriptEditorSettings) {
        this.ts = runtime.ts;
        this.registry = this.ts.createDocumentRegistry(this.ts.sys.useCaseSensitiveFileNames);
        this.files = new FileOverlay(this.ts);
    }

    private oracle: ImportOracle | undefined;

    fastAnalysis(filePath: string, text: string, workspaceRoot: string | undefined): OracleVerdict {
        const snapshot = this.selectProject(filePath, workspaceRoot, true);
        this.oracle ??= new ImportOracle(this.ts);
        const suggestionsEnabled = isJavaScriptFile(filePath)
            ? this.editorSettings.suggestionsJavaScript
            : this.editorSettings.suggestionsTypeScript;
        return this.oracle.analyze(filePath, text, {
            key: snapshot.key,
            directory: snapshot.currentDirectory,
            options: snapshot.options,
            fileNames: snapshot.rootNames,
        }, { suggestionsEnabled });
    }

    describe(filePath: string, workspaceRoot: string | undefined): TypeScriptProjectDescription {
        const snapshot = this.selectProject(filePath, workspaceRoot);
        return {
            kind: snapshot.kind,
            configPath: snapshot.configPath,
            typescriptVersion: this.runtime.version,
            typescriptPath: this.runtime.modulePath,
        };
    }

    getDiagnostics(filePath: string, text: string, workspaceRoot: string | undefined): TidyDiagnostic[] {
        this.files.set(filePath, text);
        const snapshot = this.selectProject(filePath, workspaceRoot);
        const project = this.projectFor(snapshot);
        const fileName = toTypeScriptFileName(filePath);
        if (snapshot.kind === 'inferred') {
            project.ensureRoot(fileName);
        }
        return this.collectDiagnostics(project.service, filePath);
    }

    fileOnlyUnusedDiagnostics(filePath: string, text: string, workspaceRoot: string | undefined): TidyDiagnostic[] {
        this.files.set(filePath, text);
        const snapshot = this.selectProject(filePath, workspaceRoot, true);
        const fileName = toTypeScriptFileName(filePath);
        const project = new TypeScriptProject(this.ts, {
            key: `file:${this.files.key(filePath)}`,
            kind: snapshot.kind,
            configPath: snapshot.configPath,
            currentDirectory: snapshot.currentDirectory,
            options: { ...snapshot.options, noResolve: true, noLib: true, types: [] },
            rootNames: [fileName],
        }, this.files, this.registry);
        return this.collectDiagnostics(project.service, filePath)
            .filter((diagnostic) => UNUSED_IMPORT_CODES.includes(String(diagnostic.code)));
    }

    private collectDiagnostics(service: TS.LanguageService, filePath: string): TidyDiagnostic[] {
        const fileName = toTypeScriptFileName(filePath);
        const diagnostics: TS.Diagnostic[] = [
            ...service.getSyntacticDiagnostics(fileName),
            ...service.getSemanticDiagnostics(fileName),
        ];

        const suggestionsEnabled = isJavaScriptFile(filePath)
            ? this.editorSettings.suggestionsJavaScript
            : this.editorSettings.suggestionsTypeScript;
        if (suggestionsEnabled) {
            diagnostics.push(...service.getSuggestionDiagnostics(fileName));
        }

        return diagnostics.map((diagnostic) => this.toTidyDiagnostic(diagnostic));
    }

    private toTidyDiagnostic(diagnostic: TS.Diagnostic): TidyDiagnostic {
        const severityByCategory: Record<number, TidyDiagnosticSeverity> = {
            [this.ts.DiagnosticCategory.Error]: 'error',
            [this.ts.DiagnosticCategory.Warning]: 'warning',
            [this.ts.DiagnosticCategory.Suggestion]: 'hint',
            [this.ts.DiagnosticCategory.Message]: 'info',
        };

        return {
            source: 'ts',
            code: diagnostic.code,
            message: this.ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
            severity: severityByCategory[diagnostic.category] ?? 'error',
            start: diagnostic.start,
            length: diagnostic.length,
        };
    }

    private projectFor(snapshot: ProjectSnapshot): TypeScriptProject {
        let project = this.projects.get(snapshot.key);
        if (!project) {
            project = new TypeScriptProject(this.ts, snapshot, this.files, this.registry);
            this.projects.set(snapshot.key, project);
        }
        return project;
    }

    private parseConfig(configPath: string, fast = false): ParsedConfig | null {
        if (fast) {
            if (!this.cachedConfigs.has(configPath)) {
                const existingOptions = path.basename(configPath) === 'jsconfig.json' ? JSCONFIG_DEFAULTS : undefined;
                this.cachedConfigs.set(configPath, parseConfigWithCache(this.ts, configPath, existingOptions));
            }
            return this.cachedConfigs.get(configPath) ?? null;
        }
        const cached = this.parsedConfigs.get(configPath);
        if (cached !== undefined) {
            return cached;
        }

        const existingOptions = path.basename(configPath) === 'jsconfig.json' ? JSCONFIG_DEFAULTS : undefined;
        let parsed: TS.ParsedCommandLine | undefined;
        try {
            parsed = this.ts.getParsedCommandLineOfConfigFile(configPath, existingOptions, {
                ...this.ts.sys,
                onUnRecoverableConfigFileDiagnostic: () => undefined,
            });
        } catch {
            parsed = undefined;
        }

        this.parsedConfigs.set(configPath, parsed ?? null);
        return parsed ?? null;
    }

    private containsFile(parsed: ParsedConfig, filePath: string): boolean {
        let keys = this.fileKeys.get(parsed.fileNames);
        if (!keys) {
            keys = new Set(parsed.fileNames.map((fileName) => this.files.key(fileName)));
            this.fileKeys.set(parsed.fileNames, keys);
        }
        return keys.has(this.files.key(filePath));
    }

    private findInReferences(parsed: ParsedConfig, filePath: string, visited: Set<string>, fast: boolean): string | undefined {
        for (const reference of parsed.projectReferences ?? []) {
            const referencedConfig = path.resolve(this.ts.resolveProjectReferencePath(reference));
            if (visited.has(referencedConfig)) {
                continue;
            }
            visited.add(referencedConfig);

            const referencedParsed = this.parseConfig(referencedConfig, fast);
            if (!referencedParsed) {
                continue;
            }
            if (this.containsFile(referencedParsed, filePath)) {
                return referencedConfig;
            }
            const nested = this.findInReferences(referencedParsed, filePath, visited, fast);
            if (nested) {
                return nested;
            }
        }
        return undefined;
    }

    private findConfiguredProject(filePath: string, workspaceRoot: string | undefined, fast: boolean): string | undefined {
        const boundary = workspaceRoot && isInside(filePath, workspaceRoot) ? path.resolve(workspaceRoot) : undefined;
        let directory = path.dirname(path.resolve(filePath));

        for (;;) {
            for (const configName of CONFIG_FILE_NAMES) {
                const configPath = path.join(directory, configName);
                if (!this.ts.sys.fileExists(configPath)) {
                    continue;
                }
                const parsed = this.parseConfig(configPath, fast);
                if (!parsed) {
                    continue;
                }
                if (this.containsFile(parsed, filePath)) {
                    return configPath;
                }
                const referenced = this.findInReferences(parsed, filePath, new Set([configPath]), fast);
                if (referenced) {
                    return referenced;
                }
            }

            if (boundary && directory === boundary) {
                return undefined;
            }
            const parent = path.dirname(directory);
            if (parent === directory) {
                return undefined;
            }
            directory = parent;
        }
    }

    private inferredOptions(javascript: boolean, directory: string): TS.CompilerOptions {
        const [major, minor] = this.ts.versionMajorMinor.split('.').map(Number);
        const atLeast = (wantedMajor: number, wantedMinor: number): boolean => major > wantedMajor || (major === wantedMajor && minor >= wantedMinor);
        const settings = this.editorSettings;

        const json: Record<string, unknown> = {
            module: atLeast(5, 4) ? 'Preserve' : 'ESNext',
            moduleResolution: atLeast(5, 4) ? 'Bundler' : 'Node',
            target: 'ES2022',
            jsx: 'react-jsx',
            checkJs: settings.implicitCheckJs,
            experimentalDecorators: settings.implicitExperimentalDecorators,
            strictNullChecks: settings.implicitStrictNullChecks,
            strictFunctionTypes: settings.implicitStrictFunctionTypes,
            strict: settings.implicitStrict,
            sourceMap: true,
            allowJs: true,
            allowSyntheticDefaultImports: true,
            resolveJsonModule: true,
        };
        if (atLeast(5, 0)) {
            json.allowImportingTsExtensions = true;
        }
        if (settings.implicitModule) {
            json.module = settings.implicitModule;
        }
        if (settings.implicitTarget) {
            json.target = settings.implicitTarget;
        }

        const options = this.ts.convertCompilerOptionsFromJson(json, directory).options;
        options.allowNonTsExtensions = true;
        if (javascript) {
            options.maxNodeModuleJsDepth = 2;
        }
        return options;
    }

    private selectProject(filePath: string, workspaceRoot: string | undefined, fast = false): ProjectSnapshot {
        const fileKey = this.files.key(filePath);
        const projectByFile = fast ? this.fastProjectByFile : this.projectByFile;
        const cached = projectByFile.get(fileKey);
        if (cached) {
            return cached;
        }

        const configPath = this.findConfiguredProject(filePath, workspaceRoot, fast);
        let snapshot: ProjectSnapshot;
        if (configPath) {
            const parsed = this.parseConfig(configPath, fast)!;
            snapshot = {
                key: `configured:${configPath}`,
                kind: 'configured',
                configPath,
                currentDirectory: path.dirname(configPath),
                options: parsed.options,
                rootNames: parsed.fileNames,
                projectReferences: parsed.projectReferences,
            };
        } else {
            const inferredRoot = workspaceRoot && isInside(filePath, workspaceRoot) ? path.resolve(workspaceRoot) : path.dirname(path.resolve(filePath));
            const javascript = isJavaScriptFile(filePath);
            snapshot = {
                key: `inferred:${javascript ? 'js' : 'ts'}:${inferredRoot}`,
                kind: 'inferred',
                currentDirectory: inferredRoot,
                options: this.inferredOptions(javascript, inferredRoot),
                rootNames: [],
            };
        }

        projectByFile.set(fileKey, snapshot);
        return snapshot;
    }
}

function isInside(filePath: string, directory: string): boolean {
    const relative = path.relative(directory, filePath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function toTypeScriptFileName(filePath: string): string {
    return path.resolve(filePath).replace(/\\/g, '/');
}
