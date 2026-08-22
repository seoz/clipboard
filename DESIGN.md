# QuickPaste — System Design

## 1. Overview

QuickPaste is a Manifest V3 Chrome extension that lets a user save up to 20 snippets of text and copy any of them to the system clipboard in one click. It has no backend, no network calls, and no background service worker — the entire app is a single popup page (`popup.html` + `popup.js` + `popup.css`) that runs only while the popup is open.

```
┌─────────────────────────────────────────────┐
│ Chrome toolbar → action click                │
│        │                                     │
│        ▼                                     │
│ popup.html (loads on every open, no          │
│              persistent background context)  │
│        │                                     │
│        ▼                                     │
│ TextManager (popup.js)                       │
│  ├─ chrome.storage.local  (persistence)      │
│  └─ navigator.clipboard   (system clipboard) │
└─────────────────────────────────────────────┘
```

There is deliberately no `background` service worker and no `content_scripts` entry in [manifest.json](manifest.json) — every interaction the extension supports (add/edit/delete/copy/search/sort/reorder/import/export) is initiated by, and completes within, a single popup session. This keeps the permission surface minimal (`storage`, `clipboardWrite` only) and avoids the lifecycle complexity of MV3 service workers (30-second idle teardown, event-driven wakeups) entirely, since nothing needs to run when the popup is closed.

## 2. Data model

A single `TextManager` class ([popup.js:1](popup.js:1)) owns all in-memory state and is the sole writer to storage.

```ts
interface TextEntry {
  text: string;
  frequency: number;   // times copied
  timestamp: number;    // Date.now() at creation/import
}

// chrome.storage.local
{
  savedTexts: TextEntry[],  // max 20 entries (this.maxTexts)
  sortMode: 'manual' | 'frequency'
}
```

**Schema evolution.** The original schema was a bare `string[]`. [loadTexts()](popup.js:230) performs a defensive migration on every load: if an entry is a string, it's wrapped into `{ text, frequency: 0, timestamp: Date.now() }`; if it's already an object, missing fields are backfilled. This means the on-disk format can be silently upgraded across versions without a dedicated migration step or version field — the tradeoff is that `loadTexts` has to keep supporting the legacy shape indefinitely (or until a version field is introduced to make the migration one-shot).

**Why array order carries meaning.** There's no explicit `order` field; manual ordering *is* array index. This is simple and makes drag-and-drop trivial (splice out, splice in — see [reorderTexts()](popup.js:337)), but it means manual order and frequency order can't coexist as two independently-stored orderings — switching to frequency mode and back does not restore the prior manual order, because sorting mutates `this.texts` in place. A production version aiming to preserve both would need a stable `id` per entry and sort a view/index list rather than the backing array.

## 3. Storage layer

- **Choice: `chrome.storage.local`, not `chrome.storage.sync`.** This was an explicit tradeoff: `sync` would give free cross-device propagation, but it's capped at 100KB total and 8KB per item, and is subject to per-minute write-rate throttling. Clipboard snippets are user-controlled free text that can be large, so `local` (10MB, effectively unlimited for this use case) was chosen over multi-device convenience.
- **Write path.** Every mutation ([saveText](popup.js:297), [deleteText](popup.js:328), [reorderTexts](popup.js:337), [copyToClipboard](popup.js:361), sort-mode change) calls `saveTexts()` ([popup.js:262](popup.js:262)), which does a full `chrome.storage.local.set({ savedTexts, sortMode })` of the entire array. There's no diffing or partial write — acceptable at ≤20 items, but it means every copy-to-clipboard action (which increments a frequency counter) re-persists the whole list.
- **No debouncing.** Rapid successive writes (e.g., quickly editing then copying) are not batched. Given the popup's short lifetime and small payload size, this hasn't been a practical problem, but it's worth flagging if the item cap is ever raised.

## 4. Key flows

### 4.1 Copy to clipboard
[copyToClipboard(index)](popup.js:361) takes an **index into `this.texts`**, not the text content — this was a deliberate correctness fix (previously it resolved the item via `texts.findIndex(t => t.text === text)`, which mis-attributed frequency increments whenever two saved entries had identical text). The flow:
1. `navigator.clipboard.writeText(text)` (requires the `clipboardWrite` permission and a user gesture, both satisfied by the click handler).
2. On success: increment `frequency`, re-sort + re-render if in frequency mode, persist, show a toast, close the popup after 100ms.
3. On failure (e.g., clipboard API unavailable/denied): [fallbackCopyToClipboard()](popup.js:390) uses a hidden `<textarea>` + `document.execCommand('copy')` as a legacy fallback.

