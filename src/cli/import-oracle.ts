import * as path from 'path';
import { analyze } from '@typescript-eslint/scope-manager';
import { parseSync, rawTransferSupported } from 'oxc-parser';

import type * as TS from 'typescript';
import type { TidyDiagnostic } from '../core/diagnostics';

type TypeScriptModule = typeof TS;

interface EstreeNode {
    type: string;
    [key: string]: unknown;
}

interface AmbientModules {
    names: Set<string>;
    patterns: { prefix: string; suffix: string }[];
}

export interface OracleProject {
    key: string;
    directory: string;
    options: TS.CompilerOptions;
    fileNames: readonly string[];
}

export interface OracleSettings {
    suggestionsEnabled: boolean;
}

export type FallbackStage = 'file' | 'program';

export type OracleVerdict =
    | { decided: true; diagnostics: TidyDiagnostic[] }
    | { decided: false; reason: string; stage: FallbackStage };

const RAW_TRANSFER = rawTransferSupported();

function undecided(reason: string, stage: FallbackStage = 'program'): OracleVerdict {
    return { decided: false, reason, stage };
}

function oxcLanguage(filePath: string): 'ts' | 'tsx' | 'js' | 'jsx' {
    const extension = path.extname(filePath).slice(1).toLowerCase();
    if (/^[cm]?ts$/.test(extension)) {
        return 'ts';
    }
    if (extension === 'tsx' || extension === 'jsx') {
        return extension;
    }
    return 'js';
}

function isJavaScript(filePath: string): boolean {
    return /\.(?:[cm]?js|jsx)$/i.test(filePath);
}

function visit(node: unknown, callback: (node: EstreeNode) => void): void {
    if (!node || typeof (node as EstreeNode).type !== 'string') {
        return;
    }
    callback(node as EstreeNode);
    for (const [key, value] of Object.entries(node as EstreeNode)) {
        if (key === 'parent') {
            continue;
        }
        if (Array.isArray(value)) {
            for (const child of value) {
                visit(child, callback);
            }
        } else if (value && typeof (value as EstreeNode).type === 'string') {
            visit(value, callback);
        }
    }
}

export class ImportOracle {
    private readonly caches = new Map<string, TS.ModuleResolutionCache>();
    private readonly ambients = new Map<string, AmbientModules>();

    constructor(private readonly ts: TypeScriptModule) {}

    private cacheFor(project: OracleProject): TS.ModuleResolutionCache {
        let cache = this.caches.get(project.key);
        if (!cache) {
            const canonical = this.ts.sys.useCaseSensitiveFileNames ? (file: string) => file : (file: string) => file.toLowerCase();
            cache = this.ts.createModuleResolutionCache(project.directory, canonical, project.options);
            this.caches.set(project.key, cache);
        }
        return cache;
    }

    private ambientFor(project: OracleProject): AmbientModules {
        const cached = this.ambients.get(project.key);
        if (cached) {
            return cached;
        }

        const ts = this.ts;
        const ambient: AmbientModules = { names: new Set(), patterns: [] };
        const seen = new Set<string>();
        const queue = project.fileNames.filter((file) => /\.d\.[cm]?ts$/i.test(file));
        const typeNames = project.options.types ?? ts.getAutomaticTypeDirectiveNames(project.options, ts.sys);
        const containing = path.join(project.directory, '__inferred type names__.ts');
        for (const name of typeNames) {
            const resolved = ts.resolveTypeReferenceDirective(name, containing, project.options, ts.sys).resolvedTypeReferenceDirective;
            if (resolved?.resolvedFileName) {
                queue.push(resolved.resolvedFileName);
            }
        }

        while (queue.length > 0) {
            const file = queue.pop()!;
            if (seen.has(file)) {
                continue;
            }
            seen.add(file);
            const text = ts.sys.readFile(file);
            if (text === undefined) {
                continue;
            }
            const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
            for (const reference of sourceFile.referencedFiles) {
                queue.push(path.resolve(path.dirname(file), reference.fileName));
            }
            for (const reference of sourceFile.typeReferenceDirectives) {
                const resolved = ts.resolveTypeReferenceDirective(reference.fileName, file, project.options, ts.sys).resolvedTypeReferenceDirective;
                if (resolved?.resolvedFileName) {
                    queue.push(resolved.resolvedFileName);
                }
            }
            if (ts.isExternalModule(sourceFile)) {
                continue;
            }
            for (const statement of sourceFile.statements) {
                if (ts.isModuleDeclaration(statement) && ts.isStringLiteral(statement.name)) {
                    const name = statement.name.text;
                    const star = name.indexOf('*');
                    if (star === -1) {
                        ambient.names.add(name);
                    } else if (star === name.lastIndexOf('*')) {
                        ambient.patterns.push({ prefix: name.slice(0, star), suffix: name.slice(star + 1) });
                    }
                }
            }
        }

        this.ambients.set(project.key, ambient);
        return ambient;
    }

    private isAmbient(project: OracleProject, specifier: string): boolean {
        const ambient = this.ambientFor(project);
        if (ambient.names.has(specifier)) {
            return true;
        }
        return ambient.patterns.some(({ prefix, suffix }) => specifier.length >= prefix.length + suffix.length
            && specifier.startsWith(prefix)
            && specifier.endsWith(suffix));
    }

