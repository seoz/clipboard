/**
 * chrome.storage.local access and the schema-version gate.
 *
 * Every read and write of persisted state goes through here so that later
 * phases have exactly one place to hang the sync dirty-queue off.
 * DOM-free: imported by the popup and the background service worker alike.
 */

import { migrateToV2, normalizeEntry, SCHEMA_VERSION } from './model.js';

const KEYS = ['savedTexts', 'sortMode', 'schemaVersion'];

/**
 * Load persisted state, migrating it to the current schema exactly once.
 * The migrated array is written straight back, so a later load takes the
 * fast path and re-migration can't churn ids.
 */
export async function loadState() {
    let stored;
    try {
        stored = await chrome.storage.local.get(KEYS);
    } catch (error) {
        console.error('Error loading state:', error);
        return { texts: [], sortMode: 'manual' };
    }

    const sortMode = stored.sortMode === 'frequency' ? 'frequency' : 'manual';
    const raw = Array.isArray(stored.savedTexts) ? stored.savedTexts : [];

    if (stored.schemaVersion === SCHEMA_VERSION) {
        // Still normalize: an entry could predate a field added within v2.
        return { texts: raw.map((item, i) => normalizeEntry(item, i)).filter(Boolean), sortMode };
    }

    const texts = migrateToV2(raw);
    await saveState({ texts, sortMode });
    return { texts, sortMode };
}

export async function saveState({ texts, sortMode }) {
    try {
        await chrome.storage.local.set({
            savedTexts: texts,
            sortMode,
            schemaVersion: SCHEMA_VERSION
        });
    } catch (error) {
        console.error('Error saving state:', error);
    }
}
