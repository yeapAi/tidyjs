import { createPatch } from 'diff';

export interface Options {
    verbose: boolean;
    id: number;
    patch: typeof createPatch;
}
