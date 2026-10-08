import { EventEmitter } from 'events';

import { runInWorkers } from '../../src/cli/parallel';

jest.mock('child_process', () => ({
    fork: jest.fn(() => {
        const child = Object.assign(new EventEmitter(), { connected: false, kill: jest.fn() });
        process.nextTick(() => child.emit('error', Object.assign(new Error('spawn EMFILE'), { code: 'EMFILE' })));
        return child;
    }),
}));

describe('runInWorkers', () => {
    test('settles without reports when a worker cannot be spawned', async () => {
        const onReport = jest.fn();

        await expect(runInWorkers('worker.js', {}, ['a.ts', 'b.ts'], 2, onReport)).resolves.toBeUndefined();
        expect(onReport).not.toHaveBeenCalled();
    });
});
