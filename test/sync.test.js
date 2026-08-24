import { describe, it, expect, beforeEach, vi } from 'vitest';

// Firestore, auth and the key cache are all stubbed: what's under test is the
// push decision logic — what gets uploaded, what gets dequeued, and how
// failures are classified.
const commits = [];
let commitError = null;
/** Commit index (0-based) that should throw, or null for "never". */
let failCommitAt = null;

/** Stand-in for what the server holds: id -> stored document. */
const remote = new Map();

/** Stand-in for the users/{uid} account doc, separate from `remote`. */
const accountDocs = new Map();

vi.mock('firebase/firestore/lite', () => ({
    // Two call shapes share this mock: doc(entriesRef, id) for an entry, and
    // doc(db, 'users', uid) for the account doc — disambiguated by arity,
    // matching how account.js and the entry paths actually call it.
    doc: (ref, ...rest) => rest.length === 1
        ? { id: rest[0], kind: 'entry' }
        : { id: rest[rest.length - 1], kind: 'account' },
    getDoc: async ref => {
        const data = accountDocs.get(ref.id);
        return { exists: () => data !== undefined, data: () => data };
    },
    setDoc: async (ref, data) => { accountDocs.set(ref.id, data); },
    collection: (_db, ...path) => ({ path: path.join('/'), __constraints: [] }),
    query: (ref, ...constraints) => ({ __constraints: constraints }),
    where: (field, op, value) => ({ type: 'where', field, op, value }),
    orderBy: field => ({ type: 'orderBy', field }),
    deleteDoc: async ref => { remote.delete(ref.id); },
    getDocs: async target => {
        let entries = [...remote.entries()];
        for (const c of target.__constraints ?? []) {
            if (c.type === 'where' && c.op === '>') {
                entries = entries.filter(([, data]) => data[c.field] > c.value);
            }
            if (c.type === 'orderBy') {
                entries = entries.slice().sort((a, b) => a[1][c.field] - b[1][c.field]);
            }
        }
        return {
            size: entries.length,
            empty: entries.length === 0,
            docs: entries.map(([id, data]) => ({ id, data: () => data }))
        };
    },
    writeBatch: () => {
        const writes = [];
        return {
            set: (ref, data) => writes.push({ id: ref.id, data }),
            commit: async () => {
                if (commitError) throw commitError;
                if (failCommitAt === commits.length) {
                    throw Object.assign(new Error('boom'), { code: 'unavailable' });
                }
                commits.push(writes);
            }
        };
    }
}));
vi.mock('../src/lib/firebase.js', () => ({ getDb: () => ({}), isConfigured: () => true }));

let user = { uid: 'uid-1' };
vi.mock('../src/lib/auth.js', () => ({ currentUser: async () => user }));

let key = 'fake-key';
vi.mock('../src/lib/keycache.js', () => ({
    getCachedKey: async () => key,
    cacheKey: async newKey => { key = newKey; }
}));

vi.mock('../src/lib/crypto.js', () => ({
    // The key is folded into the sealed payload (real AES-GCM obviously
    // wouldn't do this) purely so rotation tests can see which key a given
    // ciphertext was actually produced under.
    encryptJson: async (k, value, aad) => ({
        iv: 'IV', ct: Buffer.from(JSON.stringify({ key: k, value, aad })).toString('base64')
    }),
    // Mirrors the real contract: decrypting under a mismatched AAD throws,
    // which is what binds a ciphertext to its own entry id.
    decryptJson: async (_k, record, aad) => {
        const { value, aad: sealedAad } = JSON.parse(
            Buffer.from(record.ct, 'base64').toString());
        if (sealedAad !== aad) throw new Error('bad AAD');
        return value;
    },
    createKdfSetup: async passphrase => ({
        key: `key-for-${passphrase}`,
        kdf: { alg: 'PBKDF2-SHA256', iterations: 1000, salt: 'SALT-FOR-' + passphrase },
        verifier: { iv: 'IV', ct: 'VERIFIER-FOR-' + passphrase }
    })
}));

