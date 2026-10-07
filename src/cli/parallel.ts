import { fork } from 'child_process';
import * as os from 'os';

import type { FileReport } from './runner';

export const WORKER_FLAG = '--tidyjs-internal-worker';

export interface WorkerTask<Options> {
    options: Options;
    files: string[];
}

type WorkerMessage = { type: 'report'; index: number; report: FileReport } | { type: 'done' };

const FILES_PER_WORKER = 400;
const MAX_AUTOMATIC_WORKERS = 2;

export function automaticJobCount(fileCount: number): number {
    const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
    return Math.max(1, Math.min(MAX_AUTOMATIC_WORKERS, cores - 1, Math.floor(fileCount / FILES_PER_WORKER)));
}

export function splitContiguously<T>(items: T[], parts: number): T[][] {
    const chunks: T[][] = [];
    const size = Math.ceil(items.length / parts);
    for (let start = 0; start < items.length; start += size) {
        chunks.push(items.slice(start, start + size));
    }
    return chunks;
}

export async function runInWorkers<Options>(
    script: string,
    options: Options,
    files: string[],
    jobs: number,
    onReport: (index: number, report: FileReport) => void
): Promise<void> {
    const chunks = splitContiguously(files.map((file, index) => ({ file, index })), jobs);

    await Promise.all(chunks.map((chunk) => new Promise<void>((resolve) => {
        const child = fork(script, [WORKER_FLAG], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], serialization: 'advanced' });
        const indexes = chunk.map((entry) => entry.index);
        let done = false;

        child.on('message', (message: WorkerMessage) => {
            if (message.type === 'report') {
                onReport(indexes[message.index], message.report);
            } else {
                done = true;
                child.disconnect();
            }
        });
        child.on('exit', () => {
            if (!done) {
                child.removeAllListeners('message');
            }
            resolve();
        });
        child.send({ options, files: chunk.map((entry) => entry.file) } satisfies WorkerTask<Options>);
    })));
}
