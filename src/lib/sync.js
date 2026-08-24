/**
 * Sync engine. Phase 3: push only — local changes are uploaded, nothing is
 * pulled back down yet.
 *
 * Everything here runs against ciphertext. The server cannot read, compare or
 * index entry contents, so any operation that needs to understand a snippet
 * happens on the client after decryption.
 */

import {
    doc, collection, getDocs, query, where, orderBy, writeBatch, deleteDoc
} from 'firebase/firestore/lite';
import { getDb } from './firebase.js';
import { currentUser } from './auth.js';
import { getCachedKey, cacheKey, lockNow } from './keycache.js';
import { encryptJson, decryptJson, createKdfSetup } from './crypto.js';
import { rotateAccount, deleteAccount } from './account.js';
import { loadState, saveState } from './store.js';
import { isLive, dedupKey, ORDER_STEP } from './model.js';
import {
    getPending, clearPending, recordFailure, clearBackoff, inBackoff,
    getLastPullAt, setLastPullAt, clearLastError
} from './queue.js';

/** Record schema version for a Firestore entry document. */
const ENTRY_VERSION = 1;

/** Firestore caps a batch at 500 writes. */
const BATCH_LIMIT = 500;

export const SyncOutcome = {
    PUSHED: 'pushed',
    PULLED: 'pulled',
    MERGE_READY: 'merge-ready',
    MERGED: 'merged',
    NEEDS_FIRST_MERGE: 'needs-first-merge',
    NOTHING_TO_DO: 'nothing-to-do',
    SIGNED_OUT: 'signed-out',
    LOCKED: 'locked',
    BACKOFF: 'backoff',
    WRONG_PASSPHRASE: 'wrong-passphrase',
    ROTATED: 'rotated',
    FAILED: 'failed'
};

/**
 * A device more than this far out of date does a full reconcile instead of a
 * delta pull. Bounds a real race: tombstones are garbage-collected after
 * GC_AFTER_MS, and a device offline longer than that could otherwise miss a
 * delete entirely and resurrect the entry it never heard was removed.
 */
const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** Tombstones older than this are safe to hard-delete: see STALE_AFTER_MS. */
const GC_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** Clock skew tolerance on the delta-pull cursor. A false re-fetch is harmless. */
const PULL_SKEW_MS = 5000;

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
    // then wiped, say) — drop those rather than failing the whole flush. An
    // undecryptable placeholder must never be pushed at all: it holds no real
    // content (`text: null`), and encrypting that over a document would
    // destroy the real content that other devices can read fine. This should
    // never happen through the UI (copy/edit/delete are all refused on these
    // rows), but the check belongs here too — it's the one place that can
    // guarantee it regardless of how an id ended up queued.
    const pushable = pendingIds.filter(id => byId.has(id) && !byId.get(id).undecryptable);
    const orphaned = pendingIds.filter(id => !byId.has(id) || byId.get(id).undecryptable);

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


/**
 * Read every remote entry back, decrypt it, and compare against local state.
 *
 * Read-only: nothing is written, merged or repaired. Its job is to answer
 * "is what the server holds actually my data?" — which the Firestore console
 * cannot, because everything there is ciphertext.
 *
 * This is also a live test of the decrypt path, so a key or AAD mismatch shows
 * up here as a decryption failure rather than as silent data loss later.
 */
