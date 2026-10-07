# CLI Architecture and Runtime Differences

This document explains how TidyJS runs outside VS Code: what the engine used to borrow from the editor, how the code is split between a runtime-independent core and two adapters, and where the CLI result can differ from a save in VS Code.

For usage, see [cli.md](cli.md). For the engine itself, see [fonctionnement-tidyjs.html](fonctionnement-tidyjs.html) and [ir-pipeline.md](ir-pipeline.md).

## 1. Analysis of the VS Code coupling (version 1.9.2)

### Files that imported `vscode`

| File | What it used | Nature of the coupling |
|---|---|---|
| `src/extension.ts` | `languages`, `commands`, `window`, `workspace`, `TextEdit`, `Range`, `Uri` | Entry point; legitimately VS Code-only |
| `src/batch-formatter.ts` | `vscode.Uri` (type and `createUri` callback) | Only to call `configManager.getConfigForUri` |
| `src/utils/config.ts` | `workspace.getConfiguration`, `onDidChangeConfiguration`, `getWorkspaceFolder` | Settings source and workspace root |
| `src/utils/configLoader.ts` | `createFileSystemWatcher`, `getWorkspaceFolder`, `getConfiguration(section, uri)` | Config search boundary, settings, cache invalidation |
| `src/utils/diagnostics-cache.ts` | `languages.getDiagnostics` | Source of all diagnostics |
| `src/utils/misc.ts` | `Diagnostic`, `DiagnosticSeverity`, `window.show*Message`, `languages` | Diagnostic analysis and notifications |
| `src/utils/path-resolver.ts` | `workspace.fs`, `workspace.getWorkspaceFolder`, `Uri.joinPath`, `TextDocument` | A second copy of the Node path logic |
| `src/utils/log.ts` | `window.createOutputChannel`, `workspace.getConfiguration('tidyjs').debug` | Logging sink and debug flag |

The parser, the IR, the formatter, the sorters and the re-export organizer did not import `vscode` directly, but they imported `log.ts`, and `formatter.ts` imported `misc.ts`. Loading any of them outside VS Code therefore failed.

### Dependency map

| VS Code API | Current use | Information actually needed | CLI equivalent | Responsible module |
|---|---|---|---|---|
| `languages.getDiagnostics(uri)` | `removeUnusedImports`, `removeMissingModules` | Diagnostics of one file: code, message, severity | TypeScript `LanguageService` (syntactic, semantic, suggestion) and ESLint Node API | `src/core/diagnostics.ts`, `src/cli/typescript-diagnostics.ts`, `src/cli/eslint-diagnostics.ts` |
| `DiagnosticSeverity`, `Diagnostic.code` (`string`, `number` or `{ value, target }`) | Filtering by severity and code | Normalized severity and code | `TidyDiagnostic` | `src/core/diagnostics.ts`, `src/vscode/diagnostics.ts` |
| `workspace.getConfiguration('tidyjs'[, uri])`, `has`, `get` | Settings source merged under `.tidyjsrc` | Contributed defaults plus workspace `tidyjs.*` values, as VS Code would merge them | `package.json` defaults plus `<root>/.vscode/settings.json`, behind the same `has`/`get` contract | `src/core/settings.ts`, `src/cli/workspace.ts` |
| `workspace.getWorkspaceFolder(uri)` | Config search boundary, `excludedFolders`, alias base, tsconfig search boundary | One root directory per file | `--root`, otherwise the nearest ancestor holding `.git` or `.vscode`, otherwise the current directory | `src/cli/workspace.ts` |
| `workspace.asRelativePath(uri)` | `excludedFolders` test | Path relative to the root | `path.relative(root, file)` | `src/core/pipeline.ts` |
| `workspace.createFileSystemWatcher`, `onDidChangeConfiguration` | Cache invalidation | Fresh config | None: one CLI run reads every file once | `src/vscode/config-manager.ts` |
| `workspace.fs.readFile`, `workspace.fs.stat` | tsconfig search and alias existence checks in the editor | File content and existence | Node `fs` (the folder mode already used it) | `src/utils/path-resolver.ts` |
| `TextDocument` (`getText`, `version`, `fileName`, `uri`) | Input text and concurrent-edit detection | Text and path | File read from disk; no concurrency in a batch | `src/vscode/…`, `src/cli/runner.ts` |
| `TextEdit`, `Range`, `positionAt` | Minimal edit | Replacement range | Whole-file write (the minimal-edit helper stays shared) | `src/extension.ts` |
| `window.createOutputChannel`, `show*Message`, status bar | Logs and notifications | Log sink | stderr reporter | `src/utils/log.ts`, `src/vscode/log-sink.ts`, `src/cli/reporter.ts` |

