import { createPatch } from 'diff';
import { readFileSync } from 'fs';

export const patch = createPatch('a', 'b', 'c');
export const label = (value: string, createPatch: string): string => value;
