import { loadState, saveState } from '../lib/store.js';
import { MSG } from '../shared/messages.js';
import {
    newEntry, normalizeEntry, migrateToV2, isLive, touch,
    orderBetween, renumber, SCHEMA_VERSION
} from '../lib/model.js';

/** Rows rendered before the "Show more" button takes over. */
const RENDER_LIMIT = 200;

/** Cap for signed-out, local-only use. Signing in lifts it (Phase 5). */
const LOCAL_MAX_TEXTS = 20;

const SEARCH_DEBOUNCE_MS = 120;

class TextManager {
    constructor() {
        this.texts = [];
        this.selectedIndex = -1;
        this.editingId = null;
        this.sortMode = 'manual'; // 'manual' or 'frequency'
        this.searchTerm = '';
        this.renderLimit = RENDER_LIMIT;
        this.syncEnabled = false; // set once sign-in lands (Phase 1)
        this.searchDebounce = null;
        this.rendered = [];       // entries currently in the DOM, in render order
        this.init();
    }

    /** Signed-out users keep the original 20-item cap; sync lifts it. */
    get maxTexts() {
        return this.syncEnabled ? Infinity : LOCAL_MAX_TEXTS;
    }

    async init() {
        const state = await loadState();
        this.texts = state.texts;
        this.sortMode = state.sortMode;

        this.setupEventListeners();
        this.setupKeyboardNavigation();
        this.renderTexts();

        document.getElementById('sortSelect').value = this.sortMode;

        // Non-blocking: the list must render whether or not sync is reachable.
        this.refreshSyncStatus();
    }

    /**
     * Persist locally and, if anything actually changed, ask the worker to
     * upload it. The request is fire-and-forget: this must not delay the UI,
     * and the popup is often about to close itself.
     */
    async save(dirtyIds = []) {
        await saveState({ texts: this.texts, sortMode: this.sortMode, dirtyIds });
        if (dirtyIds.length) this.requestSync();
    }

    /**
     * Reflect sync state in the header. Stays hidden entirely when signed out,
     * so a local-only user never sees sync affordances they didn't ask for.
     */
    async refreshSyncStatus() {
        const button = document.getElementById('syncBtn');
        try {
            const auth = await chrome.runtime.sendMessage({ type: MSG.AUTH_STATUS });
            if (!auth?.signedIn) return;

            this.syncEnabled = true;
            button.hidden = false;

            const { pending = 0 } = await chrome.runtime.sendMessage({ type: MSG.SYNC_STATUS }) ?? {};
            button.dataset.state = pending > 0 ? 'pending' : 'synced';
            button.title = pending > 0
                ? `${pending} change${pending === 1 ? '' : 's'} waiting to sync`
                : 'Everything is synced';
        } catch {
            // No worker, or it's still waking. Local editing is unaffected.
            button.hidden = true;
        }
    }

    requestSync() {
        // No await, and errors are swallowed: a missing worker must never
        // break a local edit.
        chrome.runtime.sendMessage({ type: MSG.SYNC_REQUEST }).catch(() => {});
    }

    // ---- derived views ------------------------------------------------

    /** Every entry that hasn't been tombstoned, in the current sort order. */
    orderedLive() {
        const live = this.texts.filter(isLive);
        if (this.sortMode === 'frequency') {
            return live.sort((a, b) =>
                b.frequency - a.frequency || b.timestamp - a.timestamp);
        }
        return live.sort((a, b) => a.order - b.order);
    }

    /**
     * What the list should show: live, sorted, and matching the search box.
     * Sorting a derived copy rather than `this.texts` is what lets manual
     * order survive a round trip through frequency mode.
     */
    visibleTexts() {
        const ordered = this.orderedLive();
        if (!this.searchTerm) return ordered;
        const term = this.searchTerm.toLowerCase();
        return ordered.filter(entry => entry.text.toLowerCase().includes(term));
    }

    byId(id) {
        return this.texts.find(entry => entry.id === id);
    }

    // ---- import / export ----------------------------------------------

