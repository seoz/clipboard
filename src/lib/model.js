/**
 * Entry model and schema migration.
 *
 * DOM-free on purpose: the popup, the options page and the background
 * service worker all import this, and only the popup has a `document`.
 *
 * Schema v2 entry:
 *   id         stable uuid; identity across devices and across reorders
 *   text       the snippet itself
 *   frequency  copy count, used by the "Most Frequent" sort
 *   timestamp  creation time (kept under the v1 name to avoid churn)
 *   updatedAt  last-write-wins clock; bumped on every mutation
 *   order      manual position; sparse so a drag can land between neighbours
 *   deletedAt  tombstone, or null. Deletes are soft so that a device which
 *              was offline during the delete doesn't resurrect the entry.
 */

export const SCHEMA_VERSION = 2;

/** Gap between adjacent `order` values, leaving room to insert between them. */
export const ORDER_STEP = 1000;

/**
 * Ids are interpolated into HTML attributes and into CSS selectors, and an
 * imported backup file is untrusted input, so only this shape is accepted;
 * anything else gets a fresh uuid.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export function isValidId(id) {
    return typeof id === 'string' && ID_PATTERN.test(id);
}

export function newEntry(text, overrides = {}) {
    const now = Date.now();
    return {
        id: crypto.randomUUID(),
        text,
        frequency: 0,
        timestamp: now,
        updatedAt: now,
        order: now,
        deletedAt: null,
        ...overrides
    };
}

/**
 * Coerce one unknown value into a valid entry, or null if there's no usable
 * text in it. Accepts every shape we have ever written or imported:
 * a bare string (v0), a {text, frequency, timestamp} object (v1), or a v2 entry.
 */
export function normalizeEntry(raw, fallbackOrder = 0) {
    if (typeof raw === 'string') {
        const text = raw.trim();
        return text ? newEntry(text, { order: fallbackOrder }) : null;
    }

    if (!raw || typeof raw !== 'object' || typeof raw.text !== 'string') return null;

    const text = raw.text.trim();
    if (!text) return null;

    const now = Date.now();
    const timestamp = Number.isFinite(raw.timestamp) ? raw.timestamp : now;

    return {
        id: isValidId(raw.id) ? raw.id : crypto.randomUUID(),
        text,
        frequency: Number.isFinite(raw.frequency) ? raw.frequency : 0,
        timestamp,
        updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : timestamp,
        order: Number.isFinite(raw.order) ? raw.order : fallbackOrder,
        deletedAt: Number.isFinite(raw.deletedAt) ? raw.deletedAt : null
    };
}

/**
 * Migrate a stored/imported array of any vintage to v2.
 * Array position becomes `order`, which preserves the v0/v1 rule that
 * manual order *is* array order.
 */
export function migrateToV2(rawList) {
    if (!Array.isArray(rawList)) return [];
    return rawList
        .map((raw, index) => normalizeEntry(raw, index * ORDER_STEP))
        .filter(Boolean);
}

/**
 * Content identity, used to fuse duplicates when a device first merges with
 * the cloud. NFC because text pasted from different sources can differ in
 * Unicode composition while looking identical. Deliberately case- and
 * whitespace-sensitive: for a clipboard tool `Foo` and `foo` are different
 * snippets.
 */
export function dedupKey(entry) {
    return entry.text.trim().normalize('NFC');
}

export function isLive(entry) {
    return entry.deletedAt == null;
}

/** Mark an entry changed. Every mutation must go through this. */
export function touch(entry, changes = {}) {
    Object.assign(entry, changes);
    entry.updatedAt = Date.now();
    return entry;
}

/**
 * An `order` that places an entry between two neighbours, or at the end.
 * Returns null when the gap has closed and the caller must renumber.
 */
export function orderBetween(before, after) {
    if (before == null && after == null) return 0;
    if (before == null) return after - ORDER_STEP;
    if (after == null) return before + ORDER_STEP;
    const mid = (before + after) / 2;
    return mid > before && mid < after ? mid : null;
}

/** Rewrite `order` onto a clean sparse grid, preserving current sequence. */
export function renumber(entries) {
    entries
        .slice()
        .sort((a, b) => a.order - b.order)
        .forEach((entry, index) => { entry.order = index * ORDER_STEP; });
    return entries;
}
