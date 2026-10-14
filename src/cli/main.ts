import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { EXIT_ERROR, runCli, runWorker } from './cli';
import { ESLINT_HOST_FLAG, runEslintHost } from './eslint-host';
import { WORKER_FLAG } from './parallel';
import { enableRawTransfer } from '../utils/oxc-parse';

declare const TIDYJS_PACKAGE: { name: string; version: string; contributes: unknown };

const selfScript = process.argv[1] ? fs.realpathSync(process.argv[1]) : fileURLToPath(import.meta.url);
const mode = process.argv[2];

enableRawTransfer();

if (mode === ESLINT_HOST_FLAG) {
    runEslintHost();
} else if (mode === WORKER_FLAG) {
    runWorker();
} else {
    runCli(process.argv.slice(2), {
        cwd: process.cwd(),
        stdout: (text) => process.stdout.write(text),
        stderr: (text) => process.stderr.write(text),
        packageJson: TIDYJS_PACKAGE,
        fallbackModulesDir: path.dirname(selfScript),
        selfScript,
    }).then(
        (code) => {
            process.exitCode = code;
        },
        (error: unknown) => {
            process.stderr.write(`error  ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
            process.exitCode = EXIT_ERROR;
        }
    );
}
