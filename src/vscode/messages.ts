import { window } from 'vscode';

export const showMessage = {
    info: (message: string, timeoutOrItem?: number | string, ...items: string[]) => {
        if (typeof timeoutOrItem === 'number') { return window.setStatusBarMessage(message, timeoutOrItem); }
        const allItems = timeoutOrItem ? [timeoutOrItem, ...items] : items;
        return window.showInformationMessage(message, ...allItems);
    },

    error: (message: string, timeoutOrItem?: number | string, ...items: string[]) => {
        if (typeof timeoutOrItem === 'number') { return window.setStatusBarMessage(message, timeoutOrItem); }
        const allItems = timeoutOrItem ? [timeoutOrItem, ...items] : items;
        return window.showErrorMessage(message, ...allItems);
    },

    warning: (message: string, timeoutOrItem?: number | string, ...items: string[]) => {
        if (typeof timeoutOrItem === 'number') { return window.setStatusBarMessage(message, timeoutOrItem); }
        const allItems = timeoutOrItem ? [timeoutOrItem, ...items] : items;
        return window.showWarningMessage(message, ...allItems);
    },
};
