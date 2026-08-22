/**
 * Caches the derived encryption key between popup opens.
 *
 * The key is stored in IndexedDB as a CryptoKey *object*. The structured clone
 * algorithm supports CryptoKey, so a non-extractable key round-trips through
 * storage without its raw bytes ever being reachable from JavaScript. That is
 * strictly stronger than serialising key material to chrome.storage, which
 * would require making the key extractable in the first place.
 *
 * IndexedDB is shared across extension contexts at the chrome-extension://
 * origin, so the background worker gets the key for free — which is what lets
 * sync run while no popup is open.
 *
 * The tradeoff: a cached key survives browser restarts, so someone with access
 * to the Chrome profile could drive the extension into decrypting. Auto-lock
 * bounds that window, and "Lock now" closes it immediately.
 */

const DB_NAME = 'quickpaste-keys';
const DB_VERSION = 1;
const STORE = 'keys';
const RECORD_ID = 'current';

const DAY_MS = 24 * 60 * 60 * 1000;

export const LOCK_POLICIES = {
    /** Default: convenient, and bounded. */
    WEEK: 'week',
    /** Cleared on browser startup. */
    SESSION: 'session',
    /** Never cached. Most secure; disables background sync. */
    ALWAYS: 'always'
};

export const DEFAULT_LOCK_POLICY = LOCK_POLICIES.WEEK;

export function describeLockPolicy(policy) {
    switch (policy) {
        case LOCK_POLICIES.SESSION:
            return 'Ask again each time Chrome restarts.';
        case LOCK_POLICIES.ALWAYS:
            return 'Ask every time. Background syncing is disabled while locked.';
        default:
            return 'Stay unlocked for 7 days on this device.';
    }
}

function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function transact(db, mode, run) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = run(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(request?.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    });
}

async function read() {
    const db = await openDb();
    try {
        return await transact(db, 'readonly', store => store.get(RECORD_ID));
    } finally {
        db.close();
    }
}

async function write(record) {
    const db = await openDb();
    try {
        await transact(db, 'readwrite', store => store.put(record, RECORD_ID));
    } finally {
        db.close();
    }
}

/** Forget the cached key. Called by "Lock now", sign-out, and policy changes. */
export async function lockNow() {
    const db = await openDb();
    try {
        await transact(db, 'readwrite', store => store.delete(RECORD_ID));
    } finally {
        db.close();
    }
}

export async function cacheKey(key, uid, policy = DEFAULT_LOCK_POLICY) {
    if (policy === LOCK_POLICIES.ALWAYS) return;   // nothing is ever persisted
    await write({
        key,
        uid,
        policy,
        // SESSION has no clock of its own; it's cleared by onStartup instead.
        lockAfter: policy === LOCK_POLICIES.WEEK ? Date.now() + 7 * DAY_MS : null
    });
}

/**
 * The cached key for `uid`, or null if absent, expired, or belonging to a
 * different account. A stale record is deleted rather than merely ignored.
 */
export async function getCachedKey(uid) {
    const record = await read().catch(() => null);
    if (!record) return null;

    const staleAccount = record.uid !== uid;
    const expired = record.lockAfter != null && Date.now() > record.lockAfter;

    if (staleAccount || expired) {
        await lockNow();
        return null;
    }
    return record.key;
}

export async function isUnlocked(uid) {
    return (await getCachedKey(uid)) !== null;
}

/** Honour the SESSION policy. Wired to chrome.runtime.onStartup. */
export async function purgeIfSessionScoped() {
    const record = await read().catch(() => null);
    if (record && record.policy === LOCK_POLICIES.SESSION) await lockNow();
}