### Where the diagnostics are consumed

`provideDocumentFormattingEdits` reads them only when `removeUnusedImports` or `removeMissingModules` is true. It parses once without filters, then `analyzeImports` keeps:

- **Missing modules**: severity `Error`, code `2307` or `2318`, and a message matching `Cannot find module '…'`. The module name comes from the message, not from the position.
- **Unused names**: severity `Error`, `Warning` or `Hint` (not `Information`), code `6133`, `6192`, `6196`, `unused-import`, `import-not-used` or `@typescript-eslint/no-unused-vars`, and a message matching `'X' is declared|defined but (its value is )never read|used`. Only names that are actually imported are kept.

The parser then drops whole imports whose source is missing and individual specifiers whose local name is unused. Positions are never used. Two consequences matter for parity:

- `6192` (`All imports in import declaration are unused.`) never matches the message pattern. An import whose specifiers are all unused is only removed when another source, such as ESLint, reports each name.
- The pattern is English. When VS Code runs the TypeScript server in another locale (`typescript.locale`), TypeScript-only removal does nothing in the editor.

### Editor versus folder mode in 1.9.2

| Aspect | Editor (format on save) | Format Folder |
|---|---|---|
| Diagnostics filters | yes | no |
| Config validation | no (only the command and activation validate) | no |
| `sortTypeMembers` when the file has imports | not applied unless another sort option is on | applied |
| Path resolution | VS Code `workspace.fs` copy | Node `fs` copy |
| Concurrent edit guard | yes, retry after 150 ms | not applicable |
| Empty file | no edit | skipped as `empty` |

### Features that depend on VS Code state

- **Timing of diagnostics.** The editor reads what is already published. If the TypeScript server or ESLint has not finished, nothing is removed at that save. The CLI computes complete diagnostics, which matches the editor once its servers have settled.
- **User-level settings.** `getConfiguration` merges user settings from the VS Code profile. The CLI reads only the workspace `.vscode/settings.json`, because user settings are machine-specific and would make CI runs non-reproducible.
- **TypeScript server plugins and project heuristics.** tsserver may load plugins declared in `compilerOptions.plugins` and uses an inferred project for files outside any tsconfig. The CLI reproduces project selection and inferred options but loads no plugin.
- **Localized messages.** Covered above.
- **ESLint extension settings.** `eslint.workingDirectories`, `eslint.enable`, `eslint.validate` and `eslint.options` are read from `.vscode/settings.json`. `eslint.rules.customizations` and the extension's probing heuristics are not reproduced.

## 2. Options considered for diagnostics

| Criterion | A. TypeScript API + ESLint API from Node | B. Headless VS Code | C. Hybrid (A by default, B on demand) |
|---|---|---|---|
| Reliability | Deterministic: diagnostics are computed, not awaited | Depends on server readiness; the 1.9.2 parity bench needed waits for both TypeScript and ESLint | As A, plus B's flakiness when enabled |
| Performance | One program per tsconfig, reused across files | Electron start, extension host, project load for every run | As A |
| Installation | `typescript` and `eslint` from the project, `typescript` bundled as fallback | VS Code binary, a display server on Linux CI, ESLint extension installed in the test profile | Both |
| Portability | Any Node 20+ platform supported by `oxc-parser` | Electron platforms only; headless Linux needs `xvfb` | Both |
| Reproducibility | Same inputs, same output | Depends on profile, extensions and timing | Mixed |
| CI/CD | Native | Heavy and fragile | Optional |
| Complexity | Project selection and ESLint working directory to reproduce | Process control, IPC, timeouts | Highest |
| Fidelity | Same TypeScript checker and same ESLint rules as the editor uses; differences are documented above | Highest in theory, lower in practice because of timing | Highest when B is enabled |