let texts = [];
const savedStateCalls = [];
vi.mock('../src/lib/store.js', () => ({
    loadState: async () => ({ texts, sortMode: 'manual' }),
    saveState: async ({ texts: t, sortMode, dirtyIds = [] }) => {
        texts = t;
        savedStateCalls.push({ sortMode, dirtyIds });
        // The real queue.js is not mocked (see `queue` below), so route
        // through it for real — push() reads getPending() directly, and
        // without this a caller like rotatePassphrase() that saves and then
        // immediately pushes would see an empty queue.
        if (dirtyIds.length) {
            const { markDirty } = await import('../src/lib/queue.js');
            await markDirty(dirtyIds);
        }
    }
}));

const {
    push, pull, verify, previewFirstMerge, applyFirstMerge, gcTombstones,
    rotatePassphrase, SyncOutcome
} = await import('../src/lib/sync.js');
const queue = await import('../src/lib/queue.js');

const entry = (id, over = {}) => ({
    id, text: `text ${id}`, frequency: 0,
    timestamp: 1000, updatedAt: 2000, order: 0, deletedAt: null,
    undecryptable: false, ...over
});

function fakeStorage() {
    let data = {};
    globalThis.chrome = { storage: { local: {
        get: async keys => Object.fromEntries(
            (Array.isArray(keys) ? keys : [keys]).filter(k => k in data).map(k => [k, data[k]])),
        set: async patch => { data = { ...data, ...patch }; },
        remove: async keys => {
            (Array.isArray(keys) ? keys : [keys]).forEach(k => { delete data[k]; });
        }
    } } };
}

beforeEach(() => {
    remote.clear();
    accountDocs.clear();
    commits.length = 0;
    commitError = null;
    failCommitAt = null;
    savedStateCalls.length = 0;
    user = { uid: 'uid-1' };
    key = 'fake-key';
    texts = [];
    fakeStorage();
});

describe('push preconditions', () => {
    it('does nothing when signed out', async () => {
        user = null;
        await queue.markDirty(['a']);
        expect((await push()).outcome).toBe(SyncOutcome.SIGNED_OUT);
        expect(await queue.getPending()).toEqual(['a']);   // still queued
    });

    it('does nothing while locked', async () => {
        key = null;
        await queue.markDirty(['a']);
        expect((await push()).outcome).toBe(SyncOutcome.LOCKED);
        expect(await queue.getPending()).toEqual(['a']);
    });

    it('does nothing when the queue is empty', async () => {
        expect((await push()).outcome).toBe(SyncOutcome.NOTHING_TO_DO);
    });

    it('respects an active backoff', async () => {
        await queue.markDirty(['a']);
        await queue.recordFailure();
        expect((await push()).outcome).toBe(SyncOutcome.BACKOFF);
        expect(commits).toHaveLength(0);
    });
});

describe('push payload', () => {
    it('uploads only queued entries, and encrypts text and frequency', async () => {
        texts = [entry('a'), entry('b')];
        await queue.markDirty(['a']);

        const result = await push();
        expect(result.outcome).toBe(SyncOutcome.PUSHED);
        expect(commits).toHaveLength(1);
        expect(commits[0].map(w => w.id)).toEqual(['a']);

        const { data } = commits[0][0];
        expect(data).toEqual({
            v: 1, ct: expect.any(String), iv: 'IV',
            order: 0, createdAt: 1000, updatedAt: 2000, deletedAt: null
        });
        // No plaintext of any kind in the uploaded record.
        expect(JSON.stringify(data)).not.toContain('text a');
        expect(Object.keys(data)).not.toContain('frequency');
        expect(Object.keys(data)).not.toContain('text');
    });

    it('binds ciphertext to the entry id', async () => {
        texts = [entry('a')];
        await queue.markDirty(['a']);
        await push();
        const decoded = JSON.parse(Buffer.from(commits[0][0].data.ct, 'base64').toString());
        expect(decoded.aad).toBe('a');
        expect(decoded.value).toEqual({ text: 'text a', frequency: 0 });
    });

    it('uploads tombstones so deletes propagate', async () => {
        texts = [entry('a', { deletedAt: 5000 })];
        await queue.markDirty(['a']);
        await push();
        expect(commits[0][0].data.deletedAt).toBe(5000);
    });

    it('clears the queue after a successful push', async () => {
        texts = [entry('a')];
        await queue.markDirty(['a']);
        await push();
        expect(await queue.getPending()).toEqual([]);
    });

    it('drops queued ids whose entry no longer exists locally', async () => {
        texts = [entry('a')];
        await queue.markDirty(['a', 'ghost']);
        const result = await push();
        expect(result.count).toBe(1);
        expect(await queue.getPending()).toEqual([]);   // ghost dropped, not retried forever
    });

    it('refuses to push an undecryptable placeholder, even if it is queued', async () => {
        // This is the hazard: text is null on a placeholder. If this were
        // ever pushed, "null" would be encrypted and overwrite the real
        // content that other devices can still read fine.
        texts = [entry('good'), entry('broken', { text: null, undecryptable: true })];
        await queue.markDirty(['good', 'broken']);

        const result = await push();
        expect(result.count).toBe(1);
        expect(commits[0].map(w => w.id)).toEqual(['good']);
        expect(await queue.getPending()).toEqual([]);   // not retried forever either
    });

    it('splits work across batches at the Firestore limit', async () => {
        texts = Array.from({ length: 501 }, (_, i) => entry(`e${i}`));
        await queue.markDirty(texts.map(t => t.id));
        const result = await push();
        expect(commits).toHaveLength(2);
        expect(commits[0]).toHaveLength(500);
        expect(commits[1]).toHaveLength(1);
        expect(result.count).toBe(501);
    });
});

