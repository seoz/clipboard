/**
 * Firebase singletons, shared by the popup, the options page and the
 * background service worker.
 *
 * Two deliberate entry-point choices:
 *
 * - `firebase/auth/web-extension` rather than `firebase/auth`. The default
 *   entry touches `document` at module scope for its popup/redirect machinery
 *   and throws inside a service worker. The web-extension build exists for
 *   MV3 and defaults to IndexedDB persistence, which is available in both
 *   extension pages and service workers — so the session survives popup
 *   teardown, worker death and browser restart.
 *
 * - `firebase/firestore/lite` rather than the full SDK. The full SDK's
 *   WebChannel transport is unreliable in extension and worker contexts, we
 *   want no realtime listeners (a popup lives for seconds), and its offline
 *   persistence would fight the dirty queue we maintain ourselves. Lite is
 *   plain fetch over getDocs/setDoc/writeBatch — exactly the primitive needed.
 */

import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, connectAuthEmulator } from 'firebase/auth/web-extension';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore/lite';
import { firebaseConfig, useEmulator, emulator, isConfigured } from './config.js';

let cached = null;

function init() {
    if (cached) return cached;

    if (!isConfigured()) {
        throw new Error(
            'Firebase is not configured. Copy .env.example to .env.local, fill in ' +
            'the project values, and rebuild.'
        );
    }

    const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
    const auth = getAuth(app);
    const db = getFirestore(app);

    if (useEmulator) {
        connectAuthEmulator(auth, emulator.authUrl, { disableWarnings: true });
        connectFirestoreEmulator(db, emulator.firestoreHost, emulator.firestorePort);
    }

    cached = { app, auth, db };
    return cached;
}

export const getFirebaseAuth = () => init().auth;
export const getDb = () => init().db;
export { isConfigured };
