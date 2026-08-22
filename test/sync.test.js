import { describe, it, expect, beforeEach, vi } from 'vitest';

// Firestore, auth and the key cache are all stubbed: what's under test is the
// push decision logic — what gets uploaded, what gets dequeued, and how
// failures are classified.
const commits = [];
let commitError = null;
/** Commit index (0-based) that should throw, or null for "never". */
let failCommitAt = null;

vi.mock('firebase/firestore/lite', () => ({
    doc: (_ref, id) => ({ id }),
    collection: (_db, ...path) => ({ path: path.join('/') }),
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
vi.mock('../src/lib/keycache.js', () => ({ getCachedKey: async () => key }));

vi.mock('../src/lib/crypto.js', () => ({
    encryptJson: async (_k, value, aad) => ({
        iv: 'IV', ct: Buffer.from(JSON.stringify({ value, aad })).toString('base64')
    })
}));

let texts = [];
vi.mock('../src/lib/store.js', () => ({ loadState: async () => ({ texts, sortMode: 'manual' }) }));

const { push, SyncOutcome } = await import('../src/lib/sync.js');
const queue = await import('../src/lib/queue.js');

const entry = (id, over = {}) => ({
    id, text: `text ${id}`, frequency: 0,
    timestamp: 1000, updatedAt: 2000, order: 0, deletedAt: null, ...over
});

function fakeStorage() {
    let data = {};
    globalThis.chrome = { storage: { local: {
        get: async keys => Object.fromEntries(
            (Array.isArray(keys) ? keys : [keys]).filter(k => k in data).map(k => [k, data[k]])),
        set: async patch => { data = { ...data, ...patch }; }
    } } };
}

beforeEach(() => {
    commits.length = 0;
    commitError = null;
    failCommitAt = null;
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
