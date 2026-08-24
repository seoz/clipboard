/**
 * Firestore security rules tests.
 *
 * These are the highest-value automated tests in the project: the rules are the
 * only server-side enforcement, and they're pure logic with no DOM and no
 * Chrome APIs.
 *
 * Requires the Firestore emulator, which requires a Java runtime. Without one
 * the whole suite skips rather than failing, so `npm test` stays green on a
 * machine that can't run it. Run the emulator with:
 *
 *     npm run emulators
 */
import {
    initializeTestEnvironment, assertFails, assertSucceeds
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, deleteDoc } from 'firebase/firestore';
import { readFileSync } from 'node:fs';
import { beforeAll, afterAll, beforeEach, describe, it } from 'vitest';

const HOST = '127.0.0.1';
const PORT = 8080;

const reachable = await fetch(`http://${HOST}:${PORT}`).then(() => true).catch(() => false);
const when = reachable ? describe : describe.skip;

if (!reachable) {
    console.warn(
        `\n[rules] Firestore emulator not reachable at ${HOST}:${PORT} — skipping rules tests.` +
        '\n[rules] Start it with `npm run emulators` (needs a Java runtime).\n'
    );
}

const ALICE = 'alice-uid';
const BOB = 'bob-uid';

const b64 = n => 'A'.repeat(n);

const validKdf = { alg: 'PBKDF2-SHA256', iterations: 600000, salt: b64(24) };
const validVerifier = { iv: b64(16), ct: b64(44) };
const validAccount = () => ({
    schemaVersion: 2, kdf: validKdf, verifier: validVerifier,
    createdAt: 1000, updatedAt: 1000
});
const validEntry = (over = {}) => ({
    v: 1, ct: b64(64), iv: b64(16), order: 1000,
    createdAt: 1000, updatedAt: 1000, deletedAt: null, ...over
});

let env;

