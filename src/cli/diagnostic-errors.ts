import type { LinterName } from './linter';

export type DiagnosticsSource = 'typescript' | LinterName;

export class DiagnosticsUnavailableError extends Error {
    constructor(readonly source: DiagnosticsSource, message: string) {
        super(message);
        this.name = 'DiagnosticsUnavailableError';
    }
}
