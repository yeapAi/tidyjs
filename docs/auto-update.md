# Automatic Updates

This fork of TidyJS is not published on the Marketplace. Its `.vsix` is built by the release workflow and attached to the GitHub releases of `yeapAi/tidyjs`. The extension installs new releases by itself, so every machine that already has it follows the releases without any action.

## How it works

- About 15 seconds after the extension starts, and at most once every 24 hours, it asks GitHub for the latest release of `yeapAi/tidyjs`.
- If that release is newer than the installed version, it downloads `tidyjs-<version>.vsix` and installs it with the VS Code command `workbench.extensions.installExtension`, the same installation as `code --install-extension`.
- A message offers to reload the window. Until the reload, the previous version keeps running; the new one starts at the next reload or restart.
- The file is never installed if any check fails:
  - the release is a draft or a prerelease, or its tag is not `vX.Y.Z`, or its version is not newer (no downgrade);
  - the package is not named `tidyjs-<version>.vsix` or is not hosted at `https://github.com/yeapAi/tidyjs/releases/download/<tag>/`;
  - the downloaded size differs from the size GitHub announces, or its SHA-256 differs from the digest GitHub publishes for the asset;
  - the file is not a valid zip archive (its central directory is read and every entry must have its local header), has no `extension/package.json`, or has no `extension/dist/parser.<platform>-<arch>*.node` entry for the machine, which keeps a build made on Apple Silicon from replacing a working install on another platform.
- A failure is written to the TidyJS output channel, not shown, and the next attempt is a day later.
- Nothing runs when the extension is started from a checkout (Extension Development Host) or in tests, the command included: it then only says so.

## Settings and command

| Name | Effect |
|---|---|
| `tidyjs.autoUpdate` | `true` by default. Set it to `false` to stop the daily check. |
| `TidyJS: Check for Updates` | Checks now, whatever `tidyjs.autoUpdate` says, and tells you when the installed version is already the latest. |

## First installation

The first version that contains the updater has to be installed once by hand, because the versions before it cannot update themselves:

```bash
gh release download -R yeapAi/tidyjs -p '*.vsix' --clobber
code --install-extension tidyjs-*.vsix --force
```

Without `gh`, download the `.vsix` from the [latest release](https://github.com/yeapAi/tidyjs/releases/latest) and run `code --install-extension <file> --force`. Reload the window afterwards. From then on, releases arrive on their own.

## Limits to know

- **Every merged pull request is a release.** `.github/workflows/release.yml` publishes a version on each merge to `main`, so a merge reaches every machine within a day. A faulty release is replaced by publishing a fixed, higher version; users can stop it earlier with `tidyjs.autoUpdate`.
- **Trust.** Whoever can publish a release in `yeapAi/tidyjs` can run code in the editors of everyone who has the extension. The checks above detect corruption and a wrong file, not a malicious release.
- **GitHub's unauthenticated limit** is 60 requests per hour and per address. One check a day per machine stays far below it.
- **Editors.** The command is the VS Code one. It was verified in VS Code 1.141.1; Cursor and other forks were not tried.
- **`.vscode/extensions.json` cannot do this.** Workspace recommendations only name Marketplace extensions, never a `.vsix`, and `Asmir.tidyjs` there points to the Marketplace version, not to this fork.