export async function verify() {
    const user = await currentUser();
    if (!user) return { outcome: SyncOutcome.SIGNED_OUT };

    const key = await getCachedKey(user.uid);
    if (!key) return { outcome: SyncOutcome.LOCKED };

    const snapshot = await getDocs(collection(getDb(), 'users', user.uid, 'entries'));
    const { texts } = await loadState();
    const localById = new Map(texts.map(entry => [entry.id, entry]));

    const report = {
        outcome: 'verified',
        localLive: texts.filter(e => e.deletedAt == null).length,
        localTombstoned: texts.filter(e => e.deletedAt != null).length,
        remoteTotal: snapshot.size,
        remoteLive: 0,
        remoteTombstoned: 0,
        matched: 0,
        notUploaded: [],      // local entries with no remote counterpart
        onlyOnServer: [],     // remote entries this device has never seen
        contentMismatch: [],  // both sides exist but disagree
        undecryptable: [],    // wrong key, wrong AAD, or corrupted ciphertext
        pending: (await getPending()).length
    };

    const seen = new Set();

    for (const docSnap of snapshot.docs) {
        const remote = docSnap.data();
        seen.add(docSnap.id);
        if (remote.deletedAt == null) report.remoteLive++; else report.remoteTombstoned++;

        let payload;
        try {
            payload = await decryptJson(key, remote, docSnap.id);
        } catch {
            report.undecryptable.push(docSnap.id);
            continue;
        }

        const local = localById.get(docSnap.id);
        if (!local) {
            report.onlyOnServer.push({ id: docSnap.id, preview: preview(payload.text) });
            continue;
        }

        const sameText = payload.text === local.text;
        const sameDeleted = (remote.deletedAt ?? null) === (local.deletedAt ?? null);

        if (sameText && sameDeleted) {
            report.matched++;
        } else {
            report.contentMismatch.push({
                id: docSnap.id,
                local: preview(local.text),
                remote: preview(payload.text),
                localFrequency: local.frequency,
                remoteFrequency: payload.frequency,
                localDeleted: local.deletedAt != null,
                remoteDeleted: remote.deletedAt != null
            });
        }
    }

    for (const entry of texts) {
        if (!seen.has(entry.id)) {
            report.notUploaded.push({ id: entry.id, preview: preview(entry.text) });
        }
    }

    /*
     * Two distinct questions, deliberately not conflated:
     *
     * fullyUploaded — is everything on this device faithfully on the server?
     *   This is the only thing push-only sync can promise, and the only one
     *   the user can act on today.
     *
     * awaitingPull  — does the server hold entries this device has never seen?
     *   Expected, not a fault: another device pushed them and pull isn't built
     *   yet. Reporting it as "out of sync" would be alarming and unactionable.
     */
    report.fullyUploaded = report.notUploaded.length === 0
        && report.contentMismatch.length === 0
        && report.undecryptable.length === 0;

    report.awaitingPull = report.onlyOnServer.length;

    return report;
}

/** Enough to recognise an entry, without dumping secrets into a log. */
function preview(text) {
    const oneLine = String(text).replace(/\s+/g, ' ').trim();
    return oneLine.length > 32 ? oneLine.slice(0, 32) + '…' : oneLine;
}


// ---- pull + merge --------------------------------------------------------

/** Decrypt one remote document into the shape a local entry uses. */
async function toLocal(id, remote, key) {
    const payload = await decryptJson(key, remote, id);
    return {
        id,
        text: payload.text,
        frequency: payload.frequency,
        timestamp: remote.createdAt,
        updatedAt: remote.updatedAt,
        order: remote.order,
        deletedAt: remote.deletedAt ?? null
    };
}

/**
 * Build a first-merge plan without writing anything.
 *
 * Runs once per device, the first time it has both a decryption key and a
 * server to talk to. Fully client-side and read-only: the server holds
 * ciphertext and cannot compare, dedup, or index by content, so there is
 * nothing for it to help with, and nothing here is safe to apply without the
 * caller showing it to the user first — this is the one merge step that can
 * silently combine two entries a user meant to keep separate.
 *
 * Any decrypt failure aborts the whole plan rather than skipping the entry it
 * came from: a key that can't read *something* is probably the wrong key, and
 * partially merging under a wrong key is worse than refusing outright.
 */