**Decision: A.** The editor's diagnostics come from the same two engines that the CLI calls directly: the TypeScript language service and ESLint. Reproducing their inputs (project, compiler options, working directory, rule set) gives the editor's settled result without its timing problem. Headless VS Code is kept where it is useful, as a test harness that records reference outputs (`test/compat`), not as a runtime dependency.

## 3. Target architecture

```text
                       ┌──────────────────────────────┐
                       │          TidyJS core          │
                       │ parser · IR · sorters · path  │
                       │ config resolution · pipeline  │
                       │ diagnostics analysis          │
                       └──────────────┬───────────────┘
                                      │  Config, TidyDiagnostic,
                                      │  SettingsReader, LogSink
                  ┌───────────────────┴───────────────────┐
                  │                                       │
       ┌──────────▼──────────┐                 ┌──────────▼───────────┐
       │   VS Code adapter    │                │     CLI adapter      │
       │ src/extension.ts     │                │ src/cli/             │
       │ src/vscode/          │                │ TypeScript API       │
       │ getDiagnostics       │                │ ESLint API           │
       │ getConfiguration     │                │ .vscode/settings.json│
       │ OutputChannel, edits │                │ fs, stdout/stderr    │
       └─────────────────────┘                 └──────────────────────┘
```

The ESLint configuration of this repository forbids importing `vscode` outside `src/extension.ts` and `src/vscode/`, so the boundary is checked by `npm run lint`.

## 4. Module layout

| Layer | Files | Depends on |
|---|---|---|
| Core | `src/parser.ts`, `src/formatter.ts`, `src/ir/`, `src/destructuring-sorter.ts`, `src/reexport-organizer.ts`, `src/batch-formatter.ts`, `src/utils/*`, `src/core/config.ts`, `src/core/settings.ts`, `src/core/diagnostics.ts`, `src/core/pipeline.ts` | `oxc-parser`, `jsonc-parser`, Node `fs`/`path` |
| VS Code adapter | `src/extension.ts`, `src/vscode/config-manager.ts`, `src/vscode/config-loader.ts`, `src/vscode/diagnostics.ts`, `src/vscode/log-sink.ts`, `src/vscode/messages.ts` | `vscode` and the core |
| CLI adapter | `src/cli/main.ts`, `cli.ts`, `args.ts`, `workspace.ts`, `files.ts`, `runner.ts`, `reporter.ts`, `diagnostics.ts`, `typescript-diagnostics.ts`, `eslint-diagnostics.ts` | the core, the project's `typescript` and `eslint` at runtime |

The abstractions shared by both adapters:

- `Config` and `resolveConfigForFile(filePath, context)`: the configuration of a file, from a `.tidyjsrc`/`tidyjs.json` source and two `SettingsReader`s with the `has`/`get` contract of `WorkspaceConfiguration`.
- `TidyDiagnostic`: `{ source, code, message, severity, start, length }`. The VS Code adapter converts `vscode.Diagnostic`; the CLI produces it from TypeScript and ESLint.
- `formatSource(request)`: the format-on-save pipeline, with a `profile` (`editor` or `folder`) and an optional asynchronous diagnostics supplier. It returns `changed`, `unchanged` (with a reason and an optional parse error) or `failed` (with the stage). It never writes and never notifies: each adapter decides how to apply the text and what to show.
- `LogSink`: where `logDebug` and `logError` go. The VS Code adapter installs the output channel; the CLI writes to stderr when `--debug` or `--verbose` is set.

The editor keeps what only an editor has: the minimal `TextEdit`, the concurrent-edit check with its retry, the notifications and the file watchers. The CLI keeps what only a batch tool has: file discovery, globs, the BOM, the exit codes and the report.

## 5. One pipeline, two profiles

```text
config ── excluded? ── pragma? ── diagnostics? ── parse with filters ── no imports? ─┬─ post-processing ── re-parse ── result
                                    (editor)                              (editor)    │
                                                                                      └─ path aliases ── IR print ── post-processing ── re-parse ── result
```

The `editor` profile is the format-on-save path of 1.9.2, unchanged. The `folder` profile is **Format Folder**: no diagnostics, empty files reported as such, and `sortTypeMembers` also applied in files with imports. The CLI uses `editor` by default because it reproduces a save; `--profile folder` reproduces the command.