describe('push failures', () => {
    it('treats permission-denied as fatal and does not schedule a retry', async () => {
        texts = [entry('a')];
        await queue.markDirty(['a']);
        commitError = Object.assign(new Error('nope'), { code: 'permission-denied' });

        const result = await push();
        expect(result.outcome).toBe(SyncOutcome.FAILED);
        expect(result.fatal).toBe(true);
        // Nothing consumed, and no backoff burned on an unfixable error.
        expect(await queue.getPending()).toEqual(['a']);
        expect(await queue.inBackoff()).toBe(false);
    });

    it('treats a network error as retryable and backs off', async () => {
        texts = [entry('a')];
        await queue.markDirty(['a']);
        commitError = Object.assign(new Error('offline'), { code: 'unavailable' });

        const result = await push();
        expect(result.fatal).toBe(false);
        expect(result.retryInMinutes).toBe(0.5);
        expect(await queue.getPending()).toEqual(['a']);   // preserved for the retry
        expect(await queue.inBackoff()).toBe(true);
    });

    it('keeps a committed batch when a later one fails', async () => {
        texts = Array.from({ length: 501 }, (_, i) => entry(`e${i}`));
        await queue.markDirty(texts.map(t => t.id));
        failCommitAt = 1;                 // first batch lands, second throws

        const result = await push();

        expect(result.outcome).toBe(SyncOutcome.FAILED);
        expect(result.fatal).toBe(false);
        expect(commits).toHaveLength(1);

        // The 500 that committed are dequeued so they aren't re-sent; the one
        // that didn't stays queued for the retry.
        expect(await queue.getPending()).toHaveLength(1);
        expect(await queue.inBackoff()).toBe(true);
    });
});


