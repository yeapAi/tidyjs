# Command-Line Interface

`tidyjs` runs the TidyJS engine from a terminal. This fork serves Yeap-UI-Apps, where it runs in the `yarn commit` step on the developer's machine, never in CI. It uses the same parser, IR printer, configuration resolution and guards as the VS Code extension, and computes the TypeScript and ESLint diagnostics that the extension reads from the editor. For a given project, it produces the result of a save in VS Code once the TypeScript server and ESLint have finished their analysis.

How the two runtimes relate, and where they can differ, is described in [cli-architecture.md](cli-architecture.md).

## Requirements

- Node.js 20 or later.
- The `oxc-parser` native binding for the current platform. The build copies the binding installed on the build machine into `dist/`, as for the extension, so a `.vsix` built on Apple Silicon only runs there.
- TypeScript, used only when `removeUnusedImports` or `removeMissingModules` is enabled. The project's own `typescript` package is used, so the diagnostics come from the version the project builds with. Without it, a warning is printed and nothing is removed; in a checkout of this repository, its own `typescript` is the fallback.
- ESLint, optional. It is always loaded from the project, never from TidyJS, because the project's configuration and plugins live there.

## Installation

TidyJS is not published on npm. The CLI ships inside the extension: `dist/cli.js` (a launcher that enables the V8 compile cache) and `dist/cli-main.js` (the bundle, with `oxc-parser` and its native binding) are packaged in the `.vsix` built by `npm run build`. Once the extension is installed, the CLI is at `~/.vscode/extensions/asmir.tidyjs-<version>/dist/cli.js`, with the same engine version as the editor.

From a checkout of this repository:

```bash
npm install
node scripts/esbuild.mjs --production
node dist/cli.js --help
```

## Usage

```text
tidyjs [options] <file | directory | glob>...
```

Without `--write` or `--check`, nothing is modified: the files that would change are listed and the exit code is 0.

```bash
tidyjs src                      # list the files that would change
tidyjs --diff src/app.tsx       # show the changes
tidyjs --check .                # exit 1 when a file would change
tidyjs --write .                # apply the changes
tidyjs --write "src/**/*.ts"    # quoted globs are expanded by tidyjs
tidyjs --write --staged         # pre-commit: staged files only
```

| Option | Effect |
|---|---|
| `-w`, `--write` | Write the formatted files. |
| `-c`, `--check` | Exit with code 1 when at least one file would change. |
| `--diff` | Print a unified diff of every change. Combines with any mode. |
| `--root <dir>` | Workspace root, the folder you would open in VS Code. Default: the nearest ancestor of the current directory that holds `.git` or `.vscode`, otherwise the current directory. |
| `--profile editor` | Default. Reproduces format on save, including diagnostics-based removal. |
| `--profile folder` | Reproduces the **TidyJS: Format Folder** command: no diagnostics, and `sortTypeMembers` applied even in files with imports. |
| `--no-typescript` | Do not compute TypeScript diagnostics. |
| `--no-eslint` | Do not run ESLint. |
| `--no-diagnostics` | Both of the above. |
| `--no-fast-analysis` | Always run the TypeScript checker and ESLint, instead of deciding unused and missing imports from the syntax first. The result is the same; only the time differs. |
| `--typescript <dir>` | Use this TypeScript package instead of the project's. A TypeScript 7 package runs through its native API. |
| `--changed` | Only process files changed since `HEAD`, plus untracked files. |
| `--staged` | Only process staged files. |
| `-j`, `--jobs <n>` | Number of worker processes. Default: 1, or 2 from 800 files when diagnostics are computed. |
| `-v`, `--verbose` | Also report unchanged and skipped files, the config file, the TypeScript project and version, the ESLint working directory, and the names removed. |
| `-q`, `--quiet` | Only report errors. |
| `--debug` | Print the TidyJS debug log to stderr, as the `tidyjs.debug` setting does in the output channel. |

Directories are walked like **Format Folder**: `.ts`, `.tsx`, `.js` and `.jsx` files, skipping `node_modules`, `.git`, `dist`, `build`, `out`, `.next`, `coverage`, `.cache` and `.turbo`. A file named explicitly is processed even inside those folders.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success. In `--check` mode, nothing to format. |
| 1 | `--check` found files to format. |
| 2 | At least one error: invalid configuration, syntax error, output that does not re-parse, unreadable or unwritable file, unknown target, or invalid arguments. |

Results go to stdout, one line per file. Warnings, errors and the summary go to stderr, so `--diff` output can be redirected cleanly.

## Configuration

The CLI resolves the configuration of each file with the extension's code:

1. The nearest `.tidyjsrc` or `tidyjs.json`, searched from the file's folder up to the workspace root, with `extends`.
2. The `tidyjs.*` settings of `<root>/.vscode/settings.json`, merged over the defaults declared by the extension, as `workspace.getConfiguration('tidyjs')` returns them.
3. The built-in defaults.

Groups, `sortOrder`, regular expressions, `importOrder`, `format`, `pathResolution`, `excludedFolders` and automatic ordering behave exactly as in the editor. User-level VS Code settings are not read, so a run gives the same result on every machine.

A configuration that the **Format Imports** command would refuse (no default group, several default groups, duplicate names, invalid regex or `sortOrder`) is reported as an error and the files using it are left untouched. Format on save in VS Code does not validate and still formats them; this is the only intentional difference.

## Diagnostics

The diagnostics are computed only for files whose configuration enables `removeUnusedImports` or `removeMissingModules`, as in the editor. They feed the same analysis: missing modules from TypeScript errors `2307`/`2318`, unused names from TypeScript `6133`/`6196` and from the ESLint rule `@typescript-eslint/no-unused-vars`.

**TypeScript.** The CLI finds the project the way the TypeScript server does: the nearest `tsconfig.json` or `jsconfig.json` that includes the file, then its project references, then ancestor configurations, and otherwise an inferred project with the options VS Code gives to loose files. It reads syntactic, semantic and suggestion diagnostics, like the editor. The settings `typescript.validate.enable`, `javascript.validate.enable`, `typescript.suggestionActions.enabled`, `javascript.suggestionActions.enabled` and `js/ts.implicitProjectConfig.*` are honoured.

**ESLint.** The CLI loads the project's ESLint through its Node API and computes the working directory with the rules of the VS Code ESLint extension (`eslint.workingDirectories`, including `!cwd`, patterns and modes). It honours `eslint.enable`, `eslint.validate`, `eslint.probe`, `eslint.options`, `eslint.useFlatConfig`, `eslint.quiet`, `eslint.nodePath` and `eslint.rules.customizations`. Only the rules TidyJS reads are executed when ESLint supports `ruleFilter` (ESLint 9).

When a source cannot run, removal falls back to the other source:

- ESLint not installed or not configured: silent, as in VS Code. `--verbose` shows it.
- ESLint or TypeScript failing (broken configuration, crash): a warning, and only the other source is used.
- No source at all: a warning, and nothing is removed. The imports are still sorted and aligned.

## ESLint fixes on save

With the `editor` profile, the CLI applies the fixes that the ESLint extension applies when a file is saved, before TidyJS formats it. They run when `editor.codeActionsOnSave` in `<root>/.vscode/settings.json` enables `source.fixAll.eslint`, or `source.fixAll` without disabling `source.fixAll.eslint`, with `true`, `"explicit"` or `"always"`. A `[language]` block, such as `[typescriptreact]`, overrides the general value. In Yeap-UI-Apps, this is how `@typescript-eslint/consistent-type-imports` moves a type-only name into `import type`.

The fixes come from the project's ESLint, through its Node API, with the rules of the ESLint extension (verified in version 3.0.34):

- ESLint is created with `eslint.options`, then `fix: true` and `eslint.codeActionsOnSave.options`, in the ESLint working directory, and lints the text of the file. Its `output` replaces the text.
- `eslint.codeActionsOnSave.rules` turns off, for the fixes, every rule whose first matching pattern starts with `!` or that no pattern matches. An empty list turns off every rule.
- Every fixable rule is applied, not only the rules about imports, as on save.
- The fixes also apply to files that TidyJS skips (`excludedFolders`, `// tidyjs-ignore`), as on save.
- `eslint.codeActionsOnSave.mode` set to `problems` applies the fixes the editor has already computed. That state only exists in the editor, so the CLI applies no fix and prints a warning.
- `source.fixAll` also runs the TypeScript fixes, and `source.addMissingImports` adds imports. The CLI reproduces neither.

`--no-eslint`, `--no-diagnostics` and `--profile folder` turn the fixes off. `--verbose` prints `eslint fixes: applied` or `none` for each file.

## Guards

Every guard of the extension applies:

- A syntax error leaves the file untouched and is reported as an error.
- The final text, re-exports and sorting included, is parsed again before writing. If it does not parse, nothing is written.
- `excludedFolders` and the `// tidyjs-ignore` pragma skip the file.
- Only the leading block of imports is reorganized. An import placed after code is left where it is.
- A UTF-8 byte order mark is preserved.

## Speed

Without diagnostics, a file takes about 1.5 ms. With `removeUnusedImports` or `removeMissingModules`, the CLI first decides each file from its syntax, and only runs the TypeScript checker and ESLint when that decision could differ from theirs.

**Fast import analysis.** For each import, the CLI counts its references with the scope analysis ESLint uses, and resolves its module with TypeScript's own module resolution and the ambient `declare module` declarations of the project.

