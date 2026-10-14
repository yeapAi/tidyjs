import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LanguageServerConnection, LanguageServerError } from '../../src/cli/lsp-connection';

const FAKE_SERVER = `
let buffer = Buffer.alloc(0);
let nextId = 1000;
const waiting = new Map();

function frame(message) {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
    return Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\\r\\n\\r\\n'), body]);
}

function send(message) {
    process.stdout.write(frame(message));
}

function handle(message) {
    if (message.method === undefined) {
        const resolve = waiting.get(message.id);
        waiting.delete(message.id);
        if (resolve) {
            resolve(message.result);
        }
        return;
    }
    switch (message.method) {
        case 'echo':
            return send({ id: message.id, result: message.params });
        case 'fail':
            return send({ id: message.id, error: { code: -32000, message: 'boom' } });
        case 'askClient': {
            const id = nextId++;
            waiting.set(id, (result) => send({ id: message.id, result }));
            return send({ id, method: 'workspace/configuration', params: message.params });
        }
        case 'split': {
            const whole = frame({ id: message.id, result: 'in two chunks' });
            process.stdout.write(whole.subarray(0, 10));
            return setTimeout(() => process.stdout.write(whole.subarray(10)), 20);
        }
        case 'notify':
            send({ method: 'window/showMessage', params: { type: 1, message: 'hello' } });
            return send({ id: message.id, result: 'done' });
        case 'die':
            return process.exit(3);
    }
}

process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
        const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
        if (headerEnd < 0) {
            return;
        }
        const length = Number(/Content-Length: (\\d+)/.exec(buffer.subarray(0, headerEnd).toString())[1]);
        if (buffer.length < headerEnd + 4 + length) {
            return;
        }
        const message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString());
        buffer = buffer.subarray(headerEnd + 4 + length);
        handle(message);
    }
});
`;

describe('LanguageServerConnection', () => {
    let directory: string;
    let script: string;
    let connection: LanguageServerConnection | undefined;

    function connect(handler: (method: string, params: unknown) => unknown = () => null, onNotification?: (method: string, params: unknown) => void): LanguageServerConnection {
        connection = new LanguageServerConnection(process.execPath, [script], directory, handler, onNotification);
        return connection;
    }

    beforeAll(() => {
        directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tidyjs-lsp-')));
        script = path.join(directory, 'server.cjs');
        fs.writeFileSync(script, FAKE_SERVER);
    });

    afterAll(() => {
        fs.rmSync(directory, { recursive: true, force: true });
    });

    afterEach(() => {
        connection?.dispose();
        connection = undefined;
    });

    test('resolves a request with the result of the server', async () => {
        await expect(connect().request('echo', { value: 'é😀' })).resolves.toEqual({ value: 'é😀' });
    });

    test('rejects a request with the error of the server', async () => {
        const failure = await connect().request('fail', null).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(LanguageServerError);
        expect(failure).toMatchObject({ message: 'boom', code: -32000 });
    });

    test('answers the requests of the server with the handler', async () => {
        const handler = jest.fn(() => ['configured']);

        await expect(connect(handler).request('askClient', { items: [{ section: 's' }] })).resolves.toEqual(['configured']);
        expect(handler).toHaveBeenCalledWith('workspace/configuration', { items: [{ section: 's' }] });
    });

    test('hands the notifications of the server to the notification handler, and ignores them without one', async () => {
        const received: [string, unknown][] = [];

        await expect(connect(() => null, (method, params) => received.push([method, params])).request('notify', null)).resolves.toBe('done');
        expect(received).toEqual([['window/showMessage', { type: 1, message: 'hello' }]]);

        connection?.dispose();
        await expect(connect().request('notify', null)).resolves.toBe('done');
    });

    test('reads a message split across several chunks', async () => {
        await expect(connect().request('split', null)).resolves.toBe('in two chunks');
    });

    test('rejects the pending request and the next ones when the server stops', async () => {
        const server = connect();

        await expect(server.request('die', null)).rejects.toThrow('language server stopped (3)');
        await expect(server.request('echo', 1)).rejects.toThrow('language server stopped (3)');
    });

    test('rejects the requests made after dispose', async () => {
        const server = connect();
        server.dispose();

        await expect(server.request('echo', 1)).rejects.toThrow('language server disposed');
    });

    test('reports a server that cannot start', async () => {
        connection = new LanguageServerConnection(path.join(directory, 'missing-binary'), [], directory, () => null);

        await expect(connection.request('echo', 1)).rejects.toThrow(/failed to start|stopped/);
    });
});
