/**
 * File header comment, preserved above the imports.
 */
// Node
import {readFileSync} from 'fs';

// External
import {createPatch} from 'diff';

// Shared
import {helper} from '@shared/helper';

export const value = [createPatch, readFileSync, helper];
