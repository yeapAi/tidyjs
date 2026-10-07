const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function snapshot(uri) {
    return vscode.languages.getDiagnostics(uri).map((diagnostic) => ({
        source: diagnostic.source,
        code: typeof diagnostic.code === 'object' && diagnostic.code !== null ? diagnostic.code.value : diagnostic.code,
        severity: ['error', 'warning', 'info', 'hint'][diagnostic.severity],
        message: diagnostic.message,
        line: diagnostic.range.start.line,
    }));
}

async function waitForSettledDiagnostics(uri, options) {
    const started = Date.now();
    let last = JSON.stringify(snapshot(uri));
    let stableSince = Date.now();

    while (Date.now() - started < options.timeout) {
        await sleep(200);
        const current = snapshot(uri);
        const serialized = JSON.stringify(current);
        if (serialized !== last) {
            last = serialized;
            stableSince = Date.now();
        }
        const sources = new Set(current.map((diagnostic) => diagnostic.source));
        const requiredSeen = options.requireSources.every((source) => sources.has(source));
        if (requiredSeen && Date.now() - started >= options.minimum && Date.now() - stableSince >= options.stableFor) {
            return;
        }
    }
    if (options.requireSources.length > 0) {
        throw new Error(`Diagnostics from ${options.requireSources.join(', ')} never appeared for ${uri.fsPath}`);
    }
}

exports.run = async function run() {
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const outputDir = process.env.TIDYJS_COMPAT_OUT;
    const files = JSON.parse(process.env.TIDYJS_COMPAT_FILES);
    const warmup = process.env.TIDYJS_COMPAT_WARMUP;

    for (const id of ['dbaeumer.vscode-eslint', 'Asmir.tidyjs']) {
        const extension = vscode.extensions.getExtension(id);
        if (!extension) {
            throw new Error(`Extension ${id} is not available in the recording instance`);
        }
        await extension.activate();
    }

    const warmupUri = vscode.Uri.file(path.join(root, warmup));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(warmupUri));
    await waitForSettledDiagnostics(warmupUri, { timeout: 120000, minimum: 0, stableFor: 3000, requireSources: ['ts', 'eslint'] });
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');

    const report = { vscodeVersion: vscode.version, files: [] };

    for (const relativePath of files) {
        const uri = vscode.Uri.file(path.join(root, relativePath));
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document);
        await waitForSettledDiagnostics(uri, { timeout: 45000, minimum: 5000, stableFor: 3000, requireSources: [] });

        const before = document.getText();
        const diagnostics = snapshot(uri);
        const formatStarted = process.hrtime.bigint();
        await vscode.commands.executeCommand('editor.action.formatDocument');
        const formatMs = Number(process.hrtime.bigint() - formatStarted) / 1e6;
        await sleep(300);
        const after = document.getText();

        const target = path.join(outputDir, relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, after, 'utf8');
        report.files.push({ path: relativePath, changed: after !== before, formatMs, diagnostics });

        await vscode.commands.executeCommand('workbench.action.files.revert');
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }

    fs.writeFileSync(path.join(outputDir, 'vscode-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
};
