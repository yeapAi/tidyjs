// Node
import {readFileSync} from 'fs';

// External
import {createPatch} from 'diff';

export const Diff = () => <pre>{createPatch('a', readFileSync('b', 'utf8'), 'c')}</pre>;
