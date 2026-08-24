/**
 * Turns raw sync status into one specific state, checked in priority order.
 * Never a generic "sync failed" — each branch names something the user can
 * actually understand or act on.
 *
 * Pure and DOM-free so the decision matrix is unit-testable on its own,
 * separately from how the popup happens to render it.
 */
export function syncStatusView({ pending = 0, locked = false, lastError = null, online = true }) {
    if (locked) {
        return { state: 'locked', title: 'Locked — open Options to unlock and resume syncing.' };
    }

    if (lastError?.fatal) {
        return { state: 'error', title: 'Sign-in expired. Open Options to sign in again.' };
    }

    if (lastError?.code === 'resource-exhausted') {
        return { state: 'error', title: 'Sync paused — storage quota reached.' };
    }

    if (pending > 0 && !online) {
        // Not an error: this is the expected, recoverable shape of being
        // offline. Local editing is unaffected either way.
        return {
            state: 'pending',
            title: `Offline. ${pending} change${pending === 1 ? '' : 's'} will sync when you're back.`
        };
    }

    if (lastError) {
        return { state: 'error', title: "Couldn't reach the server. Open Options for details." };
    }

    if (pending > 0) {
        return { state: 'pending', title: `${pending} change${pending === 1 ? '' : 's'} waiting to sync` };
    }

    return { state: 'synced', title: 'Everything is synced' };
}
