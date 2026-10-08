import { readFileSync } from 'fs';
import { createPatch, applyPatch } from 'diff';

export const value = readFileSync;