    async exportTexts() {
        const entries = this.texts.filter(isLive);
        if (entries.length === 0) {
            this.showToast('No texts to export', 'error');
            return;
        }

        // Ids are kept so that re-importing a backup is idempotent rather
        // than duplicating every entry.
        const payload = {
            version: SCHEMA_VERSION,
            exportedAt: new Date().toISOString(),
            entries
        };

        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'clipboard-backup.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    async importTexts(event) {
        const file = event.target.files[0];
        if (!file) return;

        try {
            const parsed = JSON.parse(await file.text());

            // Bare array is the legacy export format; {version, entries} is current.
            const rawList = Array.isArray(parsed) ? parsed : parsed?.entries;
            if (!Array.isArray(rawList)) {
                throw new Error('file must contain an array of texts');
            }

            const existingIds = new Set(this.texts.map(entry => entry.id));
            const maxOrder = this.texts.reduce((max, e) => Math.max(max, e.order), 0);

            const imported = [];
            let added = 0;
            let skipped = 0;
            let truncated = false;

            migrateToV2(rawList).forEach((entry, i) => {
                if (existingIds.has(entry.id)) { skipped++; return; }
                if (this.texts.filter(isLive).length >= this.maxTexts) { truncated = true; return; }
                entry.order = maxOrder + (i + 1) * 1000;
                this.texts.push(entry);
                existingIds.add(entry.id);
                imported.push(entry.id);
                added++;
            });

            await this.save(imported);
            this.renderTexts();

            if (truncated) {
                this.showToast(`Imported ${added}. Storage full at ${this.maxTexts}.`, 'error');
            } else if (added > 0) {
                this.showToast(`Imported ${added} text${added === 1 ? '' : 's'}` +
                    (skipped ? ` (${skipped} already present)` : ''));
            } else if (skipped > 0) {
                this.showToast('Already up to date — nothing new to import');
            } else {
                this.showToast('No valid texts found in file', 'error');
            }
        } catch (error) {
            console.error('Import error:', error);
            this.showToast('Could not import: ' + error.message, 'error');
        } finally {
            event.target.value = '';
        }
    }

    // ---- events --------------------------------------------------------

    setupEventListeners() {
        document.getElementById('addTextBtn').addEventListener('click', () => this.openModal());
        document.getElementById('syncBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());
        document.getElementById('exportBtn').addEventListener('click', () => this.exportTexts());
        document.getElementById('importBtn').addEventListener('click', () => {
            document.getElementById('fileInput').click();
        });
        document.getElementById('fileInput').addEventListener('change', e => this.importTexts(e));

        document.getElementById('sortSelect').addEventListener('change', async e => {
            this.sortMode = e.target.value === 'frequency' ? 'frequency' : 'manual';
            this.selectedIndex = -1;
            await this.save();   // a local view preference; nothing to upload
            this.renderTexts();
        });

        // Filter the model, not the DOM, so search reaches entries that the
        // render limit is currently holding back.
        document.getElementById('searchInput').addEventListener('input', e => {
            const value = e.target.value;
            clearTimeout(this.searchDebounce);
            this.searchDebounce = setTimeout(() => {
                this.searchTerm = value.trim();
                this.selectedIndex = -1;
                this.renderLimit = RENDER_LIMIT;
                this.renderTexts();
            }, SEARCH_DEBOUNCE_MS);
        });

        document.getElementById('closeModal').addEventListener('click', () => this.closeModal());
        document.getElementById('cancelBtn').addEventListener('click', () => this.closeModal());
        document.getElementById('saveTextBtn').addEventListener('click', () => this.saveText());

        document.getElementById('textModal').addEventListener('click', e => {
            if (e.target.id === 'textModal') this.closeModal();
        });

        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') this.closeModal();
        });

