/**
 * Options page — owns the OAuth flow.
 *
 * This lives here rather than in the action popup because
 * chrome.identity.getAuthToken opens a native consent window, which steals
 * focus, and an MV3 popup is destroyed on focus loss. A real tab can wait.
 */

import { signIn, signOutEverywhere, watchAuth, currentUser } from '../lib/auth.js';
import { isConfigured } from '../lib/firebase.js';
import { getAccount, createAccount } from '../lib/account.js';
import {
    createKdfSetup, deriveKey, checkVerifier, validatePassphrase
} from '../lib/crypto.js';
import {
    cacheKey, getCachedKey, lockNow, describeLockPolicy,
    DEFAULT_LOCK_POLICY, LOCK_POLICIES
} from '../lib/keycache.js';
import { MSG } from '../shared/messages.js';

const LOCK_POLICY_KEY = 'lockPolicy';

let account = null;   // the users/{uid} doc, or null if never set up
let activeUid = null;

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

function setCryptoStatus(message, kind = '') {
    const status = el('cryptoStatus');
    status.textContent = message;
    status.dataset.kind = kind;
}

async function storedLockPolicy() {
    const { [LOCK_POLICY_KEY]: policy } = await chrome.storage.local.get(LOCK_POLICY_KEY);
    return policy ?? DEFAULT_LOCK_POLICY;
}

/**
 * Three mutually exclusive states: never set up, set up but locked here, or
 * unlocked. Which one shows is derived from the server document plus whether
 * this device currently holds a cached key.
 */
async function renderEncryption(user) {
    const card = el('encryptionCard');
    card.hidden = !user;
    if (!user) return;

    const unlocked = Boolean(await getCachedKey(user.uid));

    el('passphraseSetup').hidden = Boolean(account);
    el('passphraseUnlock').hidden = Boolean(!account || unlocked);
    el('passphraseUnlocked').hidden = !unlocked;

    if (unlocked) {
        const policy = await storedLockPolicy();
        el('lockPolicy').value = policy;
        el('lockPolicyHint').textContent = describeLockPolicy(policy);
    }
}

async function renderUser(user) {
    el('signedIn').hidden = !user;
    el('signedOut').hidden = Boolean(user);
    el('diagnosticsCard').hidden = !user;

    activeUid = user?.uid ?? null;
    account = null;

    if (user) {
        try {
            account = await getAccount(user.uid);
        } catch (error) {
            console.error('Could not read account doc:', error);
            setCryptoStatus(describe(error), 'error');
        }
        el('accountEmail').textContent = user.email ?? user.uid;
    }

    await renderEncryption(user);
}

async function handleSignIn() {
    const button = el('signInBtn');
    button.disabled = true;
    setStatus('Opening Google sign-in…');
    try {
        const user = await signIn();
        setStatus(`Signed in as ${user.email ?? user.uid}.`, 'ok');
    } catch (error) {
        console.error('Sign-in failed:', error);
        setStatus(describe(error), 'error');
    } finally {
        button.disabled = false;
    }
}

async function handleSignOut() {
    const button = el('signOutBtn');
    button.disabled = true;
    setStatus('Signing out…');
    try {
        await signOutEverywhere();
        setStatus('Signed out.', 'ok');
    } catch (error) {
        console.error('Sign-out failed:', error);
        setStatus(describe(error), 'error');
    } finally {
        button.disabled = false;
    }
}

/**
 * Asks the background worker who it thinks is signed in. A cold worker has to
 * restore the session from IndexedDB to answer, which is exactly what sync
 * will depend on later.
 */
async function checkWorker() {
    const button = el('workerCheckBtn');
    const output = el('workerOutput');
    button.disabled = true;
    output.hidden = false;
    output.textContent = 'Waking the worker…';
    try {
        const response = await chrome.runtime.sendMessage({ type: MSG.FLUSH_NOW });
        output.textContent = JSON.stringify(response, null, 2);
    } catch (error) {
        output.textContent = `No response from the worker: ${error.message}`;
    } finally {
        button.disabled = false;
    }
}

// ---- passphrase lifecycle ------------------------------------------------