describe('verify', () => {
    // Seal a payload the way toRemote does, so verify() sees a realistic record.
    const seal = (id, text, frequency = 0, over = {}) => {
        remote.set(id, {
            v: 1, iv: 'IV',
            ct: Buffer.from(JSON.stringify({ value: { text, frequency }, aad: id })).toString('base64'),
            order: 0, createdAt: 1000, updatedAt: 2000, deletedAt: null, ...over
        });
    };

    it('reports in-sync when both sides agree', async () => {
        texts = [entry('a'), entry('b')];
        seal('a', 'text a');
        seal('b', 'text b');

        const report = await verify();
        expect(report.fullyUploaded).toBe(true);
        expect(report.awaitingPull).toBe(0);
        expect(report.matched).toBe(2);
        expect(report.localLive).toBe(2);
        expect(report.remoteLive).toBe(2);
        expect(report.notUploaded).toEqual([]);
    });

    it('flags an entry that never reached the server', async () => {
        texts = [entry('a'), entry('b')];
        seal('a', 'text a');

        const report = await verify();
        expect(report.fullyUploaded).toBe(false);
        expect(report.notUploaded).toEqual([{ id: 'b', preview: 'text b' }]);
    });

    it('reports a server-only entry as awaiting pull, not as a fault', async () => {
        // Another device pushed it. Pull isn't built yet, so this is expected
        // and must not be reported as this device having failed to sync.
        texts = [];
        seal('ghost', 'from another device');

        const report = await verify();
        expect(report.fullyUploaded).toBe(true);
        expect(report.awaitingPull).toBe(1);
        expect(report.onlyOnServer).toEqual([{ id: 'ghost', preview: 'from another device' }]);
    });

    it('flags contents that disagree', async () => {
        texts = [entry('a')];
        seal('a', 'something else');

        const report = await verify();
        expect(report.fullyUploaded).toBe(false);
        expect(report.matched).toBe(0);
        expect(report.contentMismatch[0]).toMatchObject({
            id: 'a', local: 'text a', remote: 'something else'
        });
    });

    it('flags a deletion that only happened on one side', async () => {
        texts = [entry('a', { deletedAt: 5000 })];
        seal('a', 'text a');                       // server still thinks it is live

        const report = await verify();
        expect(report.fullyUploaded).toBe(false);
        expect(report.contentMismatch[0]).toMatchObject({
            localDeleted: true, remoteDeleted: false
        });
    });

    it('counts a tombstone that agrees on both sides as matched', async () => {
        texts = [entry('a', { deletedAt: 5000 })];
        seal('a', 'text a', 0, { deletedAt: 5000 });

        const report = await verify();
        expect(report.fullyUploaded).toBe(true);
        expect(report.matched).toBe(1);
        expect(report.localLive).toBe(0);
        expect(report.remoteTombstoned).toBe(1);
    });

    it('reports undecryptable records instead of treating them as missing', async () => {
        texts = [entry('a')];
        // Ciphertext sealed against a different entry id — the AAD check fails.
        remote.set('a', {
            v: 1, iv: 'IV',
            ct: Buffer.from(JSON.stringify({ value: { text: 'x' }, aad: 'other-id' })).toString('base64'),
            order: 0, createdAt: 1000, updatedAt: 2000, deletedAt: null
        });

        const report = await verify();
        expect(report.fullyUploaded).toBe(false);
        expect(report.undecryptable).toEqual(['a']);
        expect(report.contentMismatch).toEqual([]);
    });

    it('refuses to guess while locked', async () => {
        key = null;
        expect((await verify()).outcome).toBe(SyncOutcome.LOCKED);
    });

    it('refuses while signed out', async () => {
        user = null;
        expect((await verify()).outcome).toBe(SyncOutcome.SIGNED_OUT);
    });

    it('truncates long previews so secrets are not dumped wholesale', async () => {
        texts = [entry('a', { text: 'y'.repeat(200) })];
        seal('a', 'z'.repeat(200));
        const report = await verify();
        expect(report.contentMismatch[0].local.length).toBeLessThanOrEqual(33);
    });
});

/** Seal a payload into the fake `remote` store, the same shape push writes. */
function sealRemote(id, text, frequency, over = {}) {
    remote.set(id, {
        v: 1, iv: 'IV',
        ct: Buffer.from(JSON.stringify({ value: { text, frequency }, aad: id })).toString('base64'),
        order: 0, createdAt: 1000, updatedAt: 2000, deletedAt: null, ...over
    });
}