## 6. Differences between the editor and the CLI

Each row was observed or checked with the compatibility suite (`test/compat`) or on a copy of Yeap-UI-Apps.

| Difference | Origin | Avoidable | Acceptable | Effect |
|---|---|---|---|---|
| The editor reads the diagnostics already published; the CLI computes them | Environment | Not in the editor | Yes | The CLI removes what the editor removes once the TypeScript server and ESLint have settled, sometimes one save earlier than the editor. |
| Invalid configuration | Intentional | Yes | Yes | Format on save does not validate and formats anyway; the CLI refuses like the **Format Imports** command and exits with code 2. |
| Automatic type acquisition (ATA) | Environment | No, without network and a global cache | Yes | For JavaScript files outside any `tsconfig.json`/`jsconfig.json`, tsserver downloads `@types/*` into a global cache. With `@types/react`, `react/jsx-runtime` resolves and a `React` default import becomes unused in the editor but not in the CLI. Adding a `jsconfig.json`, or installing the types in the project, removes the difference. |
| TypeScript version | Environment | Yes | Yes | VS Code uses its bundled TypeScript unless the workspace version is selected; the CLI uses the project's. `--verbose` prints the version. Selecting **TypeScript: Select TypeScript Version > Use Workspace Version** aligns both. |
| TypeScript server plugins | Environment | No | Yes | Plugins declared in `compilerOptions.plugins` run only in the editor. |
| Localized TypeScript messages | Environment | Yes | Yes | The unused-name pattern is English. With `typescript.locale` set to another language, TypeScript-based removal does nothing in the editor; the CLI always gets English messages. ESLint messages are not localized. |
| User settings | Environment | No, by design | Yes | The CLI reads `<root>/.vscode/settings.json` and the extension defaults, not the user profile. |
| Multi-root workspaces | Environment | Yes, with `--root` | Yes | The CLI has one root per run. |
| `eslint.rules.customizations` cache | Environment | No | Yes | The extension caches an override per rule regardless of `fixable`; the CLI evaluates every message. Both give the same severity unless a rule mixes fixable and non-fixable reports with a `fixable` filter. |
| Concurrent edits | Environment | Not applicable | Yes | The editor abandons and retries when the document changes during formatting; files on disk do not change during a run. |

### Behaviors of 1.9.2 kept identical in both runtimes

- `sortTypeMembers` alone is not applied on save to a file that has imports. The CLI reproduces it in the `editor` profile.
- An unused namespace import (`import * as ns`) is never removed: the analysis compares `ns` with the specifier `* as ns`.
- TypeScript code `6192` (`All imports in import declaration are unused.`) names no import, so an import whose specifiers are all unused is only removed when ESLint reports each name.
- Only `@typescript-eslint/no-unused-vars` is recognized among ESLint rules, not the core `no-unused-vars`.

### Core fixes made while extracting the core

These change the result in both runtimes, in the same way.

- **Unused names were matched by name only.** TidyJS read the name quoted in "'x' is declared but its value is never read" and removed any import with that name. When another declaration had the same name and was unused, for example a parameter `format` not used yet, the used `import { format } from 'date-fns'` was removed and the file stopped compiling. This was reproduced in VS Code 1.140 with the 1.9.2 engine on `apps/paye/src/@app/dossier/providers/reglements/ReglementFormProvider.ts` (`error TS2552: Cannot find name 'format'`). A diagnostic now counts only if its position falls inside the import declaration that binds the name. The VS Code adapter converts each diagnostic range to an offset, the CLI keeps TypeScript's `start` and converts ESLint's line and column. A diagnostic without position is ignored, which can only remove less.

- **Parser cache key.** The parser was recreated only when `JSON.stringify(config)` changed, which turns every regular expression into `{}`. Editing only a `match` in a config file kept the old grouping until a reload. The shared cache now serializes regular expressions.
- **tsconfig reading for path aliases.** Comments were stripped with a regular expression that took `/*` inside a string such as `"@app/*"` for the start of a block comment. When a later string contained `*/`, as `"src/**/*.ts"` does, the JSON was corrupted and every alias was silently ignored. The file is now parsed as JSONC, and `extends`, `baseUrl` and `paths` follow TypeScript's rules. The tsconfig files of Yeap-UI-Apps were already read correctly and give the same mappings.
- **Single path resolver.** The editor used a copy of the alias code built on `workspace.fs` and `Uri`; it now uses the Node implementation of **Format Folder**. Results are identical on macOS and Linux. On Windows, the drive letter is no longer lower-cased on one side only.

