import { readFileSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { parse } from 'jsonc-parser';
import { createPatch, applyPatch } from 'diff';
import { join } from 'path';
import { helper } from '@shared/helper';
import { resolve } from 'node:path';

export const all = [readFileSync, existsSync, writeFileSync, tmpdir, parse, createPatch, applyPatch, join, helper, resolve];
