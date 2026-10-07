import { thing } from 'not-installed-package';
import fallback from './does-not-exist';
import { createPatch } from 'diff';
import './missing-side-effect';

export const out = [thing, createPatch];