function setupFormValid() {
    return el('newPassphrase').value.length > 0
        && el('confirmPassphrase').value.length > 0
        && el('ackLoss').checked;
}

function refreshSetupButton() {
    el('enableEncryptionBtn').disabled = !setupFormValid();
}

async function handleEnableEncryption() {
    const passphrase = el('newPassphrase').value;
    const confirm = el('confirmPassphrase').value;

    const problem = validatePassphrase(passphrase);
    if (problem) return setCryptoStatus(problem, 'error');
    if (passphrase !== confirm) return setCryptoStatus("Those don't match.", 'error');

    const button = el('enableEncryptionBtn');
    button.disabled = true;
    setCryptoStatus('Deriving your key… this takes a moment on purpose.');

    try {
        // Deliberately slow: the KDF work factor is what makes a stolen
        // ciphertext expensive to attack offline.
        const { key, kdf, verifier } = await createKdfSetup(passphrase);
        await createAccount(activeUid, { kdf, verifier });
        await cacheKey(key, activeUid, await storedLockPolicy());

        account = await getAccount(activeUid);
        el('newPassphrase').value = '';
        el('confirmPassphrase').value = '';
        el('ackLoss').checked = false;

        await renderEncryption({ uid: activeUid });
        setCryptoStatus('Passphrase set. This device is unlocked.', 'ok');
    } catch (error) {
        console.error('Enabling encryption failed:', error);
        setCryptoStatus(describe(error), 'error');
    } finally {
        refreshSetupButton();
    }
}

async function handleUnlock() {
    const passphrase = el('unlockPassphrase').value;
    if (!passphrase) return setCryptoStatus('Enter your passphrase.', 'error');

    const button = el('unlockBtn');
    button.disabled = true;
    setCryptoStatus('Checking…');

    try {
        const key = await deriveKey(passphrase, account.kdf.salt, account.kdf.iterations);

        // The verifier answers this in one shot, before any entry is touched.
        if (!await checkVerifier(key, account.verifier)) {
            setCryptoStatus('Incorrect passphrase.', 'error');
            return;
        }

        await cacheKey(key, activeUid, await storedLockPolicy());
        el('unlockPassphrase').value = '';
        await renderEncryption({ uid: activeUid });
        setCryptoStatus('Unlocked.', 'ok');
    } catch (error) {
        console.error('Unlock failed:', error);
        setCryptoStatus(describe(error), 'error');
    } finally {
        button.disabled = false;
    }
}

async function handleLockNow() {
    await lockNow();
    await renderEncryption({ uid: activeUid });
    setCryptoStatus('Locked. Your passphrase is needed again to sync.', 'ok');
}

async function handleLockPolicyChange(event) {
    const policy = event.target.value;
    await chrome.storage.local.set({ [LOCK_POLICY_KEY]: policy });
    el('lockPolicyHint').textContent = describeLockPolicy(policy);

    if (policy === LOCK_POLICIES.ALWAYS) {
        // This policy means "never cached", so honour it immediately rather
        // than leaving a key sitting in IndexedDB until the next lock.
        await lockNow();
        await renderEncryption({ uid: activeUid });
        setCryptoStatus('Locked. This device will ask every time from now on.', 'ok');
        return;
    }

    // Re-cache under the new expiry.
    const key = await getCachedKey(activeUid);
    if (key) await cacheKey(key, activeUid, policy);
    setCryptoStatus('Auto-lock updated.', 'ok');
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

    el('enableEncryptionBtn').addEventListener('click', handleEnableEncryption);
    el('unlockBtn').addEventListener('click', handleUnlock);
    el('lockNowBtn').addEventListener('click', handleLockNow);
    el('lockPolicy').addEventListener('change', handleLockPolicyChange);
    ['newPassphrase', 'confirmPassphrase', 'ackLoss'].forEach(id =>
        el(id).addEventListener('input', refreshSetupButton));
    el('unlockPassphrase').addEventListener('keydown', e => {
        if (e.key === 'Enter') handleUnlock();
    });

    renderUser(await currentUser());
    watchAuth(renderUser);
}

main();
