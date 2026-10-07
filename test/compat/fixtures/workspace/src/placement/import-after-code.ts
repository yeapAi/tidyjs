import { readFileSync } from 'fs';
import { createPatch } from 'diff';

export const first = readFileSync;

import { applyPatch } from 'diff';

export const second = [createPatch, applyPatch];
