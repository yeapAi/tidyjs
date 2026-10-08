import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import type { Stats } from 'fs';
import * as os from 'os';

export const data = readFileSync('data.txt', 'utf8');