export async function previewFirstMerge() {
    const user = await currentUser();
    if (!user) return { outcome: SyncOutcome.SIGNED_OUT };

    const key = await getCachedKey(user.uid);
    if (!key) return { outcome: SyncOutcome.LOCKED };

    const snapshot = await getDocs(collection(getDb(), 'users', user.uid, 'entries'));
    const { texts: localTexts, sortMode } = await loadState();

    const remoteEntries = [];
    for (const docSnap of snapshot.docs) {
        try {
            remoteEntries.push(await toLocal(docSnap.id, docSnap.data(), key));
        } catch {
            return { outcome: SyncOutcome.WRONG_PASSPHRASE };
        }
    }

    // Dedup only against live remote entries — fusing into something already
    // deleted would resurrect it under a false pretense of being "the same".
    const remoteByDedup = new Map(
        remoteEntries.filter(isLive).map(entry => [dedupKey(entry), entry]));

    const fused = [];
    const localOnly = [];
    const claimedRemoteIds = new Set();

    // Local tombstones carry nothing worth preserving into the merge: if the
    // same text also exists remotely it will arrive as its own (live) entry,
    // and if it doesn't, there is nothing to converge on.
    for (const local of localTexts.filter(isLive)) {
        const match = remoteByDedup.get(dedupKey(local));
        if (!match) {
            localOnly.push(local);
            continue;
        }
        claimedRemoteIds.add(match.id);
        fused.push({
            id: match.id,                              // remote id wins: both
            text: match.text,                           // devices converge on
            frequency: Math.max(local.frequency, match.frequency),
            timestamp: Math.min(local.timestamp, match.timestamp),
            updatedAt: Date.now(),
            order: match.order,
            deletedAt: null
        });
    }

    const remoteOnly = remoteEntries.filter(entry => !claimedRemoteIds.has(entry.id));

    const maxRemoteOrder = remoteEntries.reduce((max, e) => Math.max(max, e.order), 0);
    localOnly.forEach((entry, index) => {
        // Order and clock are reset: an entry that only existed on this device
        // is, from the server's perspective, being created now.
        entry.order = maxRemoteOrder + (index + 1) * ORDER_STEP;
        entry.updatedAt = Date.now();
    });

    const merged = [...fused, ...localOnly, ...remoteOnly];

    // remoteOnly is already correct on the server; only entries whose id or
    // content changed on this device need to be pushed.
    const dirtyIds = [...fused, ...localOnly].map(entry => entry.id);

    return {
        outcome: SyncOutcome.MERGE_READY,
        plan: {
            localCount: localTexts.filter(isLive).length,
            remoteCount: remoteEntries.filter(isLive).length,
            duplicates: fused.length,
            resultCount: merged.filter(isLive).length,
            merged,
            sortMode,
            dirtyIds
        }
    };
}

/** Commit a plan from previewFirstMerge(). The user has already seen it. */
export async function applyFirstMerge(plan) {
    await saveState({ texts: plan.merged, sortMode: plan.sortMode, dirtyIds: plan.dirtyIds });

    // An empty merge (brand-new account, nothing local) still has to mark this
    // device as merged, or pull() would offer the same empty merge forever.
    const maxUpdatedAt = plan.merged.reduce((max, e) => Math.max(max, e.updatedAt), 0);
    await setLastPullAt(maxUpdatedAt || Date.now());

    return { outcome: SyncOutcome.MERGED, count: plan.merged.length };
}

/**
 * Apply a batch of already-decrypted remote documents to local state via
 * last-write-wins, keyed by id. Shared by the delta pull and the stale-device
 * full reconcile below — they differ only in which documents they fetch.
 */
async function mergeRemoteDocs(docs, key) {
    const { texts, sortMode } = await loadState();
    const byId = new Map(texts.map(entry => [entry.id, entry]));

    let applied = 0;
    let maxSeen = 0;
    let dirty = false;
    const decryptFailures = [];

    for (const docSnap of docs) {
        const remote = docSnap.data();
        const local = byId.get(docSnap.id);

        // Local is strictly newer: it will reach the server on its own via
        // push(), so pulling the older remote value here would just be undone
        // a moment later. Skip rather than clobber — and this counts as fully
        // resolved, so the cursor is free to move past it.
        if (local && local.updatedAt > remote.updatedAt) {
            maxSeen = Math.max(maxSeen, remote.updatedAt);
            continue;
        }

        let incoming;
        try {
            incoming = await toLocal(docSnap.id, remote, key);
        } catch {
            decryptFailures.push(docSnap.id);
            // Deliberately do NOT advance maxSeen past this document. The
            // delta query is `updatedAt > cursor`, so moving the cursor past
            // an entry we could not read would drop it from every future
            // pull too — permanently, if the failure was transient (a stale
            // cached key mid-passphrase-rotation, say). Leaving the cursor
            // behind costs one extra re-fetch per pull until it resolves,
            // which is cheap.
            if (!local) {
                // Never seen locally at all: without a placeholder the entry
                // is invisible, which is a worse failure mode than a visibly
                // broken row. Only for a brand-new id — an existing local
                // entry that fails to decrypt keeps showing its last-known-
                // good content instead of being replaced with a warning.
                const placeholder = {
                    id: docSnap.id, text: null, frequency: 0,
                    timestamp: remote.createdAt, updatedAt: remote.updatedAt,
                    order: remote.order, deletedAt: remote.deletedAt ?? null,
                    undecryptable: true
                };
                texts.push(placeholder);
                byId.set(docSnap.id, placeholder);
                dirty = true;
            }
            continue;
        }

        maxSeen = Math.max(maxSeen, remote.updatedAt);

        if (!local) {
            texts.push(incoming);
            byId.set(docSnap.id, incoming);
            applied++;
            dirty = true;
            continue;
        }

        // A genuine tie (same millisecond, different content) is vanishingly
        // rare, but has to resolve identically on every device or they'd
        // diverge. Comparing the decrypted text is deterministic and doesn't
        // depend on which side happens to run the comparison.
        const remoteWins = remote.updatedAt > local.updatedAt
            || (remote.updatedAt === local.updatedAt && incoming.text > local.text);
        if (!remoteWins) continue;

        // A successful decrypt clears any earlier placeholder for this id.
        Object.assign(local, incoming, { undecryptable: false });
        applied++;
        dirty = true;
    }

    if (dirty) {
        // These came FROM the server: saving them locally must not re-queue
        // them for a push, or every pull would trigger a needless echo.
        await saveState({ texts, sortMode });
    }

    return { applied, maxSeen, decryptFailures };
}

