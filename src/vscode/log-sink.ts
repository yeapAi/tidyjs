import * as vscode from 'vscode';

import type { LogSink } from '../utils/log';

export function createVSCodeLogSink(): LogSink {
    const outputChannel = vscode.window.createOutputChannel('TidyJS');

    return {
        isDebugEnabled: () => vscode.workspace.getConfiguration('tidyjs').get('debug', false),
        debug: (message) => outputChannel.appendLine(message),
        error: (message) => {
            outputChannel.appendLine(message);
            outputChannel.show(true);
        },
        notifyError: (message) => {
            void vscode.window.showErrorMessage(message);
        },
        reveal: () => outputChannel.show(),
    };
}
