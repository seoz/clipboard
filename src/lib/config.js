/**
 * Firebase client configuration.
 *
 * These values are PUBLIC IDENTIFIERS, not secrets. A Firebase "API key" is a
 * project routing identifier that authorizes nothing on its own — every
 * Firebase web app ships them in client JavaScript, and an extension is a zip
 * anyone can unpack. What actually protects user data here is, in order:
 *
 *   1. Firebase Auth — a request must carry a valid Google-issued token.
 *   2. Firestore Security Rules — that token's uid must match the document path.
 *   3. End-to-end encryption — the server only ever holds ciphertext, so even a
 *      total compromise of the Firebase project yields nothing readable.
 *
 * They are routed through import.meta.env so dev, prod and the local emulator
 * are switchable without a code edit — not for secrecy.
 */

export const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID
};

export const useEmulator = import.meta.env.VITE_USE_FIREBASE_EMULATOR === 'true';

export const emulator = {
    authUrl: import.meta.env.VITE_EMULATOR_AUTH_URL || 'http://127.0.0.1:9099',
    firestoreHost: import.meta.env.VITE_EMULATOR_FIRESTORE_HOST || '127.0.0.1',
    firestorePort: Number(import.meta.env.VITE_EMULATOR_FIRESTORE_PORT || 8080)
};

/** True once the build has real config baked in. */
export function isConfigured() {
    return Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId);
}
