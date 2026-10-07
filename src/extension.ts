// Other
import { sortPropertiesInSelection } from './destructuring-sorter';
import { formatFolder } from './batch-formatter';
import { formatSource, isFileInExcludedFolder, ParserCache } from './core/pipeline';
import { InvalidImport } from './parser';

// VSCode
import { Range, window, commands, TextEdit, workspace, languages, CancellationTokenSource, ProgressLocation, Uri } from 'vscode';
import type { TextDocument, ExtensionContext, FormattingOptions, CancellationToken, DocumentFormattingEditProvider } from 'vscode';
import { configManager } from './vscode/config-manager';
import { ConfigLoader } from './vscode/config-loader';
import { diagnosticsCache, getPublishedDiagnostics } from './vscode/diagnostics';
import { createVSCodeLogSink } from './vscode/log-sink';
import { showMessage } from './vscode/messages';

// Utils
import { createDocumentSnapshot, FormattingRetryScheduler, hasDocumentChanged } from './utils/format-concurrency';
import { logDebug, logError, setLogSink } from './utils/log';
import { perfMonitor } from './utils/performance';
import { getMinimalTextReplacement } from './utils/text-edit';

// Node
import { writeFileSync } from 'fs';
import { join } from 'path';

const parsers = new ParserCache(new Map(), 1);
const retryScheduler = new FormattingRetryScheduler((documentKey) => {
    const activeEditor = window.activeTextEditor;

    if (!activeEditor || activeEditor.document.uri.toString() !== documentKey) {
        return;
    }

    void commands.executeCommand('tidyjs.forceFormatDocument');
});

function createDocumentEdits(document: TextDocument, originalText: string, updatedText: string): TextEdit[] | undefined {
    const replacement = getMinimalTextReplacement(originalText, updatedText);

    if (!replacement) {
        return undefined;
    }

    return [
        TextEdit.replace(
            new Range(document.positionAt(replacement.start), document.positionAt(replacement.end)),
            replacement.newText
        ),
    ];
}

/**
 * TidyJS Document Formatting Provider
 */
class TidyJSFormattingProvider implements DocumentFormattingEditProvider {
    async provideDocumentFormattingEdits(
        document: TextDocument,
        _options: FormattingOptions,
        _token: CancellationToken
    ): Promise<TextEdit[] | undefined> {
        try {
            const snapshot = createDocumentSnapshot(document);

            const currentConfig = await configManager.getConfigForDocument(document);

            logDebug(`Document config loaded for ${document.fileName}:`, {
                debug: currentConfig.debug,
                groups: currentConfig.groups?.length || 0,
                formatConfig: currentConfig.format,
                singleQuote: currentConfig.format?.singleQuote,
                indent: currentConfig.format?.indent
            });

            const workspaceRoot = workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;

            if (isFileInExcludedFolder(document.uri.fsPath, currentConfig, workspaceRoot)) {
                logDebug('Formatting skipped: document is in excluded folder');
                return undefined;
            }

            const documentText = document.getText();

            perfMonitor.clear();
            perfMonitor.start('total_format_operation');

            const outcome = await formatSource({
                text: documentText,
                filePath: document.fileName,
                config: currentConfig,
                workspaceRoot,
                parsers,
                profile: 'editor',
                getDiagnostics: async () => getPublishedDiagnostics(document),
            });

            const totalDuration = perfMonitor.end('total_format_operation');
            logDebug(`Document formatting completed in ${totalDuration.toFixed(2)}ms`);

            if (configManager.getConfig().debug) {
                perfMonitor.logSummary();
            }

            if (outcome.status === 'unchanged') {
                return undefined;
            }

            if (outcome.status === 'failed') {
                switch (outcome.stage) {
                    case 'parser-init':
                        logError('Error initializing parser with document config:', outcome.message);
                        break;
                    case 'invalid-imports':
                        logError('Invalid imports found:', (outcome.invalidImports ?? []).map(formatImportError).join('\n'));
                        break;
                    case 'format':
                        logError('Formatting error:', outcome.message);
                        break;
                    case 'validation':
                        logError('Post-format validation failed:', outcome.message);
                        showMessage.error(`TidyJS formatting aborted: ${outcome.message}`);
                        break;
                }
                return undefined;
            }

            if (hasDocumentChanged(document, snapshot)) {
                const scheduled = retryScheduler.schedule(snapshot.uri);
                logDebug(`Formatting skipped due to concurrent document change (${snapshot.uri}). Retry scheduled: ${scheduled}`);
                return undefined;
            }

            return createDocumentEdits(document, documentText, outcome.text);
        } catch (error) {
            logError('Error in provideDocumentFormattingEdits:', error);
            return undefined;
        } finally {
            diagnosticsCache.clear();
        }
    }
}

/**
 * Vérifie que l'extension est activée avant d'exécuter une commande
 */
