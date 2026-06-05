#!/usr/bin/env node
// Other
import { execSync }      from 'child_process';
import {
    existsSync,
    readFileSync
}                        from 'fs';
import {
    resolve,
    dirname
}                        from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const envPath = resolve(root, '.env');
if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
        const match = line.match(/^([^#=]+)=(.+)$/);
        if (match) process.env[match[1].trim()] = match[2].trim();
    }
}

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8'));
const vsix = resolve(root, `tidyjs-${pkg.version}.vsix`);

execSync('node scripts/esbuild.mjs --production', { cwd: root, stdio: 'inherit' });
execSync('vsce package', { cwd: root, stdio: 'inherit' });

if (!existsSync(vsix)) {
    console.error(`File ${vsix} not found after packaging.`);
    process.exit(1);
}

console.log(`Built TidyJS v${pkg.version}: ${vsix}`);

execSync(`open -R "${vsix}"`, { cwd: root, stdio: 'inherit' });

const driveFolder = process.env.DRIVE_FOLDER_URL;
if (driveFolder) {
    console.log('Opening Google Drive folder — drop the .vsix there.');
    execSync(`open "${driveFolder}"`, { cwd: root, stdio: 'inherit' });
} else {
    console.log('Set DRIVE_FOLDER_URL in .env to auto-open the target Drive folder.');
}
