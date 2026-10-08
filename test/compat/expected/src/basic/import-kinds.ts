// React
import React      from 'react';
import {useState} from 'react';
import type {FC}  from 'react';

// Node
import * as os        from 'os';
import {readFileSync} from 'fs';
import type {Stats}   from 'fs';

// External
import {
    applyPatch,
    createPatch
}               from 'diff';

// Shared
import {helper} from '@shared/helper';

// Misc
import './polyfill';

export const Component: FC = () => useState(React.version);
export const patch = [applyPatch, createPatch];
export const platform = os.platform();
export const read = (file: string, stats?: Stats): string => helper(readFileSync(file, 'utf8')) + String(stats);