### 4.2 Sort modes
Two modes, persisted in `sortMode`:
- **Manual** — array order is authoritative; drag-and-drop is enabled ([draggable = true](popup.js:488), HTML5 DnD events on each item).
- **Frequency** — [sortTexts()](popup.js:352) sorts by `frequency` desc, tiebreaking on `timestamp` desc (most recent wins ties). Drag-and-drop is disabled in this mode (`draggable = false`, drag handle hidden) since reordering has no meaning when order is derived.

### 4.3 Search/filter
[filterTexts()](popup.js:463) is a pure DOM-level filter — it reads back `.text-content.textContent` from already-rendered nodes and toggles `display`, rather than filtering `this.texts` and re-rendering. This avoids a full re-render on every keystroke but means the filter is coupled to the DOM being in sync with `this.texts`, and keyboard navigation ([setupKeyboardNavigation](popup.js:170)) has to separately query `.text-item` nodes with `display !== 'none'` to know what's currently visible.

### 4.4 Import / export
Export ([exportTexts](popup.js:23)) serializes `this.texts` to a downloaded JSON file via a Blob + object URL. Import ([importTexts](popup.js:41)) reads a user-selected file, accepts either legacy strings or `{text, frequency, timestamp}` objects per array element, validates each element defensively (guards against `null` entries and non-string `text` fields so one bad row doesn't abort the whole import), and appends until `maxTexts` is reached.

## 5. Rendering strategy

[renderTexts()](popup.js:477) does a full `innerHTML = ''` + rebuild on every state change (add, edit, delete, reorder, sort-mode switch, frequency increment in frequency mode). There's no virtual-DOM diffing or keyed reconciliation. This is a deliberate simplicity/performance tradeoff that's only valid because of the hard `maxTexts = 20` cap — rebuilding 20 DOM nodes with inline event listeners on every mutation is cheap. This approach would not scale past a few hundred items without introducing a diffing strategy or event delegation (currently each `.text-item` gets its own click/drag listeners rather than a single delegated listener on the container).

## 6. Security considerations

- **XSS via saved text.** User-supplied text is rendered into `innerHTML` as part of each item's template. [escapeHtml()](popup.js:593) (a `textContent` → `innerHTML` round-trip through a detached `<div>`) is applied to the text body before interpolation, which neutralizes `<script>`/attribute-injection payloads. Fields that are always extension-controlled (the frequency count, a `parseInt`'d index) are interpolated without escaping, which is safe only as long as they never carry user input — worth a comment/guard if the schema grows.
- **Permission scope.** `manifest.json` requests only `storage` and `clipboardWrite` — no `host_permissions`, no `activeTab`, no `content_scripts`. The extension cannot read or modify page content on any site, which is the correct minimal scope for a clipboard manager that only interacts with its own popup.
- **Import as an attack surface.** Import parses arbitrary user-supplied JSON with `JSON.parse` (safe — no `eval`), and every field is type-checked before use. A malicious import file can at most inject text that will later be HTML-escaped at render time.
- **No secrets in this codebase.** There's no API key, network call, or remote service anywhere in the extension, so the "never hardcode secrets" convention in [AGENTS.md](AGENTS.md) has nothing to apply to today — flagged here so it's revisited if a sync/cloud backend is ever added.

## 7. Known limitations / possible follow-ups

- Manual order is destroyed by switching to frequency mode and back (see §2) — fixable with per-item stable IDs and a derived sort view.
- No de-duplication on add or import; identical text can be saved multiple times as distinct entries.
- Hard cap of 20 items with no pagination or archive — appropriate for a "quick paste" tool, but worth revisiting if usage patterns show people wanting more.
- No automated tests exist for `TextManager`; the class is a plain `document`-coupled ES6 class, not currently structured for unit testing in isolation (would need DOM mocking or extraction of pure logic like `sortTexts`/schema migration into testable functions).
- `chrome.storage.local` is per-device; there is no cross-device sync (see §3 for why this was chosen deliberately).
