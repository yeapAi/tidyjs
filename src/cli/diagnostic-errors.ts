export type DiagnosticsSource = 'typescript' | 'eslint';

export class DiagnosticsUnavailableError extends Error {
    constructor(readonly source: DiagnosticsSource, message: string) {
        super(message);
        this.name = 'DiagnosticsUnavailableError';
    }
}