describe('pull', () => {
    it('tells a never-merged device to run the first-merge flow instead', async () => {
        // getLastPullAt() defaults to 0, which is the "never merged" signal.
        sealRemote('a', 'text a', 0);
        expect((await pull()).outcome).toBe(SyncOutcome.NEEDS_FIRST_MERGE);
        expect(texts).toEqual([]);   // nothing applied — first-merge owns this
    });

    it('does nothing signed out or locked', async () => {
        await queue.setLastPullAt(1000);
        user = null;
        expect((await pull()).outcome).toBe(SyncOutcome.SIGNED_OUT);
        user = { uid: 'uid-1' };
        key = null;
        expect((await pull()).outcome).toBe(SyncOutcome.LOCKED);
    });

    it('reports nothing-to-do when there is no newer remote data', async () => {
        await queue.setLastPullAt(9999);
        expect((await pull()).outcome).toBe(SyncOutcome.NOTHING_TO_DO);
    });

    it('adds an entry that only exists on another device', async () => {
        await queue.setLastPullAt(1000);
        sealRemote('a', 'from device B', 3, { updatedAt: 2000 });

        const result = await pull();
        expect(result.outcome).toBe(SyncOutcome.PULLED);
        expect(result.applied).toBe(1);
        expect(texts).toHaveLength(1);
        expect(texts[0]).toMatchObject({ id: 'a', text: 'from device B', frequency: 3 });
        // Pulled entries must not be re-queued for push — they came FROM the
        // server, so saveState is called without dirtyIds at all.
        expect(savedStateCalls[0].dirtyIds).toEqual([]);
    });

    it('overwrites a local entry when the remote copy is newer', async () => {
        texts = [entry('a', { text: 'old', updatedAt: 1000 })];
        await queue.setLastPullAt(500);
        sealRemote('a', 'new from elsewhere', 0, { updatedAt: 2000 });

        await pull();
        expect(texts[0].text).toBe('new from elsewhere');
    });

    it('keeps the local copy when it is strictly newer than the remote one', async () => {
        texts = [entry('a', { text: 'newer locally', updatedAt: 5000 })];
        await queue.setLastPullAt(500);
        sealRemote('a', 'stale', 0, { updatedAt: 2000 });

        const result = await pull();
        expect(texts[0].text).toBe('newer locally');
        // Nothing changed locally, so nothing should have been written back.
        expect(savedStateCalls).toHaveLength(0);
        expect(result.applied).toBe(0);
    });

    it('breaks a genuine tie deterministically, the same way on both sides', async () => {
        texts = [entry('a', { text: 'aaa', updatedAt: 2000 })];
        await queue.setLastPullAt(500);
        sealRemote('a', 'zzz', 0, { updatedAt: 2000 });   // exact same updatedAt

        await pull();
        // 'zzz' > 'aaa' lexicographically, so remote wins this tie.
        expect(texts[0].text).toBe('zzz');
    });

    it('propagates a delete as a tombstone, not a removal', async () => {
        texts = [entry('a', { text: 'gone soon', updatedAt: 1000, deletedAt: null })];
        await queue.setLastPullAt(500);
        sealRemote('a', 'gone soon', 0, { updatedAt: 2000, deletedAt: 2000 });

        await pull();
        expect(texts[0].deletedAt).toBe(2000);
        expect(texts).toHaveLength(1);   // still present, just tombstoned
    });

    it('reports an undecryptable record without losing the rest of the batch', async () => {
        texts = [entry('a'), entry('b')];
        await queue.setLastPullAt(500);
        sealRemote('a', 'fine', 0, { updatedAt: 5000 });   // unambiguously newer
        remote.set('bad', {
            v: 1, iv: 'IV',
            ct: Buffer.from(JSON.stringify({ value: { text: 'x' }, aad: 'someone-else' })).toString('base64'),
            order: 0, createdAt: 1000, updatedAt: 2000, deletedAt: null
        });

        const result = await pull();
        expect(result.decryptFailures).toEqual(['bad']);
        expect(texts.find(t => t.id === 'a').text).toBe('fine');
    });

    it('materialises a visible placeholder for a brand-new entry that fails to decrypt', async () => {
        texts = [];
        await queue.setLastPullAt(500);
        remote.set('mystery', {
            v: 1, iv: 'IV',
            ct: Buffer.from(JSON.stringify({ value: { text: 'x' }, aad: 'wrong-id' })).toString('base64'),
            order: 0, createdAt: 1000, updatedAt: 2000, deletedAt: null
        });

        await pull();
        // Without this, an entry this device can never decrypt would simply
        // never appear — indistinguishable from it never having existed.
        expect(texts).toEqual([expect.objectContaining({
            id: 'mystery', text: null, undecryptable: true
        })]);
    });

    it('does not overwrite an existing local entry with a placeholder on decrypt failure', async () => {
        // The entry is known-good locally; a remote version that fails to
        // decrypt must not clobber the last content this device could read.
        texts = [entry('a', { text: 'still readable here', updatedAt: 1000 })];
        await queue.setLastPullAt(500);
        remote.set('a', {
            v: 1, iv: 'IV',
            ct: Buffer.from(JSON.stringify({ value: { text: 'x' }, aad: 'wrong-id' })).toString('base64'),
            order: 0, createdAt: 1000, updatedAt: 9000, deletedAt: null
        });

        await pull();
        expect(texts).toEqual([expect.objectContaining({
            id: 'a', text: 'still readable here', undecryptable: false
        })]);
    });

    it('does NOT advance the pull cursor past a document it could not decrypt', async () => {
        // This is the bug: advancing the cursor past a failure would mean the
        // delta query `updatedAt > cursor` never returns that document again,
        // permanently hiding it even once the correct key is available.
        texts = [];
        await queue.setLastPullAt(500);
        remote.set('bad', {
            v: 1, iv: 'IV',
            ct: Buffer.from(JSON.stringify({ value: { text: 'x' }, aad: 'wrong-id' })).toString('base64'),
            order: 0, createdAt: 1000, updatedAt: 9000, deletedAt: null
        });

        await pull();
        expect(await queue.getLastPullAt()).toBe(500);   // unchanged

        // A second pull with the SAME (still wrong) key must retry, not skip.
        await pull();
        expect(texts.filter(t => t.id === 'bad')).toHaveLength(1);   // not duplicated
    });

    it('still advances the cursor past documents it could decrypt in the same batch', async () => {
        texts = [];
        await queue.setLastPullAt(500);
        sealRemote('good', 'readable', 0, { updatedAt: 3000 });
        remote.set('bad', {
            v: 1, iv: 'IV',
            ct: Buffer.from(JSON.stringify({ value: { text: 'x' }, aad: 'wrong-id' })).toString('base64'),
            order: 0, createdAt: 1000, updatedAt: 9000, deletedAt: null
        });

        await pull();
        // Held back by 'bad', but not stuck at the original cursor either.
        expect(await queue.getLastPullAt()).toBe(3000);
    });

    it('advances the pull cursor to the newest updatedAt actually seen', async () => {
        await queue.setLastPullAt(500);
        sealRemote('a', 'x', 0, { updatedAt: 1000 });
        sealRemote('b', 'y', 0, { updatedAt: 7000 });

        await pull();
        expect(await queue.getLastPullAt()).toBe(7000);
    });

    it('falls back to a full read when this device has gone stale', async () => {
        const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;
        await queue.setLastPullAt(thirtyOneDaysAgo);
        sealRemote('a', 'old but still valid', 0, { updatedAt: thirtyOneDaysAgo - 1000 });

        // A plain delta query (updatedAt > cursor) would miss this, since it
        // predates the cursor; the stale path must read everything instead.
        const result = await pull();
        expect(result.stale).toBe(true);
        expect(texts.find(t => t.id === 'a')).toBeTruthy();
    });
});

