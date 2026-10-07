const { execFileSync } = require('child_process');
const path = require('path');

module.exports = function buildCli() {
    execFileSync(process.execPath, [path.join(__dirname, '../../scripts/esbuild.mjs')], {
        cwd: path.join(__dirname, '../..'),
        stdio: 'ignore',
    });
};
