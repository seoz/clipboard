/**
 * Sync engine. Phase 3: push only — local changes are uploaded, nothing is
 * pulled back down yet.
 *
 * Everything here runs against ciphertext. The server cannot read, compare or
 * index entry contents, so any operation that needs to understand a snippet
 * happens on the client after decryption.
 */

import { doc, collection, writeBatch } from 'firebase/firestore/lite';
import { getDb } from './firebase.js';
import { currentUser } from './auth.js';
import { getCachedKey } from './keycache.js';
import { encryptJson } from './crypto.js';
import { loadState } from './store.js';
import { getPending, clearPending, recordFailure, clearBackoff, inBackoff } from './queue.js';

/** Record schema version for a Firestore entry document. */
const ENTRY_VERSION = 1;

/** Firestore caps a batch at 500 writes. */
const BATCH_LIMIT = 500;

export const SyncOutcome = {
    PUSHED: 'pushed',
    NOTHING_TO_DO: 'nothing-to-do',
    SIGNED_OUT: 'signed-out',
    LOCKED: 'locked',
    BACKOFF: 'backoff',
    FAILED: 'failed'
};

/**
 * Shape an entry for storage. Only `text` and `frequency` are encrypted.
 *
 * order/updatedAt/deletedAt stay plaintext because merge and ordering have to
 * work on records the client cannot yet decrypt — a device that is signed in
 * but locked still needs to hold a coherent view. The accepted cost is that
 * the server learns entry count, timestamps and relative order.
 */
async function toRemote(entry, key) {
    const { iv, ct } = await encryptJson(
        key,
        { text: entry.text, frequency: entry.frequency },
        entry.id                      // AAD binds ciphertext to this record
    );

    return {
        v: ENTRY_VERSION,
        ct,
        iv,
        order: entry.order,
        createdAt: entry.timestamp,
        updatedAt: entry.updatedAt,
        deletedAt: entry.deletedAt ?? null
    };
}

/**
 * Push queued entries. Safe to call concurrently with local edits: only the
 * ids that were actually written are dequeued.
 */
export async function push() {
    if (await inBackoff()) return { outcome: SyncOutcome.BACKOFF };

    const user = await currentUser();
    if (!user) return { outcome: SyncOutcome.SIGNED_OUT };

    const key = await getCachedKey(user.uid);
    if (!key) return { outcome: SyncOutcome.LOCKED };

    const pendingIds = await getPending();
    if (pendingIds.length === 0) return { outcome: SyncOutcome.NOTHING_TO_DO };

    const { texts } = await loadState();
    const byId = new Map(texts.map(entry => [entry.id, entry]));

    // An id can be queued for an entry that no longer exists locally (imported
    // then wiped, say). Drop those rather than failing the whole flush.
    const pushable = pendingIds.filter(id => byId.has(id));
    const orphaned = pendingIds.filter(id => !byId.has(id));

    const db = getDb();
    const entriesRef = collection(db, 'users', user.uid, 'entries');
    const written = [];

    try {
        for (let i = 0; i < pushable.length; i += BATCH_LIMIT) {
            const slice = pushable.slice(i, i + BATCH_LIMIT);
            const batch = writeBatch(db);

            for (const id of slice) {
                batch.set(doc(entriesRef, id), await toRemote(byId.get(id), key));
            }

            await batch.commit();
            written.push(...slice);
        }
    } catch (error) {
        // Dequeue whatever committed before the failure, so a partial push
        // isn't repeated wholesale on the next attempt.
        if (written.length) await clearPending(written);

        const fatal = /permission-denied|unauthenticated/.test(error?.code ?? '');
        if (fatal) {
            // Not a blip: the session or the rules are wrong. Retrying on a
            // timer would hammer the backend and never succeed.
            return { outcome: SyncOutcome.FAILED, fatal: true, error };
        }

        const retryInMinutes = await recordFailure();
        return { outcome: SyncOutcome.FAILED, fatal: false, retryInMinutes, error };
    }

    await clearPending([...written, ...orphaned]);
    await clearBackoff();

    return { outcome: SyncOutcome.PUSHED, count: written.length };
}
