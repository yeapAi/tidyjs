import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { FileRunner } from '../../src/cli/runner';
import { createCliWorkspace } from '../../src/cli/workspace';

const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));

describe('FileRunner', () => {
    let root: string;

    beforeEach(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tidyjs-runner-')));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    test('resolves the configuration once per directory', async () => {
        fs.writeFileSync(path.join(root, 'tidyjs.json'), JSON.stringify({ format: { indent: 2 } }));
        fs.mkdirSync(path.join(root, 'src'));
        fs.writeFileSync(path.join(root, 'src/a.ts'), "import { a } from 'a';\n");
        fs.writeFileSync(path.join(root, 'src/b.ts'), "import { b } from 'b';\n");
        const workspace = createCliWorkspace(root, packageJson);
        const getSource = jest.spyOn(workspace.fileSources, 'getSource');
        const runner = new FileRunner(workspace, undefined, { mode: 'list', profile: 'editor', keepContents: false });

        const first = await runner.run(path.join(root, 'src/a.ts'));
        const callsForFirstFile = getSource.mock.calls.length;
        const second = await runner.run(path.join(root, 'src/b.ts'));

        expect(getSource.mock.calls.length).toBe(callsForFirstFile);
        expect(first.configPath).toBe(path.join(root, 'tidyjs.json'));
        expect(second.configPath).toBe(path.join(root, 'tidyjs.json'));
        runner.dispose();
    });
});
