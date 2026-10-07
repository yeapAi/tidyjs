// External
import {createPatch} from 'diff';

export const patch = createPatch('a', 'b', 'c');
export const label = (value: string, createPatch: string): string => value;
