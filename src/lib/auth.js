/**
 * Google sign-in.
 *
 * Exposes a single signIn()/signOutEverywhere() pair so the underlying
 * mechanism can be swapped (e.g. to launchWebAuthFlow for non-Chrome browsers)
 * without touching callers.
 *
 * Uses chrome.identity.getAuthToken: no redirect round-trip, no PKCE
 * bookkeeping, and Chrome brokers against the profile's Google account. Its
 * cost is being Chrome-only and bound to the profile's account, which is an
 * acceptable trade for a Chrome extension.
 *
 * IMPORTANT: this must NOT be called from the action popup. getAuthToken opens
 * a native consent window, which steals focus, and an MV3 popup is destroyed
 * on focus loss. The options page owns sign-in for that reason.
 */

import {
    GoogleAuthProvider, signInWithCredential, signOut, onAuthStateChanged
} from 'firebase/auth/web-extension';
import { getFirebaseAuth } from './firebase.js';

/** Promisified chrome.identity.getAuthToken. */
function getAuthToken(interactive) {
    return new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive }, token => {
            const error = chrome.runtime.lastError;
            // A non-interactive miss is an expected "not signed in", not a fault.
            if (error && interactive) reject(new Error(error.message));
            else resolve(token || null);
        });
    });
}

function removeCachedToken(token) {
    return new Promise(resolve => chrome.identity.removeCachedAuthToken({ token }, resolve));
}

async function exchange(token) {
    // getAuthToken yields an OAuth2 *access* token, not an id token, hence the
    // null first argument.
    const credential = GoogleAuthProvider.credential(null, token);
    const { user } = await signInWithCredential(getFirebaseAuth(), credential);
    return user;
}

export async function signIn() {
    const token = await getAuthToken(true);
    if (!token) throw new Error('Sign-in was cancelled.');

    try {
        return await exchange(token);
    } catch (error) {
        // Chrome caches these tokens and will hand back an expired one, which
        // surfaces as a baffling auth/invalid-credential. Drop it and retry
        // once against a freshly minted token.
        await removeCachedToken(token);
        const retry = await getAuthToken(true);
        if (!retry) throw error;
        return exchange(retry);
    }
}

export async function signOutEverywhere() {
    const token = await getAuthToken(false);
    if (token) {
        await removeCachedToken(token);
        // Best-effort: revoking the grant means the next sign-in re-prompts
        // rather than silently reusing a stale consent.
        try {
            await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
                { method: 'POST' });
        } catch (error) {
            console.warn('Token revocation failed (continuing):', error);
        }
    }
    await signOut(getFirebaseAuth());
}

/**
 * Resolves with the restored user (or null) once persistence has been read.
 * auth.currentUser is NOT populated synchronously — every entry point must
 * await this before touching Firestore.
 */
export async function currentUser() {
    const auth = getFirebaseAuth();
    if (typeof auth.authStateReady === 'function') {
        await auth.authStateReady();
        return auth.currentUser;
    }
    return new Promise(resolve => {
        const unsubscribe = onAuthStateChanged(auth, user => {
            unsubscribe();
            resolve(user);
        });
    });
}

export function watchAuth(callback) {
    return onAuthStateChanged(getFirebaseAuth(), callback);
}
