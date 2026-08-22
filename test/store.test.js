import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadState, saveState } from '../src/lib/store.js';
import { SCHEMA_VERSION } from '../src/lib/model.js';

/** Minimal stand-in for chrome.storage.local. */
function fakeStorage(initial = {}) {
    let data = { ...initial };
    return {
        data: () => data,
        api: {
            get: vi.fn(async keys => Object.fromEntries(
                keys.filter(k => k in data).map(k => [k, data[k]]))),
            set: vi.fn(async patch => { data = { ...data, ...patch }; })
        }
    };
}

let storage;
beforeEach(() => {
    storage = fakeStorage();
    globalThis.chrome = { storage: { local: storage.api } };
});

describe('loadState', () => {
    it('migrates legacy data once and writes it back', async () => {
        storage = fakeStorage({ savedTexts: ['a', { text: 'b', frequency: 2 }] });
        globalThis.chrome = { storage: { local: storage.api } };

        const { texts } = await loadState();

        expect(texts.map(t => t.text)).toEqual(['a', 'b']);
        expect(storage.data().schemaVersion).toBe(SCHEMA_VERSION);
        expect(storage.api.set).toHaveBeenCalledTimes(1);
    });

    it('does not re-migrate or churn ids on a second load', async () => {
        storage = fakeStorage({ savedTexts: ['a', 'b'] });
        globalThis.chrome = { storage: { local: storage.api } };

        const first = await loadState();
        storage.api.set.mockClear();
        const second = await loadState();

        expect(second.texts.map(t => t.id)).toEqual(first.texts.map(t => t.id));
        expect(storage.api.set).not.toHaveBeenCalled();
    });

    it('survives an empty profile', async () => {
        const { texts, sortMode } = await loadState();
        expect(texts).toEqual([]);
        expect(sortMode).toBe('manual');
    });

    it('falls back to manual for an unknown sort mode', async () => {
        storage = fakeStorage({ savedTexts: [], sortMode: 'nonsense', schemaVersion: SCHEMA_VERSION });
        globalThis.chrome = { storage: { local: storage.api } };
        expect((await loadState()).sortMode).toBe('manual');
    });

    it('returns empty state rather than throwing when storage fails', async () => {
        globalThis.chrome = { storage: { local: { get: async () => { throw new Error('boom'); } } } };
        vi.spyOn(console, 'error').mockImplementation(() => {});
        expect((await loadState()).texts).toEqual([]);
    });

    it('round-trips tombstones so a delete is not undone by a reload', async () => {
        await saveState({
            texts: [{ id: 'abcdefgh', text: 'x', frequency: 0, timestamp: 1, updatedAt: 2, order: 0, deletedAt: 5 }],
            sortMode: 'manual'
        });
        expect((await loadState()).texts[0].deletedAt).toBe(5);
    });
});
