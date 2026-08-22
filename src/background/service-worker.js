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
import { purgeIfSessionScoped } from '../lib/keycache.js';
import { push, SyncOutcome } from '../lib/sync.js';
import { getPending } from '../lib/queue.js';
import { MSG } from '../shared/messages.js';

const SYNC_ALARM = 'sync-flush';

/** chrome.alarms won't schedule below ~30s; that doubles as the push debounce. */
const FLUSH_DELAY_MINUTES = 0.5;

async function scheduleFlush() {
    await chrome.alarms.create(SYNC_ALARM, { delayInMinutes: FLUSH_DELAY_MINUTES });
}

/**
 * Encrypt and upload everything the popup has queued.
 *
 * Runs on a cold worker: auth is restored from IndexedDB and the encryption
 * key is read from the shared key cache, neither of which needs a page.
 */
async function flush() {
    if (!isConfigured()) return { ok: false, reason: 'not-configured' };

    let result;
    try {
        result = await push();
    } catch (error) {
        console.error('[quickpaste] flush threw:', error);
        return { ok: false, reason: 'error', message: error.message };
    }

    // A failure that is not fatal has already been given a backoff deadline;
    // re-arm the alarm so the retry actually happens.
    if (result.outcome === SyncOutcome.FAILED && !result.fatal) {
        await chrome.alarms.create(SYNC_ALARM, { delayInMinutes: result.retryInMinutes });
    }

    await updateBadge();
    return { ok: result.outcome === SyncOutcome.PUSHED || result.outcome === SyncOutcome.NOTHING_TO_DO,
             ...result, error: result.error?.message };
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

chrome.alarms.onAlarm.addListener(async alarm => {
    if (alarm.name !== SYNC_ALARM) return;
    const result = await flush();
    if (!result.ok) console.warn('[quickpaste] flush:', result);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === MSG.SYNC_REQUEST) {
        scheduleFlush();
        sendResponse({ scheduled: true });
        return false;
    }

    if (message?.type === MSG.SYNC_STATUS) {
        getPending()
            .then(pending => sendResponse({ pending: pending.length }))
            .catch(() => sendResponse({ pending: 0 }));
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

    if (message?.type === MSG.FLUSH_NOW) {
        flush().then(sendResponse).catch(error => sendResponse({ ok: false, reason: error.message }));
        return true;
    }

    return false;
});