describe('previewFirstMerge / applyFirstMerge', () => {
    it('refuses signed out or locked', async () => {
        user = null;
        expect((await previewFirstMerge()).outcome).toBe(SyncOutcome.SIGNED_OUT);
        user = { uid: 'uid-1' };
        key = null;
        expect((await previewFirstMerge()).outcome).toBe(SyncOutcome.LOCKED);
    });

    it('aborts entirely if any remote entry fails to decrypt', async () => {
        sealRemote('a', 'fine', 0);
        remote.set('bad', {
            v: 1, iv: 'IV',
            ct: Buffer.from(JSON.stringify({ value: { text: 'x' }, aad: 'wrong' })).toString('base64'),
            order: 0, createdAt: 1000, updatedAt: 2000, deletedAt: null
        });

        const result = await previewFirstMerge();
        expect(result.outcome).toBe(SyncOutcome.WRONG_PASSPHRASE);
    });

    it('fuses entries with identical text, keeping the remote id', async () => {
        texts = [entry('local-1', { text: 'shared snippet', frequency: 2, timestamp: 500 })];
        sealRemote('remote-1', 'shared snippet', 5, { createdAt: 900, order: 42 });

        const { plan } = await previewFirstMerge();
        expect(plan.duplicates).toBe(1);
        expect(plan.merged).toHaveLength(1);

        const fused = plan.merged[0];
        expect(fused.id).toBe('remote-1');              // remote id wins
        expect(fused.frequency).toBe(5);                // max(2, 5)
        expect(fused.timestamp).toBe(500);               // min(500, 900)
        expect(fused.order).toBe(42);                     // remote's order
        expect(plan.dirtyIds).toContain('remote-1');       // fused id still needs push
    });

    it('keeps a local-only entry, giving it a fresh order past the remote range', async () => {
        texts = [entry('local-1', { text: 'only here', order: 999999 })];
        sealRemote('remote-1', 'unrelated', 0, { order: 5000 });

        const { plan } = await previewFirstMerge();
        const local = plan.merged.find(e => e.id === 'local-1');
        expect(local.order).toBeGreaterThan(5000);
        expect(plan.dirtyIds).toContain('local-1');
    });

    it('keeps a remote-only entry without marking it dirty', async () => {
        sealRemote('remote-1', 'from another device', 0);

        const { plan } = await previewFirstMerge();
        expect(plan.merged.map(e => e.id)).toEqual(['remote-1']);
        // Already correct on the server — pushing it again would be wasted work.
        expect(plan.dirtyIds).not.toContain('remote-1');
    });

    it('does not dedup against a tombstoned remote entry', async () => {
        texts = [entry('local-1', { text: 'was deleted elsewhere' })];
        sealRemote('remote-1', 'was deleted elsewhere', 0, { deletedAt: 5000 });

        const { plan } = await previewFirstMerge();
        // No fusing: the local live entry and the remote tombstone both survive
        // as distinct entries rather than the local one vanishing into a delete.
        expect(plan.duplicates).toBe(0);
        expect(plan.merged).toHaveLength(2);
    });

    it('drops local tombstones — nothing in them is worth preserving', async () => {
        texts = [entry('local-1', { deletedAt: 1000 })];
        const { plan } = await previewFirstMerge();
        expect(plan.merged).toHaveLength(0);
    });

    it('does not write anything until applyFirstMerge is called', async () => {
        texts = [entry('local-1', { text: 'unmerged' })];
        await previewFirstMerge();
        expect(savedStateCalls).toHaveLength(0);
        expect(texts.find(t => t.id === 'local-1')).toBeTruthy();   // untouched
    });

    it('applies the plan and marks this device as merged', async () => {
        texts = [entry('local-1', { text: 'mine' })];
        sealRemote('remote-1', 'theirs', 0, { updatedAt: 3000 });

        const { plan } = await previewFirstMerge();
        const result = await applyFirstMerge(plan);

        expect(result.outcome).toBe(SyncOutcome.MERGED);
        expect(texts).toHaveLength(2);
        expect(savedStateCalls[0].dirtyIds).toEqual(plan.dirtyIds);
        expect(await queue.getLastPullAt()).toBeGreaterThan(0);
    });

    it('marks an empty merge as done too, so it is not offered forever', async () => {
        texts = [];
        const { plan } = await previewFirstMerge();
        expect(plan.merged).toHaveLength(0);

        await applyFirstMerge(plan);
        // Falls back to "now" rather than 0 — see the comment in applyFirstMerge.
        expect(await queue.getLastPullAt()).toBeGreaterThan(0);
    });
});