## 7. Compatibility suite

`test/compat/fixtures/workspace` is a small project with its own `tsconfig.json`, flat ESLint configuration, root and nested TidyJS configurations, `.vscode/settings.json`, and files covering default, named, type, side-effect and namespace imports, comments, aliases, unused imports, missing modules, TS, TSX, JS and JSX, a syntax error, an invalid configuration, the ignore pragma, an excluded folder, an import after code and post-processing.

- `npm run test:compat:record` starts VS Code with the extension built from the repository and the ESLint extension, opens each file, waits until its diagnostics are stable, runs **Format Document** and stores the result in `test/compat/expected`, with the diagnostics VS Code had (`vscode-report.json`). VS Code is pointed at the project's TypeScript so both runtimes use the same version.
- `npm test` runs the built CLI on a copy of the fixtures and compares every file with the recording. A file may differ only if `test/compat/divergences.json` lists it with its cause; the test fails if an undocumented difference appears or a documented one disappears.

## 8. Real-project check and performance

On a copy of Yeap-UI-Apps (TypeScript 6.0.3, ESLint 9.39 flat configs, `eslint.workingDirectories` with process cwd changes), two samples of 40 and 200 files of `apps/paye`, `apps/pdf` and `packages/ds` were formatted in VS Code 1.140 and by the CLI. Half of them received an unused `react` import and an import of a missing module. The CLI produced the same text as VS Code for every file, and removed all injected defects, in four configurations: default options, two workers, TypeScript 7 through `--typescript`, and both.

| Full analysis, run (median of 3) | Before optimization | TypeScript 6 | TypeScript 7 |
|---|---|---|---|
| One file of `apps/paye` | 3.4 s | 2.2 s | 1.0 s |
| `apps/paye/src/@app/dossier`, 1,124 files | 23 s | 14.8 s | 6.7 s |
| Same, `--no-diagnostics` | 1.7 s | 1.7 s | 1.7 s |

With TypeScript 6 the floor is the program build (about 2 s for `apps/paye`) and the type check of each file. With TypeScript 7 the floor is ESLint, about 4 s for 1,124 files.

## 9. Fast import analysis

`src/cli/import-oracle.ts` decides, for most files, what the TypeScript checker and ESLint would report about imports, without running either of them.

