// Node
import {join} from 'node:path';

// App
import {local} from '@app/feature/local';

// Shared
import {helper} from '@shared/helper';

export const view = join(helper(local), 'view');
