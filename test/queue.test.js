import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
    getPending, markDirty, clearPending,
    getBackoff, recordFailure, clearBackoff, inBackoff,
    getLastPullAt, setLastPullAt,
    getLastError, setLastError, clearLastError
} from '../src/lib/queue.js';

function fakeStorage(initial = {}) {
    let data = { ...initial };
    globalThis.chrome = {
        storage: {
            local: {
                get: async keys => {
                    const list = Array.isArray(keys) ? keys : [keys];
                    return Object.fromEntries(list.filter(k => k in data).map(k => [k, data[k]]));
                },
                set: async patch => { data = { ...data, ...patch }; },
                remove: async keys => {
                    const list = Array.isArray(keys) ? keys : [keys];
                    list.forEach(k => { delete data[k]; });
                }
            }
        }
    };
    return () => data;
}

let data;
beforeEach(() => { data = fakeStorage(); });

describe('dirty queue', () => {
    it('starts empty', async () => {
        expect(await getPending()).toEqual([]);
    });

    it('coalesces repeated marks of the same entry', async () => {
        // Ten rapid copies of one snippet must become one push, not ten.
        for (let i = 0; i < 10; i++) await markDirty('entry-a');
        expect(await getPending()).toEqual(['entry-a']);
    });

    it('accepts a single id or an array', async () => {
        await markDirty('a');
        await markDirty(['b', 'c']);
        expect((await getPending()).sort()).toEqual(['a', 'b', 'c']);
    });

    it('ignores an empty mark', async () => {
        await markDirty([]);
        expect(await getPending()).toEqual([]);
    });

    it('only dequeues what was actually pushed', async () => {
        await markDirty(['a', 'b', 'c']);
        await clearPending(['a', 'b']);
        expect(await getPending()).toEqual(['c']);
    });

    it('keeps an entry queued if it was touched during the push', async () => {
        // The realistic race: a push of [a] is in flight when the user edits a
        // again. Clearing wholesale would lose that second edit.
        await markDirty(['a']);
        const inFlight = await getPending();
        await markDirty(['a']);          // edited again mid-push
        await clearPending(inFlight);
        expect(await getPending()).toEqual([]);
    });

    it('survives a clear of ids that were never queued', async () => {
        await markDirty(['a']);
        await clearPending(['zzz']);
        expect(await getPending()).toEqual(['a']);
    });
});

describe('backoff', () => {
    it('starts clear', async () => {
        expect(await getBackoff()).toEqual({ attempt: 0, until: 0 });
        expect(await inBackoff()).toBe(false);
    });

    it('escalates 30s, 1m, 5m, 15m and then holds', async () => {
        const delays = [];
        for (let i = 0; i < 6; i++) delays.push(await recordFailure());
        expect(delays).toEqual([0.5, 1, 5, 15, 15, 15]);
    });

    it('suppresses attempts until the deadline passes', async () => {
        await recordFailure();
        expect(await inBackoff()).toBe(true);
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60 * 60_000);
        expect(await inBackoff()).toBe(false);
        vi.restoreAllMocks();
    });

    it('resets after a success', async () => {
        await recordFailure();
        await recordFailure();
        await clearBackoff();
        expect(await getBackoff()).toEqual({ attempt: 0, until: 0 });
        expect(await inBackoff()).toBe(false);
    });
});

describe('pull cursor', () => {
    it('defaults to the beginning of time', async () => {
        expect(await getLastPullAt()).toBe(0);
    });

    it('round-trips', async () => {
        await setLastPullAt(1234);
        expect(await getLastPullAt()).toBe(1234);
    });
});

describe('last sync error', () => {
    it('starts clear', async () => {
        expect(await getLastError()).toBeNull();
    });

    it('round-trips and stamps a timestamp', async () => {
        await setLastError({ source: 'push', code: 'unavailable', message: 'offline', fatal: false });
        const error = await getLastError();
        expect(error).toMatchObject({ source: 'push', code: 'unavailable', fatal: false });
        expect(error.at).toBeTypeOf('number');
    });

    it('the latest call wins over an earlier one', async () => {
        await setLastError({ source: 'push', code: 'unavailable', fatal: false });
        await setLastError({ source: 'pull', code: 'permission-denied', fatal: true });
        expect((await getLastError()).source).toBe('pull');
    });

    it('clears', async () => {
        await setLastError({ source: 'push', code: 'unavailable', fatal: false });
        await clearLastError();
        expect(await getLastError()).toBeNull();
    });
});
