// Node
import {readFileSync} from 'fs';
import {join}         from 'path';

export const content = readFileSync(join('a', 'b'), 'utf8');
