import { describe, it, expect } from 'vitest';
import { syncStatusView } from '../src/lib/syncStatus.js';

describe('syncStatusView', () => {
    it('defaults to synced when nothing is outstanding', () => {
        expect(syncStatusView({})).toEqual({ state: 'synced', title: 'Everything is synced' });
    });

    it('shows a pending count', () => {
        const { state, title } = syncStatusView({ pending: 3, online: true });
        expect(state).toBe('pending');
        expect(title).toBe('3 changes waiting to sync');
    });

    it('singularises a single pending change', () => {
        expect(syncStatusView({ pending: 1, online: true }).title).toBe('1 change waiting to sync');
    });

    it('locked takes priority over everything else', () => {
        const { state } = syncStatusView({
            locked: true, pending: 5, online: false,
            lastError: { fatal: true, code: 'resource-exhausted' }
        });
        expect(state).toBe('locked');
    });

    it('a fatal error means the session needs re-authenticating', () => {
        const { state, title } = syncStatusView({ lastError: { fatal: true, code: 'permission-denied' } });
        expect(state).toBe('error');
        expect(title).toMatch(/sign in again/i);
    });

    it('quota is named specifically, not folded into a generic error', () => {
        const { state, title } = syncStatusView({ lastError: { fatal: false, code: 'resource-exhausted' } });
        expect(state).toBe('error');
        expect(title).toMatch(/quota/i);
    });

    it('offline with pending changes is reassuring, not alarming', () => {
        const { state, title } = syncStatusView({ pending: 2, online: false });
        expect(state).toBe('pending');           // not 'error' — this is expected and recoverable
        expect(title).toMatch(/^Offline\./);
        expect(title).toContain('2 changes');
    });

    it('offline with nothing pending does not claim to be offline', () => {
        // Being offline only matters when there's something waiting to go out.
        expect(syncStatusView({ pending: 0, online: false })).toEqual({
            state: 'synced', title: 'Everything is synced'
        });
    });

    it('a non-fatal, non-quota error while online is a generic but distinct error state', () => {
        const { state, title } = syncStatusView({
            lastError: { fatal: false, code: 'unavailable' }, online: true
        });
        expect(state).toBe('error');
        expect(title).toMatch(/server/i);
    });

    it('never returns the literal phrase "sync failed"', () => {
        const cases = [
            {}, { pending: 1 }, { locked: true }, { pending: 3, online: false },
            { lastError: { fatal: true } }, { lastError: { code: 'resource-exhausted' } },
            { lastError: { code: 'unavailable' } }
        ];
        for (const status of cases) {
            expect(syncStatusView(status).title.toLowerCase()).not.toContain('sync failed');
        }
    });
});
