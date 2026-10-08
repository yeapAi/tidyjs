import * as fs from 'fs';
import * as path from 'path';

import {
    contributedDefaults,
    createSettingsReader,
    getSettingsSection,
    mergeSettingsTrees,
    settingsTreeFromFlatEntries,
} from '../../src/core/settings';

const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));

function tidyjsReader(workspaceEntries: Record<string, unknown>) {
    const defaults = settingsTreeFromFlatEntries(contributedDefaults(packageJson));
    const merged = mergeSettingsTrees(defaults, settingsTreeFromFlatEntries(workspaceEntries));
    return createSettingsReader(getSettingsSection(merged, 'tidyjs'));
}

describe('VS Code-like settings reader', () => {
    test('exposes contributed defaults like WorkspaceConfiguration.has/get', () => {
        const reader = tidyjsReader({});

        expect(reader.has('format')).toBe(true);
        expect(reader.has('groups')).toBe(true);
        expect(reader.get('format.indent')).toBe(4);
        expect(reader.get('groups')).toEqual([{ name: 'Other', order: 0, default: true }]);
        expect(reader.get('pathResolution')).toEqual({ mode: false, preferredAliases: [], aliases: {} });
        expect(reader.has('unknownKey')).toBe(false);
    });

    test('merges dotted workspace keys into the section object', () => {
        const reader = tidyjsReader({ 'tidyjs.format.indent': 2, 'tidyjs.format.bracketSpacing': false });
        const format = reader.get<Record<string, unknown>>('format');

        expect(format?.indent).toBe(2);
        expect(format?.bracketSpacing).toBe(false);
        expect(format?.singleQuote).toBe(true);
    });

    test('merges object values deeply and replaces arrays', () => {
        const reader = tidyjsReader({
            'tidyjs.importOrder': { default: 7 },
            'tidyjs.groups': [{ name: 'Mine', default: true }],
        });

        expect(reader.get('importOrder')).toEqual({ sideEffect: 0, default: 7, named: 2, typeOnly: 3 });
        expect(reader.get('groups')).toEqual([{ name: 'Mine', default: true }]);
    });

    test('returns copies so callers cannot mutate the settings', () => {
        const reader = tidyjsReader({});
        const groups = reader.get<{ name: string }[]>('groups')!;
        groups[0].name = 'Changed';

        expect(reader.get<{ name: string }[]>('groups')![0].name).toBe('Other');
    });

    test('reads every contributed tidyjs property', () => {
        const defaults = contributedDefaults(packageJson);
        expect(Object.keys(defaults).every((key) => key.startsWith('tidyjs.'))).toBe(true);
        expect(defaults['tidyjs.format.sortSpecifiers']).toBe('length');
    });
});
