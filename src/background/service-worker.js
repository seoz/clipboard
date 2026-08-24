/**
 * Background service worker.
 *
 * Phase 1 scope: prove that auth state survives worker teardown and that the
 * worker can mint a fresh id token when woken by an alarm. The sync engine
 * lands in Phase 3 and hangs off the same wakeup.
 *
 * Never assume this worker is alive: MV3 kills it after ~30s idle. All
 * durable state lives in chrome.storage / IndexedDB, and chrome.alarms is what
 * brings it back.
 *
 * Dynamic import() is avoided here — it has historically been unreliable in
 * MV3 module workers, so the dependency graph is kept static.
 */

import { currentUser } from '../lib/auth.js';
import { isConfigured } from '../lib/firebase.js';
import { purgeIfSessionScoped, getCachedKey } from '../lib/keycache.js';
import {
    push, pull, verify, gcTombstones,
    previewFirstMerge, applyFirstMerge, SyncOutcome
} from '../lib/sync.js';
import { getPending, getLastError, setLastError, clearLastError } from '../lib/queue.js';
import { MSG } from '../shared/messages.js';

const SYNC_ALARM = 'sync-flush';
const GC_ALARM = 'sync-gc';

/** chrome.alarms won't schedule below ~30s; that doubles as the push debounce. */
const FLUSH_DELAY_MINUTES = 0.5;

/** Tombstone garbage collection runs at most once a day. */
const GC_PERIOD_MINUTES = 24 * 60;

async function scheduleFlush() {
    await chrome.alarms.create(SYNC_ALARM, { delayInMinutes: FLUSH_DELAY_MINUTES });
}

/**
 * Encrypt and upload everything the popup has queued, then pull whatever
 * changed elsewhere. Push goes first so this device's own edits are never
 * shadowed by something older arriving from pull in the same cycle.
 *
 * Runs on a cold worker: auth is restored from IndexedDB and the encryption
 * key is read from the shared key cache, neither of which needs a page.
 */
async function flush() {
    if (!isConfigured()) return { ok: false, reason: 'not-configured' };

    let pushResult;
    try {
        pushResult = await push();
    } catch (error) {
        console.error('[quickpaste] push threw:', error);
        return { ok: false, reason: 'error', message: error.message };
    }

    // A failure that is not fatal has already been given a backoff deadline;
    // re-arm the alarm so the retry actually happens.
    if (pushResult.outcome === SyncOutcome.FAILED && !pushResult.fatal) {
        await chrome.alarms.create(SYNC_ALARM, { delayInMinutes: pushResult.retryInMinutes });
    }

    let pullResult = { outcome: 'skipped' };
    // A hard push failure means the session or rules are broken; pulling
    // under the same broken session would just fail the same way.
    const pushOk = pushResult.outcome !== SyncOutcome.FAILED || !pushResult.fatal;
    if (pushOk) {
        try {
            pullResult = await pull();
        } catch (error) {
            console.error('[quickpaste] pull threw:', error);
            pullResult = { outcome: 'error', message: error.message };
        }
    }

    await updateBadge();
    await recordOutcome(pushResult, pullResult);

    const ok = [SyncOutcome.PUSHED, SyncOutcome.NOTHING_TO_DO].includes(pushResult.outcome)
        && [SyncOutcome.PULLED, SyncOutcome.NOTHING_TO_DO, SyncOutcome.NEEDS_FIRST_MERGE, 'skipped']
            .includes(pullResult.outcome);

    return {
        ok,
        push: { ...pushResult, error: pushResult.error?.message },
        pull: pullResult
    };
}

/**
 * Keep a single "last problem" slot up to date, so the popup can show a
 * specific reason without itself calling push/pull. Push is treated as the
 * more actionable signal — a broken session shows up there first — but
 * either side clears the slot as soon as both have gone clean.
 */
async function recordOutcome(pushResult, pullResult) {
    if (pushResult.outcome === SyncOutcome.FAILED) {
        await setLastError({
            source: 'push',
            code: pushResult.error?.code ?? 'unknown',
            message: pushResult.error?.message ?? 'Push failed',
            fatal: Boolean(pushResult.fatal)
        });
        return;
    }

    if (pullResult.outcome === 'error') {
        await setLastError({
            source: 'pull',
            code: pullResult.message?.includes('permission-denied') ? 'permission-denied' : 'unknown',
            message: pullResult.message ?? 'Pull failed',
            fatal: false
        });
        return;
    }

    await clearLastError();
}

/**
 * A small count on the toolbar icon when work is outstanding. Deliberately
 * quiet: no badge at all when everything is pushed.
 */
async function updateBadge() {
    const pending = await getPending();
    await chrome.action.setBadgeText({ text: pending.length ? String(pending.length) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#6c5ce7' });
}

// Honours the "until Chrome restarts" auto-lock policy. onStartup fires once
// per browser launch, which is the only signal an extension gets for it.
chrome.runtime.onStartup.addListener(() => {
    purgeIfSessionScoped().catch(error => console.error('Session purge failed:', error));
});

chrome.runtime.onInstalled.addListener(() => {
    // periodInMinutes makes this self-renewing; no need to re-create it later.
    chrome.alarms.create(GC_ALARM, { periodInMinutes: GC_PERIOD_MINUTES });
});

chrome.alarms.onAlarm.addListener(async alarm => {
    if (alarm.name === SYNC_ALARM) {
        const result = await flush();
        if (!result.ok) console.warn('[quickpaste] flush:', result);
        return;
    }
    if (alarm.name === GC_ALARM) {
        try {
            await gcTombstones();
        } catch (error) {
            console.error('[quickpaste] tombstone GC failed:', error);
        }
    }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === MSG.SYNC_REQUEST) {
        scheduleFlush();
        sendResponse({ scheduled: true });
        return false;
    }

    if (message?.type === MSG.SYNC_STATUS) {
        // All three reads are local (chrome.storage / IndexedDB) — no network,
        // so this is safe to call on every popup open without adding latency.
        Promise.all([getPending(), currentUser(), getLastError()])
            .then(async ([pending, user, lastError]) => {
                const locked = user ? !(await getCachedKey(user.uid)) : false;
                sendResponse({ pending: pending.length, locked, lastError });
            })
            .catch(() => sendResponse({ pending: 0, locked: false, lastError: null }));
        return true;
    }

    if (message?.type === MSG.AUTH_STATUS) {
        // Async response: returning true keeps the channel open.
        currentUser()
            .then(user => sendResponse(
                user ? { signedIn: true, uid: user.uid, email: user.email } : { signedIn: false }))
            .catch(error => sendResponse({ signedIn: false, error: error.message }));
        return true;
    }

    if (message?.type === MSG.VERIFY_SYNC) {
        verify()
            .then(sendResponse)
            .catch(error => sendResponse({ outcome: 'error', message: error.message }));
        return true;
    }

    if (message?.type === MSG.PREVIEW_MERGE) {
        previewFirstMerge().then(sendResponse).catch(error =>
            sendResponse({ outcome: 'error', message: error.message }));
        return true;
    }

    if (message?.type === MSG.APPLY_MERGE) {
        applyFirstMerge(message.plan)
            .then(async result => { await updateBadge(); return result; })
            .then(sendResponse)
            .catch(error => sendResponse({ outcome: 'error', message: error.message }));
        return true;
    }

    if (message?.type === MSG.FLUSH_NOW) {
        flush().then(sendResponse).catch(error => sendResponse({ ok: false, reason: error.message }));
        return true;
    }

    return false;
});