/**
 * Bring in changes from other devices.
 *
 * A device that has never merged (getLastPullAt() === 0) is told to run the
 * first-merge flow instead: delta-pulling before that has happened would pull
 * entries in that risk being byte-identical duplicates of local ones that
 * were never deduped.
 */
export async function pull() {
    const user = await currentUser();
    if (!user) return { outcome: SyncOutcome.SIGNED_OUT };

    const key = await getCachedKey(user.uid);
    if (!key) return { outcome: SyncOutcome.LOCKED };

    const lastPullAt = await getLastPullAt();
    if (lastPullAt === 0) return { outcome: SyncOutcome.NEEDS_FIRST_MERGE };

    const entriesRef = collection(getDb(), 'users', user.uid, 'entries');
    const stale = Date.now() - lastPullAt > STALE_AFTER_MS;

    // A delta query is a handful of reads; going stale means falling back to
    // a full read so a long-offline device can't miss a delete that has
    // already been garbage-collected on the server.
    const snapshot = stale
        ? await getDocs(query(entriesRef, orderBy('updatedAt')))
        : await getDocs(query(
              entriesRef,
              where('updatedAt', '>', Math.max(0, lastPullAt - PULL_SKEW_MS)),
              orderBy('updatedAt')));

    if (snapshot.empty) {
        if (stale) await setLastPullAt(Date.now());   // nothing to catch up on
        return { outcome: SyncOutcome.NOTHING_TO_DO };
    }

    const { applied, maxSeen, decryptFailures } = await mergeRemoteDocs(snapshot.docs, key);
    await setLastPullAt(Math.max(lastPullAt, maxSeen));

    return { outcome: SyncOutcome.PULLED, applied, stale, decryptFailures };
}

/**
 * Hard-delete tombstones old enough that every device has almost certainly
 * seen them, and drop the matching local rows. Meant for a daily alarm, not
 * the interactive push/pull path.
 */
export async function gcTombstones() {
    const user = await currentUser();
    if (!user) return { outcome: SyncOutcome.SIGNED_OUT };

    const cutoff = Date.now() - GC_AFTER_MS;
    const entriesRef = collection(getDb(), 'users', user.uid, 'entries');

    // Firestore has no native "not null and less than" compound filter here
    // without a composite index, and the collection is small enough per user
    // that filtering client-side after a single read is simpler than adding one.
    const snapshot = await getDocs(query(entriesRef, orderBy('updatedAt')));
    const toDelete = snapshot.docs.filter(docSnap => {
        const { deletedAt } = docSnap.data();
        return typeof deletedAt === 'number' && deletedAt < cutoff;
    });

    for (const docSnap of toDelete) {
        await deleteDoc(doc(entriesRef, docSnap.id));
    }

    if (toDelete.length) {
        const { texts, sortMode } = await loadState();
        const removedIds = new Set(toDelete.map(d => d.id));
        await saveState({
            texts: texts.filter(entry => !removedIds.has(entry.id)),
            sortMode
        });
    }

    return { outcome: 'gc-complete', removed: toDelete.length };
}

// ---- passphrase rotation ---------------------------------------------------