        this.setupContainerDelegation();
    }

    /**
     * One listener per event type on the container instead of five per row.
     * Keeps listener count flat as the entry count grows past the old cap.
     */
    setupContainerDelegation() {
        const container = document.getElementById('textsContainer');

        container.addEventListener('click', e => {
            const showMore = e.target.closest('#showMoreBtn');
            if (showMore) {
                this.renderLimit += RENDER_LIMIT;
                this.renderTexts();
                return;
            }

            const row = e.target.closest('.text-item');
            if (!row) return;

            const actionBtn = e.target.closest('.action-btn');
            if (actionBtn) {
                const { action } = actionBtn.dataset;
                if (action === 'copy') this.copyToClipboard(row.dataset.id);
                else if (action === 'edit') this.openModal(row.dataset.id);
                else if (action === 'delete') this.deleteText(row.dataset.id);
                return;
            }

            if (!e.target.closest('.drag-handle')) {
                this.copyToClipboard(row.dataset.id);
            }
        });

        container.addEventListener('dragstart', e => {
            const row = e.target.closest('.text-item');
            if (!row || this.sortMode !== 'manual') return;
            e.dataTransfer.setData('text/plain', row.dataset.id);
            row.classList.add('dragging');
        });

        container.addEventListener('dragend', e => {
            e.target.closest('.text-item')?.classList.remove('dragging');
            container.querySelectorAll('.drag-over')
                .forEach(item => item.classList.remove('drag-over'));
        });

        container.addEventListener('dragover', e => {
            if (this.sortMode !== 'manual') return;
            const row = e.target.closest('.text-item');
            if (!row) return;
            e.preventDefault();
            row.classList.add('drag-over');
        });

        container.addEventListener('dragleave', e => {
            e.target.closest('.text-item')?.classList.remove('drag-over');
        });

        container.addEventListener('drop', e => {
            const row = e.target.closest('.text-item');
            if (!row) return;
            e.preventDefault();
            row.classList.remove('drag-over');
            const draggedId = e.dataTransfer.getData('text/plain');
            if (draggedId && draggedId !== row.dataset.id) {
                this.reorderById(draggedId, row.dataset.id);
            }
        });
    }

    setupKeyboardNavigation() {
        document.addEventListener('keydown', e => {
            if (document.getElementById('textModal').style.display === 'block') return;
            if (this.rendered.length === 0) return;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.selectedIndex = (this.selectedIndex + 1) % this.rendered.length;
                this.updateSelectionVisuals();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.selectedIndex = this.selectedIndex <= 0
                    ? this.rendered.length - 1
                    : this.selectedIndex - 1;
                this.updateSelectionVisuals();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const entry = this.rendered[this.selectedIndex];
                if (entry) this.copyToClipboard(entry.id);
            }
        });
    }

    updateSelectionVisuals() {
        const container = document.getElementById('textsContainer');
        container.querySelectorAll('.text-item.selected')
            .forEach(item => item.classList.remove('selected'));

        const entry = this.rendered[this.selectedIndex];
        if (!entry) return;

        const row = container.querySelector(`.text-item[data-id="${CSS.escape(entry.id)}"]`);
        if (row) {
            row.classList.add('selected');
            row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    // ---- mutations -----------------------------------------------------

    openModal(editId = null) {
        this.editingId = editId;
        const modal = document.getElementById('textModal');
        const textInput = document.getElementById('textInput');
        const modalTitle = document.getElementById('modalTitle');

        const entry = editId ? this.byId(editId) : null;
        modalTitle.textContent = entry ? 'Edit Text' : 'Add New Text';
        textInput.value = entry ? entry.text : '';

        modal.style.display = 'block';
        textInput.focus();
    }

    closeModal() {
        document.getElementById('textModal').style.display = 'none';
        this.editingId = null;
    }

    async saveText() {
        const textInput = document.getElementById('textInput');
        const textContent = textInput.value.trim();

        if (!textContent) {
            this.showToast('Please enter some text', 'error');
            return;
        }

        const editing = this.editingId ? this.byId(this.editingId) : null;
        let dirty;

        if (editing) {
            touch(editing, { text: textContent });
            dirty = editing.id;
        } else {
            if (this.texts.filter(isLive).length >= this.maxTexts) {
                this.showToast(
                    `Maximum ${this.maxTexts} texts. Delete some first.`, 'error');
                return;
            }
            const maxOrder = this.texts.reduce((max, e) => Math.max(max, e.order), 0);
            const created = newEntry(textContent, { order: maxOrder + 1000 });
            this.texts.push(created);
            dirty = created.id;
        }

        await this.save([dirty]);
        this.renderTexts();
        this.closeModal();
    }

    /**
     * Soft delete. A hard removal would be invisible to a device that was
     * offline at the time, which would resurrect the entry on its next push.
     */
    async deleteText(id) {
        const entry = this.byId(id);
        if (!entry || !confirm('Are you sure you want to delete this text?')) return;

        touch(entry, { deletedAt: Date.now() });
        this.selectedIndex = -1;
        await this.save([entry.id]);
        this.renderTexts();
    }

    /**
     * Move `draggedId` into `targetId`'s slot, then give it an `order`
     * between its new neighbours so only the one entry changes.
     */
    async reorderById(draggedId, targetId) {
        if (this.sortMode === 'frequency') return;

        const dragged = this.byId(draggedId);
        if (!dragged) return;

        // Sequence over all live entries, not the filtered view, so that
        // reordering while a search is active still lands correctly.
        const sequence = this.texts.filter(isLive).sort((a, b) => a.order - b.order);
        const from = sequence.findIndex(e => e.id === draggedId);
        const to = sequence.findIndex(e => e.id === targetId);
        if (from === -1 || to === -1) return;

        sequence.splice(from, 1);
        sequence.splice(to, 0, dragged);

        const before = sequence[to - 1]?.order ?? null;
        const after = sequence[to + 1]?.order ?? null;
        const order = orderBetween(before, after);

        let dirty;
        if (order === null) {
            // Gap exhausted (only after very many inserts in one spot). Every
            // entry moves, so every entry has to be pushed.
            renumber(sequence);
            sequence.forEach(entry => { entry.updatedAt = Date.now(); });
            dirty = sequence.map(entry => entry.id);
        } else {
            touch(dragged, { order });
            dirty = [dragged.id];
        }

        this.selectedIndex = -1;
        await this.save(dirty);
        this.renderTexts();
    }

    async copyToClipboard(id) {
        const entry = this.byId(id);
        if (!entry) return;

        let copied;
        try {
            await navigator.clipboard.writeText(entry.text);
            copied = true;
        } catch (error) {
            console.error('Error copying to clipboard:', error);
            copied = this.fallbackCopyToClipboard(entry.text);
        }

        if (!copied) {
            this.showToast('Failed to copy to clipboard', 'error');
            return;
        }

        // Counted for either copy route: this is the signal the frequency
        // sort reads, and the one sync will key its pushes off.
        touch(entry, { frequency: entry.frequency + 1 });

        // Persist before the popup tears itself down below. The upload is the
        // worker's problem, which is what makes this safe despite the close.
        await this.save([entry.id]);

        this.showToast('Copied to clipboard!');
        setTimeout(() => window.close(), 100);
    }

    /** @returns {boolean} whether the text actually reached the clipboard. */
    fallbackCopyToClipboard(text) {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.cssText = 'position:fixed;left:-999999px;top:-999999px;';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();

        try {
            return document.execCommand('copy');
        } catch (error) {
            console.error('Fallback copy failed:', error);
            return false;
        } finally {
            document.body.removeChild(textArea);
        }
    }

    // ---- rendering -----------------------------------------------------

    showToast(message, kind = 'success') {
        const toast = document.createElement('div');
        toast.className = `toast toast-${kind}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('toast-leaving');
            setTimeout(() => toast.remove(), 300);
        }, 2000);
    }

    renderTexts() {
        const container = document.getElementById('textsContainer');
        const visible = this.visibleTexts();

        this.rendered = visible.slice(0, this.renderLimit);
        const hidden = visible.length - this.rendered.length;

        const draggable = this.sortMode === 'manual';
        const dragHandleStyle = draggable ? '' : 'visibility: hidden; pointer-events: none;';

        container.innerHTML = this.rendered.map(entry => `
            <div class="text-item" data-id="${this.escapeHtml(entry.id)}"${draggable ? ' draggable="true"' : ''}>
                <div class="drag-handle" title="Drag to reorder" style="${dragHandleStyle}">⋮⋮</div>
                <div class="text-content-wrapper">
                    <div class="text-body-row">
                        <div class="text-content">${this.escapeHtml(entry.text)}</div>
                        <div class="frequency-badge" title="Usage count">${entry.frequency}</div>
                    </div>
                    <div class="text-actions">
                        <button class="action-btn copy-btn" data-action="copy">📋 Copy</button>
                        <button class="action-btn edit-btn" data-action="edit">✏️ Edit</button>
                        <button class="action-btn delete-btn" data-action="delete">🗑️ Delete</button>
                    </div>
                </div>
            </div>
        `).join('') + (hidden > 0
            ? `<button id="showMoreBtn" class="show-more-btn">Show ${hidden} more</button>`
            : '');

        this.updateEmptyState(visible.length);
    }

    updateEmptyState(visibleCount) {
        const emptyState = document.getElementById('emptyState');
        const container = document.getElementById('textsContainer');
        const empty = visibleCount === 0;

        emptyState.style.display = empty ? 'block' : 'none';
        container.style.display = empty ? 'none' : 'block';

        if (empty) {
            const searching = Boolean(this.searchTerm);
            emptyState.querySelector('.empty-title').textContent =
                searching ? 'No matching texts' : 'No texts saved yet';
            emptyState.querySelector('.empty-subtitle').textContent =
                searching ? 'Try a different search' : 'Click the + button to add your first text';
        }
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    new TextManager();
});
