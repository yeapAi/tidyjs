// Node
import {join}    from 'path';
import {resolve} from 'node:path';
import {
  existsSync,
  readFileSync,
  writeFileSync,
}                from 'fs';
import {tmpdir}  from 'os';

// Packages
import {
  applyPatch,
  createPatch,
}              from 'diff';
import {parse} from 'jsonc-parser';

// Other
import {helper} from '@shared/helper';

export const all = [readFileSync, existsSync, writeFileSync, tmpdir, parse, createPatch, applyPatch, join, helper, resolve];
