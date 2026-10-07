import { createPatch } from 'diff';
import { readFileSync } from 'fs';
import { applyPatch } from 'diff';

export const Diff = () => <pre>{createPatch('a', readFileSync('b', 'utf8'), 'c')}</pre>;
