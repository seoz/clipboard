/**
 * End-to-end encryption primitives. WebCrypto only, no dependencies.
 *
 * The server must never be able to read a snippet, so entry contents are
 * encrypted on the device under a key derived from a passphrase that never
 * leaves it. Losing the passphrase means losing the cloud copy — there is no
 * recovery path by design, and the UI has to say so plainly.
 *
 * DOM-free: the service worker encrypts too.
 */

/** Plaintext of the verifier blob; its only job is to be recognisable. */
const VERIFIER_PLAINTEXT = 'quickpaste-verify-v1';

/** Additional authenticated data for the verifier record. */
const VERIFIER_AAD = 'verifier';

export const KDF_ALG = 'PBKDF2-SHA256';

/**
 * OWASP's 2023 floor for PBKDF2-SHA256. Costs a few hundred ms, which is
 * acceptable at unlock and is also the rate limiter on guessing. Recorded
 * per user in Firestore so it can be raised later without stranding accounts.
 */
export const DEFAULT_ITERATIONS = Number(import.meta.env?.VITE_PBKDF2_ITERATIONS) || 600000;

const SALT_BYTES = 16;
const IV_BYTES = 12;

export const MIN_PASSPHRASE_LENGTH = 12;

/** Thrown when decryption fails because the key is wrong. */
export class WrongPassphraseError extends Error {
    constructor() {
        super('Incorrect passphrase.');
        this.name = 'WrongPassphraseError';
    }
}

// ---- encoding helpers ----------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64(bytes) {
    let binary = '';
    const view = new Uint8Array(bytes);
    // Chunked to avoid blowing the argument limit on large ciphertexts.
    for (let i = 0; i < view.length; i += 0x8000) {
        binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

export function fromBase64(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

// ---- key derivation ------------------------------------------------------

export function randomSaltB64() {
    return toBase64(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
}

/**
 * Derive the AES-GCM key from a passphrase.
 *
 * The result is deliberately NON-EXTRACTABLE: it can encrypt and decrypt, but
 * its raw bytes are never reachable from JavaScript, even after being cached
 * in IndexedDB. See keycache.js.
 */
export async function deriveKey(passphrase, saltB64, iterations = DEFAULT_ITERATIONS) {
    const material = await crypto.subtle.importKey(
        'raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']
    );

    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: fromBase64(saltB64), iterations, hash: 'SHA-256' },
        material,
        { name: 'AES-GCM', length: 256 },
        false,                       // extractable: false
        ['encrypt', 'decrypt']
    );
}

// ---- encryption ----------------------------------------------------------

/**
 * Encrypt a JSON-serialisable value.
 *
 * `aad` binds the ciphertext to the record it belongs to (we pass the entry
 * id), so ciphertext can't be moved between documents by anyone with write
 * access. A fresh IV is generated per call — never reused.
 */
export async function encryptJson(key, value, aad) {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
        key,
        encoder.encode(JSON.stringify(value))
    );
    return { iv: toBase64(iv), ct: toBase64(ciphertext) };
}

export async function decryptJson(key, record, aad) {
    let plaintext;
    try {
        plaintext = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: fromBase64(record.iv), additionalData: encoder.encode(aad) },
            key,
            fromBase64(record.ct)
        );
    } catch {
        // AES-GCM's auth tag makes this unambiguous: wrong key, wrong AAD, or
        // tampered ciphertext. All three are "we can't read this", never
        // "here's some garbage".
        throw new WrongPassphraseError();
    }
    return JSON.parse(decoder.decode(plaintext));
}

// ---- verifier ------------------------------------------------------------

/**
 * A small known-plaintext blob stored alongside the KDF params.
 *
 * Without it, a wrong passphrase would only reveal itself as every entry
 * failing to decrypt, one by one. With it, unlock is a single check with an
 * unambiguous answer, before any entry is touched.
 */
export function makeVerifier(key) {
    return encryptJson(key, VERIFIER_PLAINTEXT, VERIFIER_AAD);
}

export async function checkVerifier(key, verifier) {
    try {
        return await decryptJson(key, verifier, VERIFIER_AAD) === VERIFIER_PLAINTEXT;
    } catch {
        return false;
    }
}

/** Everything needed to re-derive this user's key on another device. */
export async function createKdfSetup(passphrase, iterations = DEFAULT_ITERATIONS) {
    const salt = randomSaltB64();
    const key = await deriveKey(passphrase, salt, iterations);
    return {
        key,
        kdf: { alg: KDF_ALG, iterations, salt },
        verifier: await makeVerifier(key)
    };
}

export function validatePassphrase(passphrase) {
    if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
        return `Use at least ${MIN_PASSPHRASE_LENGTH} characters.`;
    }
    return null;
}