- **References** come from `@typescript-eslint/scope-manager`, the scope analysis ESLint itself uses, run with no JSX pragma so that only written references count. It runs on the syntax tree of `oxc-parser` rather than `@typescript-eslint/typescript-estree`: on the 1,976 files of Yeap-UI-Apps, import bindings, reference counts, writes, positions, JSX presence and JSDoc words are identical, and the CLI no longer loads a second copy of TypeScript to parse.
- **Unused imports.** An import with a reference is used for TypeScript and for ESLint. An import without reference makes TypeScript report `6133` at the import, unless one of the exceptions below applies, so the union read by the editor marks it unused whatever ESLint says. ESLint never has to run.
- **Missing modules.** `ts.resolveModuleName` with the project's options and the resolution mode of the import decides resolution. An unresolved specifier covered by an ambient `declare module` (root declaration files, `types`, and the files they reference) is not missing. Anything else is not decided.
- **Exceptions**, each checked against TypeScript 5.9 and 6.0, fall back in two stages.
  - **File-only analysis**, when every module resolves: declaration files; `@ts-check` and `@ts-nocheck`; `noCheck`; JavaScript files with `checkJs: false`; TypeScript suggestions disabled without `noUnusedLocals`; a multi-binding import entirely unused (TypeScript reports `6192` without names, so ESLint decides); a name inside `{@link}` (TypeScript files) or any JSDoc braces (JavaScript files); the JSX factory in classic JSX mode; an import that is reassigned. A language service holding only that file (`noResolve`, `noLib`, `types: []`, the project's other options) gives TypeScript's unused-name diagnostics, the only ones kept, and the project's ESLint lints the file. Whether a name is used never depends on another file, so these diagnostics match the whole program; missing modules cannot occur because every module resolved. With only `removeMissingModules`, nothing has to run.
  - **Full analysis**: a module that does not resolve, a parse error, or `emitDecoratorMetadata` with decorators in the file, where the decision depends on the types of the imports.

Validation: on all 1,976 files of `apps/paye`, `apps/pdf` and `packages/ds`, with and without injected defects, the CLI produced byte-identical files with and without `--no-fast-analysis`. The file-only stage was checked the same way on 200 files of Yeap-UI-Apps, each injected in turn with a `{@link}` to an otherwise unused import, a multi-binding import entirely unused, `@ts-nocheck`, and a reassigned import: 200 identical files for each injection. The compatibility fixtures and the 20, 40 and 200-file recordings from VS Code match in both modes.

The fast analysis reads `tsconfig.json` through `src/cli/tsconfig-cache.ts`. It parses the configuration with a host that records every file read, every file found missing and every folder walked by TypeScript's own file matcher (`ts.matchFiles`, an internal function; without it the cache is off), and stores the options, file list and references in the system temporary folder. A later run reuses them only if every recorded file and folder keeps its modification time and size and every missing file is still missing. A file added, removed or renamed changes the modification time of its folder. The full analysis always parses the configuration again.

## 10. Execution model and speed

```text
tidyjs ──┬── main process: config, TypeScript (classic API or TypeScript 7 native API), formatting
         ├── ESLint host process: the project's ESLint, started at launch, linting while TypeScript checks
         └── worker processes (--jobs): each one runs the two lines above on a contiguous slice of the files
```

Every optimization keeps the result identical; each one was checked with the compatibility suite.

| Optimization | Why it is exact |
|---|---|
| No analysis for files without imports | The analysis only filters imports. |
| ESLint in its own process, in parallel with TypeScript | Same ESLint, same configuration, same working directory; `process.chdir` stays possible because it is a process, not a thread. |
| ESLint skipped when only `removeMissingModules` is on and TypeScript reports no missing module | ESLint diagnostics are then only used for the unused names of missing modules. |
| Worker processes | Files are independent: each file's diagnostics depend on the project and on that file only. |
| TypeScript 7 native API when the project uses TypeScript 7 | It is the compiler the project uses. |

Options studied and rejected:

- **ESLint without type information.** typescript-eslint builds a second TypeScript program when the configuration enables typed linting, but `no-unused-vars` does not need types. Yeap-UI-Apps does not enable typed linting, so there was nothing to gain there. Elsewhere, an untyped parse would not fail on files outside the project, while the typed parse used by the editor does, and the editor then reports no unused names. The result could differ, so this is not done.
- **Skipping ESLint whenever TypeScript already reports some unused names.** ESLint can report names TypeScript considers used, for example names referenced only from `{@link}`, files with `// @ts-nocheck`, or a different `jsxPragma`. The fast import analysis (section 9) skips ESLint only when those cases are excluded.
- **A reduced TypeScript program** (the files to format, their imports, the declaration files and the files declaring globals). The diagnostics were identical on 96 files of Yeap-UI-Apps, but the program still loaded 3,087 of 3,226 files because the application's imports are densely connected: 1.5 s instead of 2.0 s, not worth the risk.
- **`bun check`** (Bun 1.4.3 canary, a port of typescript-go). It checked all of `apps/paye` in 2.2 s, and with `--noUnusedLocals --noUnusedParameters` it reported the same unused and missing-module diagnostics as the TypeScript 6 language service on those files. It is not used: it only reports what `tsc` reports, so JavaScript files without `checkJs` and files outside a `tsconfig.json` get no unused-name diagnostics while the editor gets them as suggestions; its output is text meant for humans, not an API; it requires a canary runtime; and on these runs ESLint, not TypeScript, is the remaining bottleneck with TypeScript 7.
- **More than two workers with TypeScript 6.** Each worker type-checks the declarations shared by its files again. On 1,124 files, four workers used 2.4 times the CPU for a smaller gain than two.
