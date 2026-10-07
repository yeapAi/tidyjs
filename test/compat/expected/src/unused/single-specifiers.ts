// Node
import * as os        from 'os';
import {readFileSync} from 'fs';

export const data = readFileSync('data.txt', 'utf8');
