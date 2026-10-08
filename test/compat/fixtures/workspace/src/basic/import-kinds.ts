import './polyfill';
import React, { useState, type FC } from 'react';
import { applyPatch, createPatch } from 'diff';
import * as os from 'os';
import type { Stats } from 'fs';
import { readFileSync } from 'fs';
import { helper } from '@shared/helper';

export const Component: FC = () => useState(React.version);
export const patch = [applyPatch, createPatch];
export const platform = os.platform();
export const read = (file: string, stats?: Stats): string => helper(readFileSync(file, 'utf8')) + String(stats);
