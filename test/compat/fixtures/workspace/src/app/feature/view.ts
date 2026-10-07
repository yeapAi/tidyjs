import { local } from './local';
import { helper } from '../../shared/helper';
import { join } from 'node:path';

export const view = join(helper(local), 'view');