async function ensureExtensionEnabled(document?: import('vscode').TextDocument): Promise<boolean> {
    // Get document-specific config if document is provided
    const config = document ? await configManager.getConfigForDocument(document) : configManager.getParserConfig();
    
    // Validate the configuration
    const validation = configManager.validateConfiguration(config);

    if (!validation.isValid) {
        showMessage.error(
            `TidyJS extension is disabled due to configuration errors:\n${validation.errors.join(
                '\n'
            )}\n\nPlease fix your configuration to use the extension.`
        );
        return false;
    }

    try {
        parsers.get(config);
    } catch (error) {
        logError('Error initializing parser:', error);
        showMessage.error(`Error initializing parser: ${error}`);
        return false;
    }

    return true;
}

export function activate(context: ExtensionContext): void {
    try {
        setLogSink(createVSCodeLogSink());

        // Initialize ConfigManager with context
        configManager.initialize(context);
        
        // Validate configuration on startup
        const validation = configManager.validateCurrentConfiguration();

        if (validation.isValid) {
            parsers.get(configManager.getParserConfig());
        } else {
            showMessage.error(
                `TidyJS extension disabled due to configuration errors:\n${validation.errors.join(
                    '\n'
                )}\n\nPlease fix your configuration to use the extension.`
            );
            logError('Extension started with invalid configuration - commands disabled:', validation.errors);
            parsers.clear();
        }

        // Enregistrer TidyJS comme formatting provider pour TypeScript et JavaScript
        // Note: Nous pouvons utiliser des patterns glob négatifs dans le documentSelector
        // mais ils ne sont pas encore bien supportés par VS Code pour les formatters.
        // Pour l'instant, nous gardons la vérification manuelle dans provideDocumentFormattingEdits
        const documentSelector = [
            { language: 'typescript', scheme: 'file' },
            { language: 'typescriptreact', scheme: 'file' },
            { language: 'javascript', scheme: 'file' },
            { language: 'javascriptreact', scheme: 'file' },
        ];

        const formattingProvider = languages.registerDocumentFormattingEditProvider(documentSelector, new TidyJSFormattingProvider());

        const formatCommand = commands.registerCommand('tidyjs.forceFormatDocument', async () => {
            const editor = window.activeTextEditor;
            if (!editor) {
                showMessage.warning('TidyJS: No active editor found.', 3000);
                return;
            }

            if (!await ensureExtensionEnabled(editor.document)) {
                return;
            }

            // Forcer l'utilisation de TidyJS comme formatter pour cette exécution
            // en appelant directement notre provider
            const provider = new TidyJSFormattingProvider();
            const tokenSource = new CancellationTokenSource();
            try {
                const edits = await provider.provideDocumentFormattingEdits(
                    editor.document,
                    { tabSize: 2, insertSpaces: true },
                    tokenSource.token
                );

                if (edits && edits.length > 0) {
                    await editor.edit((editBuilder) => {
                        edits.forEach((edit) => {
                            editBuilder.replace(edit.range, edit.newText);
                        });
                    });
                    logDebug('Imports formatted successfully via command!');
                } else {
                    logDebug('No formatting changes needed');
                }
            } finally {
                tokenSource.dispose();
            }
        });

        const createConfigCommand = commands.registerCommand('tidyjs.createConfigFile', async () => {
            try {
                // Show folder picker dialog
                const folderUri = await window.showOpenDialog({
                    canSelectFolders: true,
                    canSelectFiles: false,
                    canSelectMany: false,
                    openLabel: 'Select Folder',
                    title: 'Where do you want to create the .tidyjsrc file?'
                });

                if (!folderUri || folderUri.length === 0) {
                    return; // User cancelled
                }

                const selectedFolder = folderUri[0];
                const configPath = join(selectedFolder.fsPath, '.tidyjsrc');

                // Create minimal configuration
                const minimalConfig = {
                    format: {
                        indent: 4,
                        bracketSpacing: true
                    }
                };

                // Write the configuration file
                writeFileSync(configPath, JSON.stringify(minimalConfig, null, 2));

                // Open the created file
                const document = await workspace.openTextDocument(configPath);
                await window.showTextDocument(document);

                logDebug(`Created .tidyjsrc file at: ${configPath}`);
            } catch (error) {
                logError('Error creating config file:', error);
                showMessage.error(`Failed to create config file: ${error}`);
            }
        });

        const sortPropertiesCommand = commands.registerCommand('tidyjs.sortProperties', async () => {
            const editor = window.activeTextEditor;
            if (!editor) {
                showMessage.warning('TidyJS: No active editor found.', 3000);
                return;
            }

            const selection = editor.selection;
            if (selection.isEmpty) {
                showMessage.info('TidyJS: Select the code you want to sort, then run this command.', 3000);
                return;
            }

            const document = editor.document;
            const fullText = document.getText();
            const selectionStart = document.offsetAt(selection.start);
            const selectionEnd = document.offsetAt(selection.end);
            const currentConfig = await configManager.getConfigForDocument(document);

            const result = sortPropertiesInSelection(fullText, selectionStart, selectionEnd, currentConfig);

            if (result === null) {
                showMessage.info('TidyJS: No sortable patterns found in selection.', 3000);
                return;
            }

            const fullRange = new Range(document.positionAt(0), document.positionAt(fullText.length));
            await editor.edit((editBuilder) => {
                editBuilder.replace(fullRange, result);
            });
            logDebug('Selection sorted successfully via sortProperties command');
        });

        const formatFolderCommand = commands.registerCommand('tidyjs.formatFolder', async (folderUri?: Uri) => {
            // If no URI provided (invoked from command palette), ask user to pick a folder
            if (!folderUri) {
                const selected = await window.showOpenDialog({
                    canSelectFolders: true,
                    canSelectFiles: false,
                    canSelectMany: false,
                    openLabel: 'Select Folder',
                    title: 'Select folder to format',
                });
                if (!selected || selected.length === 0) {
                    return;
                }
                folderUri = selected[0];
            }

            const workspaceFolder = workspace.getWorkspaceFolder(folderUri);
            const workspaceRoot = workspaceFolder?.uri.fsPath;

            ConfigLoader.clearCache();
            configManager.clearDocumentCache();

            await window.withProgress(
                {
                    location: ProgressLocation.Notification,
                    title: 'TidyJS: Formatting folder...',
                    cancellable: true,
                },
                async (progress, token) => {
                    const result = await formatFolder(folderUri.fsPath, workspaceRoot, {
                        onProgress: (current, total, filePath) => {
                            const pct = Math.round((current / total) * 100);
                            const fileName = filePath.split('/').pop() ?? filePath;
                            progress.report({
                                increment: (1 / total) * 100,
                                message: `(${current}/${total}) ${fileName}`,
                            });
                            logDebug(`Batch format progress: ${pct}% — ${filePath}`);
                        },
                        isCancelled: () => token.isCancellationRequested,
                        resolveConfig: (filePath) => configManager.getConfigForUri(Uri.file(filePath)),
                        fallbackConfig: () => configManager.getConfig(),
                    });

                    if (token.isCancellationRequested) {
                        showMessage.info(
                            `TidyJS: Cancelled. ${result.formatted} file(s) formatted before cancellation.`, 5000
                        );
                        return;
                    }

                    if (result.errors.length > 0) {
                        const showErrors = 'Show Errors';
                        const choice = await showMessage.warning(
                            `${result.formatted} file(s) formatted, ${result.skipped} skipped, ${result.errors.length} error(s).`,
                            showErrors
                        );
                        if (choice === showErrors) {
                            const errorDetails = result.errors
                                .map((e) => `${e.filePath}: ${e.error}`)
                                .join('\n');
                            logError('Batch format errors:\n' + errorDetails);
                        }
                    } else {
                        showMessage.info(
                            `TidyJS: ${result.formatted} file(s) formatted, ${result.skipped} skipped.`, 5000
                        );
                    }
                }
            );
        });

        // Listen for configuration changes to invalidate parser cache
        const configChangeDisposable = workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('tidyjs')) {
                logDebug('TidyJS configuration changed, parser will be recreated on next use');
                parsers.clear();
                // Clear document config cache
                configManager.clearDocumentCache();
            }
        });

        context.subscriptions.push(formatCommand, createConfigCommand, sortPropertiesCommand, formatFolderCommand, formattingProvider, configChangeDisposable);

        logDebug('Extension activated successfully with config:', configManager.getConfig());

        if (validation.isValid) {
            logDebug('TidyJS extension is ready !');
        }
    } catch (error) {
        logError('Error activating extension:', error);
        showMessage.error(`TidyJS extension activation failed: ${error}`);
    }
}

function formatImportError(invalidImport: InvalidImport): string {
    if (!invalidImport || !invalidImport.error) {
        return 'Unknown import error';
    }

    const errorMessage = invalidImport.error;
    const importStatement = invalidImport.raw || '';
    const lineMatch = errorMessage.match(/\((\d+):(\d+)\)/);
    let formattedError = errorMessage;

    if (lineMatch && lineMatch.length >= 3) {
        const line = parseInt(lineMatch[1], 10);
        const column = parseInt(lineMatch[2], 10);

        const lines = importStatement.split('\n');

        if (line <= lines.length) {
            const problematicLine = lines[line - 1];
            const indicator = ' '.repeat(Math.max(0, column - 1)) + '^';
            formattedError = `${errorMessage}\nIn: ${problematicLine.trim()}\n${indicator}`;
        } else {
            formattedError = `${errorMessage}\nIn: ${importStatement.trim()}`;
        }
    }

    return formattedError;
}

export function deactivate(): void {
    try {
        logDebug('Extension deactivating - cleaning up resources');

        parsers.clear();

        retryScheduler.dispose();

        logDebug('Extension deactivated successfully');
    } catch (error) {
        logError('Error during extension deactivation:', error);
    }
}