/**
 * Change the passphrase: derive a new key, rotate the account's kdf/verifier,
 * and re-encrypt every entry under the new key.
 *
 * Local storage is already plaintext — only the server copy is encrypted —
 * so "re-encryption" here just means bumping every entry's clock and letting
 * the normal push pipeline pick them up under whatever key is currently
 * cached, which by the time push() runs is the new one. That reuse matters:
 * it's the same batching, backoff and undecryptable-placeholder guard as
 * every other push, rather than a second, less-tested code path for what is
 * otherwise the highest-blast-radius operation in the app.
 *
 * Requires the device to already be unlocked. Not because the old key is
 * needed — it isn't — but because unlocked is the only proof available that
 * whoever is doing this actually knows the current passphrase, rather than
 * merely being signed into the Google account.
 *
 * @param existingAccount the current users/{uid} doc, from getAccount()
 * @param lockPolicy the auto-lock policy to re-cache the new key under
 */
export async function rotatePassphrase(newPassphrase, existingAccount, lockPolicy) {
    const user = await currentUser();
    if (!user) return { outcome: SyncOutcome.SIGNED_OUT };

    const oldKey = await getCachedKey(user.uid);
    if (!oldKey) return { outcome: SyncOutcome.LOCKED };

    const { key: newKey, kdf, verifier } = await createKdfSetup(newPassphrase);

    // Account doc first: if this succeeds but the entry re-push below fails
    // partway (network drop, tab closed), the device still holds the correct
    // new key and can simply be pushed again later — nothing is stuck between
    // two inconsistent halves of a single operation.
    await rotateAccount(user.uid, { kdf, verifier }, existingAccount);
    await cacheKey(newKey, user.uid, lockPolicy);

    const { texts, sortMode } = await loadState();
    const now = Date.now();
    const dirtyIds = [];

    for (const entry of texts) {
        // A placeholder holds no real content on this device — see the same
        // guard in push(). Its ciphertext on the server is already under
        // whatever key produced it; this device re-encrypting "null" over it
        // would destroy content another device can still read.
        if (entry.undecryptable) continue;
        entry.updatedAt = now;
        dirtyIds.push(entry.id);
    }

    await saveState({ texts, sortMode, dirtyIds });

    const pushResult = await push();

    return { outcome: SyncOutcome.ROTATED, count: dirtyIds.length, pushResult };
}


// ---- danger zone -----------------------------------------------------------

/**
 * Delete every entry from the server and forget the account's kdf/verifier.
 *
 * Deliberately does NOT touch local storage: this removes the cloud copy,
 * not the user's snippets. It also does not sign the user out of Google —
 * only sync/encryption is being reset, not the account itself. Any other
 * device still holding the old key simply stops being able to sync (its next
 * push will hit a missing account doc) until someone sets a new passphrase.
 */
export async function deleteAllCloudData() {
    const user = await currentUser();
    if (!user) return { outcome: SyncOutcome.SIGNED_OUT };

    const entriesRef = collection(getDb(), 'users', user.uid, 'entries');
    const snapshot = await getDocs(entriesRef);
    const now = Date.now();

    // The security rules only permit a hard delete of an entry that is
    // already tombstoned — the same path every individual delete in the app
    // goes through, so nothing here bypasses it. A live entry is tombstoned
    // first, in its own batch, before the second pass removes it for real.
    for (let i = 0; i < snapshot.docs.length; i += BATCH_LIMIT) {
        const live = snapshot.docs.slice(i, i + BATCH_LIMIT)
            .filter(docSnap => docSnap.data().deletedAt == null);
        if (live.length === 0) continue;

        const batch = writeBatch(getDb());
        live.forEach(docSnap => {
            const data = docSnap.data();
            batch.set(doc(entriesRef, docSnap.id), {
                ...data,
                deletedAt: now,
                updatedAt: Math.max(now, data.updatedAt + 1)
            });
        });
        await batch.commit();
    }

    for (let i = 0; i < snapshot.docs.length; i += BATCH_LIMIT) {
        const batch = writeBatch(getDb());
        snapshot.docs.slice(i, i + BATCH_LIMIT).forEach(docSnap => {
            batch.delete(doc(entriesRef, docSnap.id));
        });
        await batch.commit();
    }

    await deleteAccount(user.uid);

    // Reset every piece of local sync bookkeeping, so a future "set passphrase"
    // starts clean rather than half-remembering a cursor or a stale error from
    // before the reset.
    await lockNow();
    await clearPending(await getPending());
    await clearBackoff();
    await clearLastError();
    await setLastPullAt(0);

    return { outcome: 'deleted', count: snapshot.docs.length };
}
