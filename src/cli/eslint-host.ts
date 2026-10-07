import { fork } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';

import { DiagnosticsUnavailableError } from './diagnostic-errors';
import { EslintDiagnosticsProvider } from './eslint-diagnostics';

import type { ChildProcess } from 'child_process';
import type { EslintEditorSettings, EslintFixResult, EslintLintResult } from './eslint-diagnostics';

export const ESLINT_HOST_FLAG = '--tidyjs-internal-eslint-host';

export interface EslintLinter {
    lint(filePath: string, text: string, workspaceRoot: string | undefined): Promise<EslintLintResult>;
    fixAll(filePath: string, text: string, workspaceRoot: string | undefined): Promise<EslintFixResult>;
    warm(filePath: string, workspaceRoot: string | undefined): void;
    prefetch(files: { filePath: string; workspaceRoot: string | undefined }[]): void;
    dispose(): void;
}

const BOM = '\uFEFF';

export function textDigest(text: string): string {
    return createHash('sha1').update(text).digest('hex');
}

type HostRequest =
    | { type: 'init'; settings: EslintEditorSettings }
    | { type: 'warm'; filePath: string; workspaceRoot: string | undefined }
    | { type: 'lint'; id: number; filePath: string; text: string; workspaceRoot: string | undefined }
    | { type: 'fixAll'; id: number; filePath: string; text: string; workspaceRoot: string | undefined }
    | { type: 'lintFile'; id: number; filePath: string; workspaceRoot: string | undefined };

type HostResponse =
    | { id: number; result: EslintLintResult | EslintFixResult; digest?: string }
    | { id: number; error: { message: string; unavailable: boolean }; digest?: string };

export function runEslintHost(): void {
    let provider: EslintDiagnosticsProvider | undefined;
    let queue: Promise<void> = Promise.resolve();

    process.on('message', (message: HostRequest) => {
        if (message.type === 'init') {
            provider = new EslintDiagnosticsProvider(message.settings);
            return;
        }
        queue = queue.then(async () => {
            if (!provider) {
                return;
            }
            if (message.type === 'warm') {
                await provider.warm(message.filePath, message.workspaceRoot);
                return;
            }
            let text: string;
            let digest: string | undefined;
            if (message.type === 'lintFile') {
                try {
                    const raw = await fs.promises.readFile(message.filePath, 'utf8');
                    text = raw.startsWith(BOM) ? raw.slice(1) : raw;
                } catch {
                    process.send?.({ id: message.id, error: { message: 'unreadable', unavailable: false }, digest: '' } satisfies HostResponse);
                    return;
                }
                digest = textDigest(text);
            } else {
                text = message.text;
            }
            let response: HostResponse;
            try {
                const result = message.type === 'fixAll'
                    ? await provider.fixAll(message.filePath, text, message.workspaceRoot)
                    : await provider.lint(message.filePath, text, message.workspaceRoot);
                response = { id: message.id, result, digest };
            } catch (error) {
                response = {
                    id: message.id,
                    error: {
                        message: error instanceof Error ? error.message : String(error),
                        unavailable: error instanceof DiagnosticsUnavailableError,
                    },
                    digest,
                };
            }
            process.send?.(response);
        });
    });
    process.on('disconnect', () => process.exit(0));
}

export class RemoteEslintLinter implements EslintLinter {
    private readonly child: ChildProcess;
    private readonly pending = new Map<number, { resolve: (result: never) => void; reject: (error: Error) => void; digest?: (digest: string | undefined) => void }>();
    private readonly prefetched = new Map<string, Promise<{ digest: string | undefined; outcome: { ok: true; result: EslintLintResult } | { ok: false; error: Error } }>>();
    private nextId = 0;
    private exitError: Error | undefined;

    constructor(script: string, settings: EslintEditorSettings) {
        this.child = fork(script, [ESLINT_HOST_FLAG], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], serialization: 'advanced' });
        this.child.on('message', (response: HostResponse) => {
            const waiter = this.pending.get(response.id);
            if (!waiter) {
                return;
            }
            this.pending.delete(response.id);
            waiter.digest?.(response.digest);
            if ('result' in response) {
                waiter.resolve(response.result as never);
            } else if (response.error.unavailable) {
                waiter.reject(new DiagnosticsUnavailableError('eslint', response.error.message));
            } else {
                waiter.reject(new Error(response.error.message));
            }
        });
        this.child.on('exit', (code, signal) => {
            this.exitError = new DiagnosticsUnavailableError('eslint', `ESLint process stopped (${signal ?? code})`);
            for (const waiter of this.pending.values()) {
                waiter.reject(this.exitError);
            }
            this.pending.clear();
        });
        this.child.send({ type: 'init', settings } satisfies HostRequest);
    }

    warm(filePath: string, workspaceRoot: string | undefined): void {
        if (!this.exitError) {
            this.child.send({ type: 'warm', filePath, workspaceRoot } satisfies HostRequest);
        }
    }

    prefetch(files: { filePath: string; workspaceRoot: string | undefined }[]): void {
        for (const { filePath, workspaceRoot } of files) {
            if (this.exitError || this.prefetched.has(filePath)) {
                continue;
            }
            const id = this.nextId++;
            this.prefetched.set(filePath, new Promise((settle) => {
                let digest: string | undefined;
                this.pending.set(id, {
                    digest: (value) => { digest = value; },
                    resolve: (result: EslintLintResult) => settle({ digest, outcome: { ok: true, result } }),
                    reject: (error) => settle({ digest, outcome: { ok: false, error } }),
                });
                this.child.send({ type: 'lintFile', id, filePath, workspaceRoot } satisfies HostRequest);
            }));
        }
    }

    async lint(filePath: string, text: string, workspaceRoot: string | undefined): Promise<EslintLintResult> {
        const prefetched = this.prefetched.get(filePath);
        if (prefetched) {
            this.prefetched.delete(filePath);
            const { digest, outcome } = await prefetched;
            if (digest === textDigest(text)) {
                if (outcome.ok) {
                    return outcome.result;
                }
                throw outcome.error;
            }
        }
        return this.request<EslintLintResult>({ type: 'lint', filePath, text, workspaceRoot });
    }

    fixAll(filePath: string, text: string, workspaceRoot: string | undefined): Promise<EslintFixResult> {
        return this.request<EslintFixResult>({ type: 'fixAll', filePath, text, workspaceRoot });
    }

    private request<Result>(message: { type: 'lint' | 'fixAll'; filePath: string; text: string; workspaceRoot: string | undefined }): Promise<Result> {
        if (this.exitError) {
            return Promise.reject(this.exitError);
        }
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.child.send({ ...message, id } satisfies HostRequest);
        });
    }

    dispose(): void {
        if (this.child.connected) {
            this.child.disconnect();
        }
    }
}
