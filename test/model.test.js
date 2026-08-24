import { describe, it, expect } from 'vitest';
import {
    migrateToV2, normalizeEntry, dedupKey, newEntry,
    orderBetween, renumber, isValidId, ORDER_STEP
} from '../src/lib/model.js';

describe('migrateToV2', () => {
    it('accepts the v0 bare-string shape', () => {
        const [entry] = migrateToV2(['  hello  ']);
        expect(entry.text).toBe('hello');
        expect(entry.frequency).toBe(0);
        expect(entry.deletedAt).toBeNull();
        expect(isValidId(entry.id)).toBe(true);
    });

    it('accepts the v1 object shape and keeps its stats', () => {
        const [entry] = migrateToV2([{ text: 'hi', frequency: 7, timestamp: 123 }]);
        expect(entry.frequency).toBe(7);
        expect(entry.timestamp).toBe(123);
        expect(entry.updatedAt).toBe(123); // no clock yet, so seed it from creation
    });

    it('preserves array position as manual order', () => {
        const entries = migrateToV2(['a', 'b', 'c']);
        expect(entries.map(e => e.order)).toEqual([0, ORDER_STEP, 2 * ORDER_STEP]);
    });

    it('drops junk instead of throwing', () => {
        expect(migrateToV2(['ok', '', '   ', null, 42, {}, { text: 5 }])).toHaveLength(1);
        expect(migrateToV2(null)).toEqual([]);
    });

    it('gives every entry a distinct id', () => {
        const ids = migrateToV2(['a', 'a', 'a']).map(e => e.id);
        expect(new Set(ids).size).toBe(3);
    });

    it('keeps ids that are already valid, so re-import is idempotent', () => {
        const original = newEntry('x');
        const [round] = migrateToV2([JSON.parse(JSON.stringify(original))]);
        expect(round.id).toBe(original.id);
    });

    it('rejects an id that could break out of an HTML attribute', () => {
        const [entry] = migrateToV2([{ text: 'x', id: '" onclick="evil()' }]);
        expect(entry.id).not.toContain('"');
        expect(isValidId(entry.id)).toBe(true);
    });
});

describe('dedupKey', () => {
    it('ignores surrounding whitespace', () => {
        expect(dedupKey({ text: ' a ' })).toBe(dedupKey({ text: 'a' }));
    });

    it('treats different cases as different snippets', () => {
        expect(dedupKey({ text: 'Foo' })).not.toBe(dedupKey({ text: 'foo' }));
    });

    it('unifies Unicode compositions that look identical', () => {
        expect(dedupKey({ text: 'é' })).toBe(dedupKey({ text: 'é' }));
    });
});

describe('orderBetween', () => {
    it('lands between two neighbours', () => {
        const order = orderBetween(0, 1000);
        expect(order).toBeGreaterThan(0);
        expect(order).toBeLessThan(1000);
    });

    it('extends past either end', () => {
        expect(orderBetween(null, 0)).toBeLessThan(0);
        expect(orderBetween(0, null)).toBeGreaterThan(0);
    });

    it('reports an exhausted gap rather than colliding', () => {
        expect(orderBetween(1, 1 + Number.EPSILON)).toBeNull();
    });
});

describe('renumber', () => {
    it('rebuilds a sparse grid without changing the sequence', () => {
        const entries = [
            newEntry('c', { order: 5 }),
            newEntry('a', { order: 1 }),
            newEntry('b', { order: 3 })
        ];
        renumber(entries);
        const inOrder = entries.slice().sort((x, y) => x.order - y.order).map(e => e.text);
        expect(inOrder).toEqual(['a', 'b', 'c']);
        expect(entries.map(e => e.order).sort((x, y) => x - y))
            .toEqual([0, ORDER_STEP, 2 * ORDER_STEP]);
    });
});

describe('normalizeEntry', () => {
    it('backfills fields missing from a partial v2 entry', () => {
        const entry = normalizeEntry({ id: 'abcdefgh', text: 'x' }, 42);
        expect(entry.order).toBe(42);
        expect(entry.frequency).toBe(0);
        expect(entry.updatedAt).toBe(entry.timestamp);
    });

    it('preserves a tombstone', () => {
        expect(normalizeEntry({ text: 'x', deletedAt: 999 }).deletedAt).toBe(999);
    });
});

describe('undecryptable placeholders', () => {
    it('normalizeEntry preserves a placeholder rather than dropping it for having no text', () => {
        const placeholder = {
            id: 'abcdefgh', text: null, frequency: 0, timestamp: 1, updatedAt: 2,
            order: 0, deletedAt: null, undecryptable: true
        };
        const normalized = normalizeEntry(placeholder);
        expect(normalized).not.toBeNull();
        expect(normalized.text).toBeNull();
        expect(normalized.undecryptable).toBe(true);
    });

    it('survives a full migrateToV2 pass unchanged', () => {
        const placeholder = {
            id: 'abcdefgh', text: null, frequency: 0, timestamp: 1, updatedAt: 2,
            order: 0, deletedAt: null, undecryptable: true
        };
        const [migrated] = migrateToV2([placeholder]);
        expect(migrated.undecryptable).toBe(true);
        expect(migrated.text).toBeNull();
    });

    it('an ordinary entry with null text and no undecryptable flag is still rejected', () => {
        // Guards against a bug where any null-text object slips through —
        // only an explicit undecryptable:true bypasses the text requirement.
        expect(normalizeEntry({ id: 'abcdefgh', text: null })).toBeNull();
    });

    it('dedupKey never matches a placeholder against real content', () => {
        const placeholder = normalizeEntry({
            id: 'abcdefgh', undecryptable: true, updatedAt: 1, timestamp: 1
        });
        const real = newEntry('some real text');
        expect(dedupKey(placeholder)).not.toBe(dedupKey(real));
    });

    it('two different placeholders never collide on dedupKey', () => {
        const a = normalizeEntry({ id: 'aaaaaaaa', undecryptable: true });
        const b = normalizeEntry({ id: 'bbbbbbbb', undecryptable: true });
        expect(dedupKey(a)).not.toBe(dedupKey(b));
    });

    it('newEntry marks ordinary entries as decryptable', () => {
        expect(newEntry('hello').undecryptable).toBe(false);
    });
});
