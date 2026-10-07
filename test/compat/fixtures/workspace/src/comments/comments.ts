/**
 * File header comment, preserved above the imports.
 */
// a hand-written comment above an import
import { createPatch } from 'diff';
import { readFileSync } from 'fs'; // trailing comment
/* block comment between imports */
import { helper } from '@shared/helper';

export const value = [createPatch, readFileSync, helper];
