import type { SettingsReader } from './config';

export type SettingsTree = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(cloneValue);
    }
    if (isPlainObject(value)) {
        return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, cloneValue(inner)]));
    }
    return value;
}

function mergeInto(target: SettingsTree, source: SettingsTree): void {
    for (const [key, value] of Object.entries(source)) {
        const existing = target[key];
        if (isPlainObject(existing) && isPlainObject(value)) {
            mergeInto(existing, value);
        } else {
            target[key] = cloneValue(value);
        }
    }
}

function setDotted(tree: SettingsTree, dottedKey: string, value: unknown): void {
    const segments = dottedKey.split('.');
    let node = tree;
    for (const segment of segments.slice(0, -1)) {
        const next = node[segment];
        if (!isPlainObject(next)) {
            node[segment] = {};
        }
        node = node[segment] as SettingsTree;
    }
    const last = segments[segments.length - 1];
    const existing = node[last];
    if (isPlainObject(existing) && isPlainObject(value)) {
        mergeInto(existing, value);
    } else {
        node[last] = cloneValue(value);
    }
}

export function settingsTreeFromFlatEntries(entries: Record<string, unknown>): SettingsTree {
    const tree: SettingsTree = {};
    for (const [key, value] of Object.entries(entries)) {
        setDotted(tree, key, value);
    }
    return tree;
}

export function mergeSettingsTrees(...layers: SettingsTree[]): SettingsTree {
    const merged: SettingsTree = {};
    for (const layer of layers) {
        mergeInto(merged, layer);
    }
    return merged;
}

export function getSettingsSection(tree: SettingsTree, section: string): SettingsTree {
    let node: unknown = tree;
    for (const segment of section.split('.')) {
        node = isPlainObject(node) ? node[segment] : undefined;
    }
    return isPlainObject(node) ? node : {};
}

export function createSettingsReader(sectionTree: SettingsTree): SettingsReader {
    const lookup = (key: string): unknown => {
        let node: unknown = sectionTree;
        for (const segment of key.split('.')) {
            node = isPlainObject(node) ? node[segment] : undefined;
        }
        return node;
    };

    return {
        has: (key) => lookup(key) !== undefined,
        get: <T>(key: string): T | undefined => {
            const value = lookup(key);
            return value === undefined ? undefined : cloneValue(value) as T;
        },
    };
}

export function contributedDefaults(packageJson: unknown): Record<string, unknown> {
    const properties = (packageJson as {
        contributes?: { configuration?: { properties?: Record<string, { default?: unknown }> } };
    })?.contributes?.configuration?.properties ?? {};

    const defaults: Record<string, unknown> = {};
    for (const [key, schema] of Object.entries(properties)) {
        if (schema && 'default' in schema) {
            defaults[key] = schema.default;
        }
    }
    return defaults;
}
