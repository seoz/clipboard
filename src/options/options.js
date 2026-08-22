/**
 * Options page — owns the OAuth flow.
 *
 * This lives here rather than in the action popup because
 * chrome.identity.getAuthToken opens a native consent window, which steals
 * focus, and an MV3 popup is destroyed on focus loss. A real tab can wait.
 */

import { signIn, signOutEverywhere, watchAuth, currentUser } from '../lib/auth.js';
import { isConfigured } from '../lib/firebase.js';
import { MSG } from '../shared/messages.js';

const el = id => document.getElementById(id);

function setStatus(message, kind = '') {
    const status = el('status');
    status.textContent = message;
    status.dataset.kind = kind;
}

/** Turn an SDK error code into something a person can act on. */
function describe(error) {
    const code = error?.code || '';
    if (code.includes('network-request-failed')) {
        return "Can't reach the server. Check your connection and try again.";
    }
    if (code.includes('invalid-credential') || code.includes('credential-already-in-use')) {
        return 'Google rejected the sign-in. Try again, or re-check the OAuth client setup.';
    }
    if (code.includes('operation-not-allowed')) {
        return 'Google sign-in is not enabled for this Firebase project yet.';
    }
    if (code.includes('permission-denied')) {
        return 'The server rejected that write. Are the Firestore security rules deployed?';
    }
    if (code.includes('unavailable')) {
        return "Can't reach Firestore right now. Try again in a moment.";
    }
    if (/did not approve|cancell?ed|user did not/i.test(error?.message || '')) {
        return 'Sign-in was cancelled.';
    }
    return error?.message || 'Something went wrong.';
}

function renderUser(user) {
    el('signedIn').hidden = !user;
    el('signedOut').hidden = Boolean(user);
    el('diagnosticsCard').hidden = !user;
    if (user) el('accountEmail').textContent = user.email ?? user.uid;
}

async function main() {
    if (!isConfigured()) {
        el('setupCard').hidden = false;
        el('setupMessage').textContent =
            'Firebase config is missing from this build. Copy .env.example to ' +
            '.env.local, fill in your project values, then run `npm run build` ' +
            'and reload the extension.';
        return;
    }

    el('accountCard').hidden = false;
    el('signInBtn').addEventListener('click', handleSignIn);
    el('signOutBtn').addEventListener('click', handleSignOut);
    el('workerCheckBtn').addEventListener('click', checkWorker);

    renderUser(await currentUser());
    watchAuth(renderUser);
}

main();