when('firestore rules', () => {
    beforeAll(async () => {
        env = await initializeTestEnvironment({
            projectId: 'quickpaste-rules-test',
            firestore: { host: HOST, port: PORT, rules: readFileSync('firestore.rules', 'utf8') }
        });
    });

    afterAll(async () => { await env?.cleanup(); });
    beforeEach(async () => { await env.clearFirestore(); });

    const asAlice = () => env.authenticatedContext(ALICE).firestore();
    const asBob = () => env.authenticatedContext(BOB).firestore();
    const asAnon = () => env.unauthenticatedContext().firestore();

    const accountRef = (db, uid = ALICE) => doc(db, 'users', uid);
    const entryRef = (db, id = 'entry-0001', uid = ALICE) =>
        doc(db, 'users', uid, 'entries', id);

    const seed = async (path, data) => {
        await env.withSecurityRulesDisabled(async ctx => {
            await setDoc(doc(ctx.firestore(), ...path), data);
        });
    };

    describe('ownership', () => {
        it('lets a user create their own account doc', async () => {
            await assertSucceeds(setDoc(accountRef(asAlice()), validAccount()));
        });

        it('refuses another user’s account doc', async () => {
            await assertFails(setDoc(accountRef(asBob(), ALICE), validAccount()));
        });

        it('refuses anonymous access', async () => {
            await assertFails(setDoc(accountRef(asAnon()), validAccount()));
            await assertFails(getDoc(accountRef(asAnon())));
        });

        it('refuses another user’s entries', async () => {
            await seed(['users', ALICE, 'entries', 'entry-0001'], validEntry());
            await assertFails(getDoc(entryRef(asBob(), 'entry-0001', ALICE)));
            await assertFails(setDoc(entryRef(asBob(), 'entry-0001', ALICE), validEntry()));
        });
    });

    // Over-denial is the failure mode that would break sync while looking like
    // a network problem, so the permitted paths are asserted as carefully as
    // the forbidden ones.
    describe('permitted paths', () => {
        it('lets a user read their own account and entries', async () => {
            await seed(['users', ALICE], validAccount());
            await seed(['users', ALICE, 'entries', 'entry-0001'], validEntry());
            await assertSucceeds(getDoc(accountRef(asAlice())));
            await assertSucceeds(getDoc(entryRef(asAlice())));
        });

        it('allows a normal edit that moves updatedAt forward', async () => {
            await seed(['users', ALICE, 'entries', 'entry-0001'], validEntry({ updatedAt: 1000 }));
            await assertSucceeds(setDoc(entryRef(asAlice()),
                validEntry({ ct: b64(128), updatedAt: 2000 })));
        });

        it('allows tombstoning a live entry', async () => {
            await seed(['users', ALICE, 'entries', 'entry-0001'], validEntry({ updatedAt: 1000 }));
            await assertSucceeds(setDoc(entryRef(asAlice()),
                validEntry({ deletedAt: 2000, updatedAt: 2000 })));
        });

        it('allows a reorder that changes only order', async () => {
            await seed(['users', ALICE, 'entries', 'entry-0001'], validEntry({ updatedAt: 1000 }));
            await assertSucceeds(setDoc(entryRef(asAlice()),
                validEntry({ order: 1500.5, updatedAt: 2000 })));
        });

        it('accepts a uuid-shaped entry id, as the client actually generates', async () => {
            await assertSucceeds(setDoc(
                entryRef(asAlice(), '3f2504e0-4f89-11d3-9a0c-0305e82c3301'), validEntry()));
        });

        it('accepts ciphertext at the size ceiling', async () => {
            await assertSucceeds(setDoc(entryRef(asAlice()), validEntry({ ct: b64(200_000) })));
        });

        it('accepts a negative order, which orderBetween can produce', async () => {
            await assertSucceeds(setDoc(entryRef(asAlice()), validEntry({ order: -1000 })));
        });
    });

    describe('account deletion (danger zone)', () => {
        it('lets the owner delete their own account doc', async () => {
            await seed(['users', ALICE], validAccount());
            await assertSucceeds(deleteDoc(accountRef(asAlice())));
        });

        it('refuses another user deleting it', async () => {
            await seed(['users', ALICE], validAccount());
            await assertFails(deleteDoc(accountRef(asBob(), ALICE)));
        });
    });

    describe('account shape', () => {
        it('refuses an unexpected field', async () => {
            await assertFails(setDoc(accountRef(asAlice()),
                { ...validAccount(), plaintextPassphrase: 'oops' }));
        });

        it('refuses a weakened KDF', async () => {
            await assertFails(setDoc(accountRef(asAlice()),
                { ...validAccount(), kdf: { ...validKdf, iterations: 1 } }));
        });

        it('refuses a non-base64 salt', async () => {
            await assertFails(setDoc(accountRef(asAlice()),
                { ...validAccount(), kdf: { ...validKdf, salt: 'not base64!!' } }));
        });

        it('allows a passphrase rotation that moves updatedAt forward', async () => {
            await seed(['users', ALICE], validAccount());
            await assertSucceeds(setDoc(accountRef(asAlice()),
                { ...validAccount(), kdf: { ...validKdf, salt: b64(24) }, updatedAt: 2000 }));
        });

        it('refuses a rotation that rewinds updatedAt', async () => {
            await seed(['users', ALICE], validAccount());
            await assertFails(setDoc(accountRef(asAlice()),
                { ...validAccount(), updatedAt: 500 }));
        });

        it('refuses a rotation that rewrites createdAt', async () => {
            await seed(['users', ALICE], validAccount());
            await assertFails(setDoc(accountRef(asAlice()),
                { ...validAccount(), createdAt: 5, updatedAt: 2000 }));
        });
    });

    describe('entry shape', () => {
        it('accepts a well-formed entry', async () => {
            await assertSucceeds(setDoc(entryRef(asAlice()), validEntry()));
        });

        it('refuses plaintext smuggled in an extra field', async () => {
            await assertFails(setDoc(entryRef(asAlice()),
                validEntry({ text: 'this should never be readable' })));
        });

        it('refuses ciphertext over the size ceiling', async () => {
            await assertFails(setDoc(entryRef(asAlice()),
                validEntry({ ct: b64(200_001) })));
        });

        it('refuses a malformed id', async () => {
            await assertFails(setDoc(entryRef(asAlice(), 'short'), validEntry()));
        });
    });

    describe('sync invariants', () => {
        it('refuses a rewound updatedAt', async () => {
            await seed(['users', ALICE, 'entries', 'entry-0001'], validEntry({ updatedAt: 5000 }));
            await assertFails(setDoc(entryRef(asAlice()), validEntry({ updatedAt: 4000 })));
        });

        it('allows an idempotent re-push at the same updatedAt', async () => {
            await seed(['users', ALICE, 'entries', 'entry-0001'], validEntry({ updatedAt: 5000 }));
            await assertSucceeds(setDoc(entryRef(asAlice()), validEntry({ updatedAt: 5000 })));
        });

        it('refuses un-deleting a tombstone', async () => {
            await seed(['users', ALICE, 'entries', 'entry-0001'],
                validEntry({ deletedAt: 4000, updatedAt: 4000 }));
            await assertFails(setDoc(entryRef(asAlice()),
                validEntry({ deletedAt: null, updatedAt: 5000 })));
        });

        it('refuses hard-deleting a live entry', async () => {
            await seed(['users', ALICE, 'entries', 'entry-0001'], validEntry());
            await assertFails(deleteDoc(entryRef(asAlice())));
        });

        it('allows garbage-collecting a tombstone', async () => {
            await seed(['users', ALICE, 'entries', 'entry-0001'],
                validEntry({ deletedAt: 4000 }));
            await assertSucceeds(deleteDoc(entryRef(asAlice())));
        });
    });
});