describe('gcTombstones', () => {
    const DAY = 24 * 60 * 60 * 1000;

    it('removes only tombstones older than the retention window', async () => {
        sealRemote('old-tombstone', 'x', 0, { deletedAt: Date.now() - 31 * DAY });
        sealRemote('recent-tombstone', 'y', 0, { deletedAt: Date.now() - 1 * DAY });
        sealRemote('still-live', 'z', 0, { deletedAt: null });
        texts = [
            entry('old-tombstone', { deletedAt: Date.now() - 31 * DAY }),
            entry('recent-tombstone', { deletedAt: Date.now() - 1 * DAY }),
            entry('still-live')
        ];

        const result = await gcTombstones();
        expect(result.removed).toBe(1);
        expect(remote.has('old-tombstone')).toBe(false);
        expect(remote.has('recent-tombstone')).toBe(true);
        expect(remote.has('still-live')).toBe(true);
        expect(texts.map(t => t.id)).toEqual(['recent-tombstone', 'still-live']);
    });

    it('does nothing when there is nothing old enough to collect', async () => {
        sealRemote('a', 'x', 0, { deletedAt: null });
        const result = await gcTombstones();
        expect(result.removed).toBe(0);
        expect(savedStateCalls).toHaveLength(0);   // no needless write
    });

    it('refuses signed out', async () => {
        user = null;
        expect((await gcTombstones()).outcome).toBe(SyncOutcome.SIGNED_OUT);
    });
});

