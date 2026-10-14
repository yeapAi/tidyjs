import { spawn } from 'child_process';

import type { ChildProcess } from 'child_process';

interface JsonRpcMessage {
    id?: number | string;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: { code: number; message: string };
}

type ServerRequestHandler = (method: string, params: unknown) => unknown;
type ServerNotificationHandler = (method: string, params: unknown) => void;

interface PendingRequest {
    resolve: (result: never) => void;
    reject: (error: Error) => void;
}

const HEADER_SEPARATOR = '\r\n\r\n';

export class LanguageServerError extends Error {
    constructor(message: string, readonly code?: number) {
        super(message);
        this.name = 'LanguageServerError';
    }
}

export class LanguageServerConnection {
    private readonly child: ChildProcess;
    private readonly pending = new Map<number, PendingRequest>();
    private buffer = Buffer.alloc(0);
    private nextId = 1;
    private stopError: Error | undefined;

    constructor(
        command: string,
        args: string[],
        cwd: string,
        private readonly handleServerRequest: ServerRequestHandler,
        private readonly handleServerNotification: ServerNotificationHandler = () => undefined
    ) {
        this.child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
        this.child.stdout!.on('data', (chunk: Buffer) => this.receive(chunk));
        this.child.stdin!.on('error', () => undefined);
        this.child.on('exit', (code, signal) => this.stop(`language server stopped (${signal ?? code})`));
        this.child.on('error', (error) => this.stop(`language server failed to start (${error.message})`));
    }

    request<Result>(method: string, params: unknown): Promise<Result> {
        if (this.stopError) {
            return Promise.reject(this.stopError);
        }
        const id = this.nextId++;
        return new Promise<Result>((resolve, reject) => {
            this.pending.set(id, { resolve: resolve as (result: never) => void, reject });
            this.write({ id, method, params });
        });
    }

    notify(method: string, params: unknown): void {
        if (!this.stopError) {
            this.write({ method, params });
        }
    }

    dispose(): void {
        this.stop('language server disposed');
        this.child.kill();
    }

    private write(message: JsonRpcMessage): void {
        const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
        this.child.stdin!.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}${HEADER_SEPARATOR}`), body]));
    }

    private stop(reason: string): void {
        this.stopError ??= new LanguageServerError(reason);
        for (const waiter of this.pending.values()) {
            waiter.reject(this.stopError);
        }
        this.pending.clear();
    }

    private receive(chunk: Buffer): void {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        for (;;) {
            const headerEnd = this.buffer.indexOf(HEADER_SEPARATOR);
            if (headerEnd < 0) {
                return;
            }
            const length = Number(/Content-Length: *(\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString('ascii'))?.[1]);
            if (!Number.isInteger(length)) {
                this.stop('language server sent a message without Content-Length');
                this.child.kill();
                return;
            }
            const bodyStart = headerEnd + HEADER_SEPARATOR.length;
            if (this.buffer.length < bodyStart + length) {
                return;
            }
            const message = JSON.parse(this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8')) as JsonRpcMessage;
            this.buffer = this.buffer.subarray(bodyStart + length);
            this.dispatch(message);
        }
    }

    private dispatch(message: JsonRpcMessage): void {
        if (message.id !== undefined && message.method !== undefined) {
            try {
                this.write({ id: message.id, result: this.handleServerRequest(message.method, message.params) ?? null });
            } catch (error) {
                this.write({ id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
            }
            return;
        }
        if (message.id === undefined) {
            if (message.method !== undefined) {
                this.handleServerNotification(message.method, message.params);
            }
            return;
        }
        if (typeof message.id !== 'number') {
            return;
        }
        const waiter = this.pending.get(message.id);
        if (!waiter) {
            return;
        }
        this.pending.delete(message.id);
        if (message.error) {
            waiter.reject(new LanguageServerError(message.error.message, message.error.code));
        } else {
            waiter.resolve(message.result as never);
        }
    }
}
