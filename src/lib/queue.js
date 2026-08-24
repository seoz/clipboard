/**
 * The pending-push queue.
 *
 * Local writes must never wait on the network. The popup persists to
 * chrome.storage.local exactly as it always has and records which entry ids
 * changed; the service worker drains that record later. This is what keeps the
 * copy path — one write per copy, followed 100ms later by the popup closing
 * itself — from becoming a network round trip against a dying page.
 *
 * The queue is a SET of ids, not a log of operations. Ten rapid copies of the
 * same snippet therefore collapse into one push carrying the final count,
 * rather than ten writes of intermediate values.
 */

const PENDING_KEY = 'pendingOps';
const BACKOFF_KEY = 'syncBackoff';
const LAST_PULL_KEY = 'lastPullAt';

export async function getPending() {
    const { [PENDING_KEY]: pending } = await chrome.storage.local.get(PENDING_KEY);
    return Array.isArray(pending) ? pending : [];
}

export async function markDirty(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    if (list.length === 0) return;
    const merged = new Set(await getPending());
    list.forEach(id => merged.add(id));
    await chrome.storage.local.set({ [PENDING_KEY]: [...merged] });
}

/**
 * Remove ids that were successfully pushed.
 *
 * Takes the specific ids rather than clearing wholesale: an entry touched
 * while the push was in flight must stay queued, or that edit would be lost.
 */
export async function clearPending(pushedIds) {
    const pushed = new Set(pushedIds);
    const remaining = (await getPending()).filter(id => !pushed.has(id));
    await chrome.storage.local.set({ [PENDING_KEY]: remaining });
}

// ---- retry backoff -------------------------------------------------------

/** 30s, 1m, 5m, 15m, then hold. Mirrors the alarm's own 30s floor. */
const BACKOFF_MINUTES = [0.5, 1, 5, 15];

export async function getBackoff() {
    const { [BACKOFF_KEY]: state } = await chrome.storage.local.get(BACKOFF_KEY);
    return state ?? { attempt: 0, until: 0 };
}

export async function recordFailure() {
    const { attempt } = await getBackoff();
    const next = Math.min(attempt, BACKOFF_MINUTES.length - 1);
    const delayMinutes = BACKOFF_MINUTES[next];
    const state = {
        attempt: attempt + 1,
        until: Date.now() + delayMinutes * 60_000
    };
    await chrome.storage.local.set({ [BACKOFF_KEY]: state });
    return delayMinutes;
}

export async function clearBackoff() {
    await chrome.storage.local.set({ [BACKOFF_KEY]: { attempt: 0, until: 0 } });
}

export async function inBackoff() {
    return Date.now() < (await getBackoff()).until;
}

// ---- pull cursor ---------------------------------------------------------

export async function getLastPullAt() {
    const { [LAST_PULL_KEY]: at } = await chrome.storage.local.get(LAST_PULL_KEY);
    return typeof at === 'number' ? at : 0;
}

export async function setLastPullAt(at) {
    await chrome.storage.local.set({ [LAST_PULL_KEY]: at });
}