describe('rotatePassphrase', () => {
    it('refuses signed out or locked', async () => {
        user = null;
        expect((await rotatePassphrase('new-passphrase-1', {}, 'week')).outcome)
            .toBe(SyncOutcome.SIGNED_OUT);
        user = { uid: 'uid-1' };
        key = null;
        expect((await rotatePassphrase('new-passphrase-1', {}, 'week')).outcome)
            .toBe(SyncOutcome.LOCKED);
    });

    it('rotates the account doc, preserving createdAt and moving updatedAt forward', async () => {
        accountDocs.set('uid-1', {
            schemaVersion: 2,
            kdf: { alg: 'PBKDF2-SHA256', iterations: 600000, salt: 'OLD-SALT' },
            verifier: { iv: 'iv', ct: 'old-verifier' },
            createdAt: 1000, updatedAt: 2000
        });
        const existing = accountDocs.get('uid-1');

        await rotatePassphrase('brand-new-passphrase', existing, 'week');

        const rotated = accountDocs.get('uid-1');
        expect(rotated.createdAt).toBe(1000);              // pinned
        expect(rotated.updatedAt).toBeGreaterThan(2000);    // moved forward
        expect(rotated.kdf.salt).toBe('SALT-FOR-brand-new-passphrase');
        expect(rotated.verifier.ct).toBe('VERIFIER-FOR-brand-new-passphrase');
    });

    it('re-caches the key so subsequent operations use it', async () => {
        accountDocs.set('uid-1', { createdAt: 1000, updatedAt: 2000 });
        await rotatePassphrase('brand-new-passphrase', accountDocs.get('uid-1'), 'week');
        expect(key).toBe('key-for-brand-new-passphrase');
    });

    it('bumps every live entry and re-pushes it under the new key', async () => {
        accountDocs.set('uid-1', { createdAt: 1000, updatedAt: 2000 });
        texts = [
            entry('a', { updatedAt: 1000 }),
            entry('b', { updatedAt: 1000, deletedAt: 5000 })   // tombstones too
        ];

        const result = await rotatePassphrase('brand-new-passphrase', accountDocs.get('uid-1'), 'week');

        expect(result.outcome).toBe(SyncOutcome.ROTATED);
        expect(result.count).toBe(2);
        expect(texts.every(t => t.updatedAt > 1000)).toBe(true);

        // Actually landed on the server, encrypted under the new key.
        expect(commits.flat()).toHaveLength(2);
        const decoded = JSON.parse(Buffer.from(commits[0][0].data.ct, 'base64').toString());
        expect(decoded.key).toBe('key-for-brand-new-passphrase');
    });

    it('never touches an undecryptable placeholder', async () => {
        // The hazard this exists to prevent: re-encrypting null over content
        // this device can't read would destroy it for devices that can.
        accountDocs.set('uid-1', { createdAt: 1000, updatedAt: 2000 });
        texts = [
            entry('a', { updatedAt: 1000 }),
            entry('broken', { text: null, undecryptable: true, updatedAt: 1000 })
        ];

        const result = await rotatePassphrase('brand-new-passphrase', accountDocs.get('uid-1'), 'week');

        expect(result.count).toBe(1);
        expect(texts.find(t => t.id === 'broken').updatedAt).toBe(1000);   // untouched
        expect(commits.flat().map(w => w.id)).toEqual(['a']);
        expect(remote.has('broken')).toBe(false);   // never written
    });

    it('surfaces a push failure without leaving the account doc mismatched', async () => {
        accountDocs.set('uid-1', { createdAt: 1000, updatedAt: 2000 });
        texts = [entry('a', { updatedAt: 1000 })];
        commitError = Object.assign(new Error('offline'), { code: 'unavailable' });

        const result = await rotatePassphrase('brand-new-passphrase', accountDocs.get('uid-1'), 'week');

        expect(result.outcome).toBe(SyncOutcome.ROTATED);
        expect(result.pushResult.outcome).toBe(SyncOutcome.FAILED);
        // The account doc still rotated — a retried push later succeeds under
        // the same (already-rotated) key rather than needing to rotate again.
        expect(accountDocs.get('uid-1').kdf.salt).toBe('SALT-FOR-brand-new-passphrase');
        expect(await queue.getPending()).toEqual(['a']);   // preserved for retry
    });
});