    private findUnresolvedSpecifier(filePath: string, text: string, project: OracleProject): string | undefined {
        const ts = this.ts;
        const cache = this.cacheFor(project);
        const sourceFile = ts.createSourceFile(filePath, text, {
            languageVersion: ts.ScriptTarget.Latest,
            impliedNodeFormat: ts.getImpliedNodeFormatForFile(filePath, cache.getPackageJsonInfoCache(), ts.sys, project.options),
        }, true);

        const specifiers: TS.StringLiteralLike[] = [];
        const collect = (node: TS.Node): void => {
            if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
                specifiers.push(node.moduleSpecifier);
            } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) {
                specifiers.push(node.moduleReference.expression);
            } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])
                && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
                specifiers.push(node.arguments[0]);
            } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
                specifiers.push(node.argument.literal);
            }
            ts.forEachChild(node, collect);
        };
        collect(sourceFile);

        for (const literal of specifiers) {
            const mode = ts.getModeForUsageLocation(sourceFile, literal, project.options);
            const resolved = ts.resolveModuleName(literal.text, filePath, project.options, ts.sys, cache, undefined, mode).resolvedModule;
            if (!resolved && !this.isAmbient(project, literal.text)) {
                return literal.text;
            }
        }
        return undefined;
    }

    analyze(filePath: string, text: string, project: OracleProject, settings: OracleSettings): OracleVerdict {
        const options = project.options;

        let fileReason: string | undefined;
        if (/\.d\.[cm]?ts$/i.test(filePath)) {
            fileReason = 'declaration file';
        } else if (/@ts-(?:nocheck|check)\b/.test(text)) {
            fileReason = '@ts-check or @ts-nocheck directive';
        } else if (options.noCheck) {
            fileReason = 'noCheck';
        } else if (isJavaScript(filePath) && options.checkJs === false) {
            fileReason = 'JavaScript file with checkJs disabled';
        } else if (!settings.suggestionsEnabled && !options.noUnusedLocals) {
            fileReason = 'TypeScript suggestions disabled';
        }

        const lang = oxcLanguage(filePath);
        const parsed = parseSync(filePath, text, {
            sourceType: 'module',
            lang,
            range: true,
            astType: lang === 'ts' || lang === 'tsx' ? 'ts' : 'js',
            ...({ experimentalRawTransfer: RAW_TRANSFER } as object),
        });
        if (parsed.errors.length > 0) {
            return undecided('parse error');
        }
        const ast = parsed.program as unknown as EstreeNode;
        const comments = parsed.comments;

        if (options.emitDecoratorMetadata && /@[A-Za-z_$]/.test(text)) {
            return undecided('decorator metadata may reference imports');
        }

        const scopeManager = analyze(ast as never, { sourceType: 'module', jsxPragma: null, jsxFragmentName: null });

        let hasJsx = false;
        visit(ast, (node) => {
            if (node.type.startsWith('JSX')) {
                hasJsx = true;
            }
        });

        const javascript = isJavaScript(filePath);
        const jsdocReferenceWords = new Set(comments
            .filter((comment) => comment.type === 'Block' && comment.value.startsWith('*'))
            .flatMap((comment) => (javascript ? comment.value.match(/\{[^}]*\}/g) : comment.value.match(/\{@link(?:code|plain)?\b[^}]*\}/g)) ?? [])
            .flatMap((fragment) => fragment.match(/[A-Za-z_$][\w$]*/g) ?? []));

        const ts = this.ts;
        const automaticJsx = options.jsx === ts.JsxEmit.ReactJSX || options.jsx === ts.JsxEmit.ReactJSXDev;
        const factoryRoots = new Set([
            (options.jsxFactory ?? options.reactNamespace ?? 'React').split('.')[0],
            (options.jsxFragmentFactory ?? 'React').split('.')[0],
        ]);
        const pragma = /@jsx(?:Frag)?\s/.test(text);

        let importReason: string | undefined;
        const unused: { name: string; start: number }[] = [];
        const moduleScope = scopeManager.scopes.find((scope) => scope.type === 'module');
        for (const variable of moduleScope?.variables ?? []) {
            if (variable.defs[0]?.type !== 'ImportBinding') {
                continue;
            }
            const name = variable.name;
            if (jsdocReferenceWords.has(name)) {
                importReason ??= `${name} may be referenced from JSDoc`;
            } else if (hasJsx && !automaticJsx && (factoryRoots.has(name) || pragma)) {
                importReason ??= `${name} may be the JSX factory`;
            } else if (variable.references.some((reference) => reference.isWrite())) {
                importReason ??= `${name} is assigned`;
            }
            if (variable.references.length === 0) {
                unused.push({ name, start: variable.defs[0].name.range[0] });
            }
        }

        const unusedByDeclaration = new Map<unknown, { total: number; unused: number }>();
        for (const variable of moduleScope?.variables ?? []) {
            const definition = variable.defs[0];
            if (definition?.type !== 'ImportBinding') {
                continue;
            }
            const counts = unusedByDeclaration.get(definition.parent) ?? { total: 0, unused: 0 };
            counts.total++;
            if (variable.references.length === 0) {
                counts.unused++;
            }
            unusedByDeclaration.set(definition.parent, counts);
        }
        for (const counts of unusedByDeclaration.values()) {
            if (counts.total > 1 && counts.unused === counts.total) {
                importReason ??= 'every binding of an import is unused, which TypeScript reports without names';
            }
        }

        const unresolved = this.findUnresolvedSpecifier(filePath, text, project);
        if (unresolved !== undefined) {
            return undecided(`'${unresolved}' does not resolve`);
        }

        const reason = fileReason ?? importReason;
        if (reason !== undefined) {
            return undecided(reason, 'file');
        }

        return {
            decided: true,
            diagnostics: unused.map(({ name, start }) => ({
                source: 'ts',
                code: 6133,
                severity: 'hint' as const,
                message: `'${name}' is declared but its value is never read.`,
                start,
                length: name.length,
            })),
        };
    }
}
