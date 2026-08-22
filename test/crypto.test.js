import { describe, it, expect } from 'vitest';
import {
    deriveKey, randomSaltB64, encryptJson, decryptJson,
    makeVerifier, checkVerifier, createKdfSetup, validatePassphrase,
    toBase64, fromBase64, WrongPassphraseError, KDF_ALG
} from '../src/lib/crypto.js';

// Keep the work factor low in tests; the real value is 600k.
const FAST = 1000;
const PASS = 'correct horse battery staple';

describe('base64 helpers', () => {
    it('round-trips arbitrary bytes', () => {
        const bytes = crypto.getRandomValues(new Uint8Array(1000));
        expect([...fromBase64(toBase64(bytes))]).toEqual([...bytes]);
    });

    it('handles payloads larger than the argument limit', () => {
        // Sized against the ~150KB per-snippet ceiling the security rules allow.
        // getRandomValues itself caps at 65536 bytes per call, hence the chunking.
        const bytes = new Uint8Array(200_000);
        for (let i = 0; i < bytes.length; i += 65_536) {
            crypto.getRandomValues(bytes.subarray(i, Math.min(i + 65_536, bytes.length)));
        }
        const round = fromBase64(toBase64(bytes));
        expect(round.length).toBe(200_000);
        expect(round[0]).toBe(bytes[0]);
        expect(round[199_999]).toBe(bytes[199_999]);
    });

    it('emits only base64 characters, as the security rules require', () => {
        const b64 = toBase64(crypto.getRandomValues(new Uint8Array(300)));
        expect(b64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    });
});

describe('deriveKey', () => {
    it('produces a non-extractable AES-GCM key', async () => {
        const key = await deriveKey(PASS, randomSaltB64(), FAST);
        expect(key.extractable).toBe(false);
        expect(key.algorithm.name).toBe('AES-GCM');
        // The whole point: raw bytes must never be reachable from JS.
        await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
    });

    it('is deterministic for the same passphrase and salt', async () => {
        const salt = randomSaltB64();
        const a = await deriveKey(PASS, salt, FAST);
        const b = await deriveKey(PASS, salt, FAST);
        const sealed = await encryptJson(a, { v: 1 }, 'id');
        await expect(decryptJson(b, sealed, 'id')).resolves.toEqual({ v: 1 });
    });

    it('gives different keys for different salts', async () => {
        const a = await deriveKey(PASS, randomSaltB64(), FAST);
        const b = await deriveKey(PASS, randomSaltB64(), FAST);
        const sealed = await encryptJson(a, { v: 1 }, 'id');
        await expect(decryptJson(b, sealed, 'id')).rejects.toThrow(WrongPassphraseError);
    });
});

describe('encryptJson / decryptJson', () => {
    it('round-trips an entry payload', async () => {
        const key = await deriveKey(PASS, randomSaltB64(), FAST);
        const payload = { text: 'hunter2\n\tmultiline 🔐', frequency: 42 };
        const sealed = await encryptJson(key, payload, 'entry-id');
        expect(await decryptJson(key, sealed, 'entry-id')).toEqual(payload);
    });

    it('never reuses an IV', async () => {
        const key = await deriveKey(PASS, randomSaltB64(), FAST);
        const ivs = new Set();
        for (let i = 0; i < 50; i++) ivs.add((await encryptJson(key, { i }, 'id')).iv);
        expect(ivs.size).toBe(50);
    });

    it('produces different ciphertext for identical plaintext', async () => {
        const key = await deriveKey(PASS, randomSaltB64(), FAST);
        const a = await encryptJson(key, { text: 'same' }, 'id');
        const b = await encryptJson(key, { text: 'same' }, 'id');
        expect(a.ct).not.toBe(b.ct);
    });

    it('refuses ciphertext moved to a different entry id', async () => {
        const key = await deriveKey(PASS, randomSaltB64(), FAST);
        const sealed = await encryptJson(key, { text: 'secret' }, 'entry-a');
        await expect(decryptJson(key, sealed, 'entry-b')).rejects.toThrow(WrongPassphraseError);
    });

    it('rejects tampered ciphertext rather than returning garbage', async () => {
        const key = await deriveKey(PASS, randomSaltB64(), FAST);
        const sealed = await encryptJson(key, { text: 'secret' }, 'id');
        const bytes = fromBase64(sealed.ct);
        bytes[0] ^= 0xff;
        await expect(decryptJson(key, { ...sealed, ct: toBase64(bytes) }, 'id'))
            .rejects.toThrow(WrongPassphraseError);
    });

    it('does not leak plaintext into the ciphertext', async () => {
        const key = await deriveKey(PASS, randomSaltB64(), FAST);
        const sealed = await encryptJson(key, { text: 'SUPERSECRET', frequency: 9 }, 'id');
        const raw = new TextDecoder().decode(fromBase64(sealed.ct));
        expect(raw).not.toContain('SUPERSECRET');
        expect(raw).not.toContain('frequency');
    });
});

describe('verifier', () => {
    it('accepts the right key and rejects a wrong one', async () => {
        const salt = randomSaltB64();
        const right = await deriveKey(PASS, salt, FAST);
        const wrong = await deriveKey('a different passphrase', salt, FAST);
        const verifier = await makeVerifier(right);
        expect(await checkVerifier(right, verifier)).toBe(true);
        expect(await checkVerifier(wrong, verifier)).toBe(false);
    });

    it('returns false rather than throwing on a malformed blob', async () => {
        const key = await deriveKey(PASS, randomSaltB64(), FAST);
        expect(await checkVerifier(key, { iv: 'AAAA', ct: 'AAAA' })).toBe(false);
    });
});

describe('createKdfSetup', () => {
    it('returns params sufficient to re-derive on another device', async () => {
        const setup = await createKdfSetup(PASS, FAST);
        expect(setup.kdf.alg).toBe(KDF_ALG);
        expect(setup.kdf.iterations).toBe(FAST);
        expect(setup.kdf.salt).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);

        // Simulate a second device: only kdf + verifier travelled.
        const rederived = await deriveKey(PASS, setup.kdf.salt, setup.kdf.iterations);
        expect(await checkVerifier(rederived, setup.verifier)).toBe(true);
    });

    it('produces a unique salt per account', async () => {
        const a = await createKdfSetup(PASS, FAST);
        const b = await createKdfSetup(PASS, FAST);
        expect(a.kdf.salt).not.toBe(b.kdf.salt);
    });
});

describe('validatePassphrase', () => {
    it('rejects short passphrases', () => {
        expect(validatePassphrase('short')).toMatch(/at least 12/);
        expect(validatePassphrase('')).toBeTruthy();
        expect(validatePassphrase(null)).toBeTruthy();
    });

    it('accepts a long one', () => {
        expect(validatePassphrase('a'.repeat(12))).toBeNull();
    });
});
