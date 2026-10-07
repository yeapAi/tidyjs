import { createPatch } from 'diff';
import { readFileSync } from 'fs';

export const value = [createPatch, readFileSync];
