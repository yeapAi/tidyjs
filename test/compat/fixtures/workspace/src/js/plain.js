import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { helper } from '../shared/helper';

export const content = readFileSync(join('a', 'b'), 'utf8');