- An import with at least one reference is used for both TypeScript and ESLint.
- An import without reference is reported by TypeScript at the import itself, so the editor removes it whatever ESLint says.
- A module that TypeScript's resolution finds, or that an ambient declaration covers, is not missing.

When that decision could differ from TypeScript or ESLint, the file falls back in two stages:

- **File-only analysis.** Every module resolves, but an unused name may be decided differently by TypeScript and ESLint: every binding of a multi-binding import is unused (TypeScript then reports them without names), a name is cited in `{@link}` (or in a JSDoc type in a JavaScript file), the file is a declaration file or carries `@ts-check`/`@ts-nocheck`, a JavaScript file has `checkJs: false`, TypeScript suggestions are disabled, the JSX factory may be involved, or an import is reassigned. TypeScript checks the file alone, without its imports or the default library, which reports the same unused names as the whole project, and the project's ESLint lints it.
- **Full analysis.** A module does not resolve, the file does not parse, or decorator metadata is emitted. TypeScript checks the file within its whole project, and ESLint lints it.

On Yeap-UI-Apps, 1 file out of 1,976 needs the file-only analysis and none the full analysis.

Other optimizations, none of which changes the result:

- Files without imports skip the analysis.
- ESLint runs in its own process, in parallel with TypeScript, and only when a file needs it.
- Large runs use worker processes.
- `--changed` and `--staged` limit a run to the files you touched.
- A project on TypeScript 7 is analysed through the native compiler.
- The fast analysis reads the file list of each `tsconfig.json` from a cache in the system temporary folder (`tidyjs-tsconfig-cache`). The cache is used only while every file the configuration read and every folder its `include` walked keep the same modification time.
- On Node.js 22.1 or later, `dist/cli.js` enables the V8 compile cache, so TidyJS and TypeScript are not compiled again on every run.
- `oxc-parser` returns its syntax trees through raw transfer when the platform supports it, instead of JSON.

`--typescript` can point a project still on TypeScript 6 to a TypeScript 7 install (`npm install --prefix ~/.tidyjs-ts7 typescript@7`, then `--typescript ~/.tidyjs-ts7/node_modules/typescript`) for the files that need the full analysis. The editor then runs another TypeScript version than the CLI: identical results were observed on Yeap-UI-Apps, but TypeScript 7 removed `baseUrl` and changed other options, so this is not guaranteed in general.

Measured on Yeap-UI-Apps (Apple Silicon laptop, 10 cores, real source code):

| Run | Default | `--no-fast-analysis`, TypeScript 6 | VS Code, formatting an open file |
|---|---|---|---|
| 1 file | 0.13 s | 2.3 s | 14 ms |
| 1 file needing the file-only analysis | 0.73 s | 2.0 s | not measured |
| 1 file with a missing module | 2.2 s | 2.2 s | not measured |
| 20 files | 0.30 s | 4.7 s | 0.3 s in total |
| 1,976 files | 3.3 to 4.1 s | 24 s | not applicable |

VS Code is faster per file because its TypeScript server and ESLint are already running; the CLI starts from nothing on every run.

## Yeap-UI-Apps

The monorepo calls the CLI through `scripts/tidyjs.ts`, only on the developer's machine:

- `yarn commit` runs `precommit` first (Yarn 1), which runs the script with `--commit`, then `yarn run check`. A file whose working-tree content equals the index is formatted with `--write` and staged again, which gives the same result as formatting before `git add`. A partially staged file is only checked with `--check`, so its unstaged changes never enter the commit: when it would change, the commit stops. A file that does not parse stops the commit too.
- `yarn tidy` runs `tidyjs --write` on the files the script selects with its own `--unstaged` flag: files modified in the working tree and untracked files, minus any file present in the index, even partially. A staged file is never written, so the index never falls behind. The developer reviews the result with `git diff`, then stages it.
- The script takes the CLI of the most recent `asmir.tidyjs-*` extension in the VS Code, VS Code Insiders or Cursor extension folders, or the file named by `TIDYJS_CLI`. Without one, the step is skipped with a warning.
- Before running, the script compares the entries of `yarn.lock` with `node_modules/.yarn-integrity` and stops if they differ: `removeMissingModules` is enabled in Yeap's `tidyjs.json`, so a package added on another branch and not yet installed would be removed as missing.

Git has no hook on `git add`, and VS Code stages with `git add` too, so `yarn commit` is the first point where the staged files are known.

## Compatibility tests

`npm test` runs the CLI on `test/compat/fixtures/workspace` and compares every file with the output recorded in VS Code (`test/compat/expected`). `npm run test:compat:record` records that output again with a real VS Code instance, the TidyJS extension built from the repository and the ESLint extension.
