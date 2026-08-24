/** Message types exchanged between the popup, options page and worker. */
export const MSG = {
    SYNC_REQUEST: 'SYNC_REQUEST',  // fire-and-forget: something changed locally
    FLUSH_NOW: 'FLUSH_NOW',        // awaited: push immediately
    AUTH_STATUS: 'AUTH_STATUS',    // who is signed in, if anyone
    SYNC_STATUS: 'SYNC_STATUS',    // how many changes are waiting to upload
    VERIFY_SYNC: 'VERIFY_SYNC',    // read the server back and compare with local
    PREVIEW_MERGE: 'PREVIEW_MERGE', // build a first-merge plan without applying it
    APPLY_MERGE: 'APPLY_MERGE',     // commit a plan the user has already seen
    ROTATE_PASSPHRASE: 'ROTATE_PASSPHRASE' // re-encrypt everything under a new passphrase
};
