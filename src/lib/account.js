/**
 * The users/{uid} document: KDF parameters and the verifier blob.
 *
 * Nothing here is secret. The salt must be fetchable on a brand-new device
 * before any local state exists, which is exactly why it lives server-side.
 * The verifier is a known plaintext sealed under the user's key — useless
 * without the passphrase, and the thing that makes a wrong passphrase fail
 * instantly instead of after a hundred failed entry decryptions.
 */

import { doc, getDoc, setDoc } from 'firebase/firestore/lite';
import { getDb } from './firebase.js';
import { SCHEMA_VERSION } from './model.js';

const userRef = uid => doc(getDb(), 'users', uid);

/** @returns the account document, or null if sync was never set up. */
export async function getAccount(uid) {
    const snapshot = await getDoc(userRef(uid));
    return snapshot.exists() ? snapshot.data() : null;
}

/**
 * First-time setup. The field set is exactly what the security rules permit —
 * they use hasOnly(), so an extra field is rejected outright.
 */
export async function createAccount(uid, { kdf, verifier }) {
    const now = Date.now();
    await setDoc(userRef(uid), {
        schemaVersion: SCHEMA_VERSION,
        kdf,
        verifier,
        createdAt: now,
        updatedAt: now
    });
}

/**
 * Rotate salt and verifier on a passphrase change.
 *
 * createdAt is carried through unchanged because the rules pin it, and
 * updatedAt must strictly increase — a client that could rewind it could
 * replay an old verifier.
 */
export async function rotateAccount(uid, { kdf, verifier }, existing) {
    await setDoc(userRef(uid), {
        schemaVersion: SCHEMA_VERSION,
        kdf,
        verifier,
        createdAt: existing.createdAt,
        updatedAt: Math.max(Date.now(), existing.updatedAt + 1)
    });
}
