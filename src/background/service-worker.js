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
import { MSG } from '../shared/messages.js';

const SYNC_ALARM = 'sync-flush';

/** chrome.alarms won't schedule below ~30s; that doubles as the push debounce. */
const FLUSH_DELAY_MINUTES = 0.5;

async function scheduleFlush() {
    await chrome.alarms.create(SYNC_ALARM, { delayInMinutes: FLUSH_DELAY_MINUTES });
}

/**
 * Phase 1: report who we are after a cold start. Phase 3 replaces the body
 * with the encrypt-and-push flush.
 */
async function flush() {
    if (!isConfigured()) return { ok: false, reason: 'not-configured' };

    const user = await currentUser();
    if (!user) return { ok: false, reason: 'signed-out' };

    // Proves the worker can refresh credentials without a page context.
    const token = await user.getIdToken();
    return { ok: true, uid: user.uid, email: user.email, tokenLength: token.length };
}

chrome.alarms.onAlarm.addListener(async alarm => {
    if (alarm.name !== SYNC_ALARM) return;
    console.log('[quickpaste] flush:', await flush());
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === MSG.SYNC_REQUEST) {
        scheduleFlush();
        sendResponse({ scheduled: true });
        return false;
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
