/** Message types exchanged between the popup, options page and worker. */
export const MSG = {
    SYNC_REQUEST: 'SYNC_REQUEST',  // fire-and-forget: something changed locally
    FLUSH_NOW: 'FLUSH_NOW',        // awaited: push immediately
    AUTH_STATUS: 'AUTH_STATUS',    // who is signed in, if anyone
    SYNC_STATUS: 'SYNC_STATUS'     // how many changes are waiting to upload
};
