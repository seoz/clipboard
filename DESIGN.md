# QuickPaste — System Design

## 1. Overview

QuickPaste is a Manifest V3 Chrome extension that lets a user save snippets of text and copy any of them to the system clipboard in one click. Today it still has no backend, no network calls, and no background service worker: the entire app is a single popup page that runs only while the popup is open.

```
┌─────────────────────────────────────────────┐
│ Chrome toolbar → action click                │
│        │                                     │
│        ▼                                     │
│ popup.html (loads on every open, no          │
│              persistent background context)  │
│        │                                     │
│        ▼                                     │
│ TextManager (src/popup/popup.js)             │
│  ├─ src/lib/store.js  → chrome.storage.local │
│  ├─ src/lib/model.js  (schema + migration)   │
│  └─ navigator.clipboard (system clipboard)   │
└─────────────────────────────────────────────┘
```

The minimal permission surface (`storage`, `clipboardWrite`) and the absence of a service worker remain deliberate: every interaction the extension supports is initiated by, and completes within, a single popup session, so nothing needs to run while the popup is closed.

**This is partly built.** Google sign-in, the background service worker, the options page and the encryption layer have landed; the sync engine that moves entries has not. §8 describes what exists and what remains. Sections 1–7 describe the local-only core, which is unchanged by sign-in: a signed-out user still gets a fully working extension with no network traffic at all.

### 1.1 Build

The extension is no longer loaded from the repository root. Source lives in `src/`, is bundled by Vite, and the loadable extension is emitted to `dist/`:

- `src/popup/` — the popup page. Its `<script>` is now `type="module"`.
- `src/lib/` — `model.js` and `store.js`. **These must stay DOM-free**: the service worker in §8 will import them, and a service worker has no `document`. This is also what makes them unit-testable, closing a gap flagged in the previous revision of this document.
- `manifest.template.json` lives at the repository root and is emitted as `dist/manifest.json` by a small Vite plugin that substitutes `__PLACEHOLDER__` tokens from the environment. `import.meta.env` cannot reach a JSON file, and §8 needs an OAuth client id and an extension key injected at build time. The template is deliberately not named `manifest.json`: Chrome rejects a manifest containing an unsubstituted `key`, so a root file with that name would only ever invite loading the wrong folder. When the OAuth values are absent the plugin drops `key` and `oauth2` outright rather than emitting placeholders, so an unconfigured build still loads with sign-in disabled instead of failing to load at all.

Adopting a build step is a real cost — there's now an `npm run build` between editing and reloading, and the extension can no longer be loaded straight from a checkout. It is forced by §8: MV3's content security policy forbids remote scripts, so the Firebase SDK has to be bundled locally. Introducing it now, while there is no network code to debug simultaneously, was the cheaper ordering.

## 2. Data model

A single `TextManager` class owns all in-memory state; `src/lib/store.js` is the sole reader and writer of persisted state.

```ts
interface TextEntry {
  id: string;             // crypto.randomUUID(), stable for the entry's lifetime
  text: string;
  frequency: number;      // times copied
  timestamp: number;      // creation time
  updatedAt: number;      // last-write-wins clock, bumped on every mutation
  order: number;          // manual position; sparse, see below
  deletedAt: number|null; // tombstone
}

// chrome.storage.local
{
  savedTexts: TextEntry[],
  sortMode: 'manual' | 'frequency',
  schemaVersion: 2
}
```

**Stable ids replace array indices.** Previously an entry's identity *was* its index in `savedTexts`, and every call site passed indices around. That is workable for a single device but cannot survive a second one: the moment a remote device reorders or deletes anything, an index refers to a different entry than the sender meant. Every UI path is now addressed by `id` — `data-id` attributes, `copyToClipboard(id)`, `openModal(id)`, `reorderById(draggedId, targetId)`.

**`order` is sparse, not sequential.** Adjacent entries are 1000 apart, so a drag-and-drop assigns the moved entry an `order` midway between its new neighbours and touches exactly one record. Renumbering the whole list on every drag would be harmless locally but would mark every entry dirty for sync. `orderBetween()` returns `null` when floating-point precision between two neighbours is exhausted, at which point `renumber()` rebuilds the grid — rare, and correct when it happens.

**Deletes are soft.** `deleteText()` sets `deletedAt` instead of splicing. A hard delete is invisible to a device that was offline when it happened, so that device would resurrect the entry on its next push. Tombstones are filtered out of every view and excluded from export. Signed-out users accumulate them harmlessly; §8 adds garbage collection.

**Schema evolution is now versioned.** `schemaVersion` gates a one-shot `migrateToV2()` that accepts every shape ever written or imported: the original bare `string[]`, the `{text, frequency, timestamp}` objects that followed, and current v2 entries. Array position becomes `order`, which preserves the old rule that manual order *is* array order. The migrated array is written straight back, so subsequent loads take the fast path and ids never churn. `normalizeEntry()` still backfills defensively on every load, because import files of any vintage will keep arriving indefinitely.

**Ids from imported files are validated.** An id is interpolated into an HTML attribute and into a CSS selector, and an imported backup is untrusted input. `isValidId()` accepts only `[A-Za-z0-9_-]{8,64}`; anything else is replaced with a fresh uuid. Without this, a crafted backup file could break out of the `data-id="…"` attribute.

## 3. Storage layer

- **Choice: `chrome.storage.local`, not `chrome.storage.sync`.** `sync` would give free cross-device propagation, but it is capped at 100KB total and 8KB per item with per-minute write-rate throttling. Clipboard snippets are user-controlled free text that can be large, so `local` (10MB) was chosen over multi-device convenience. That tradeoff is what makes §8's server-side sync the path to cross-device support rather than simply switching storage areas.
- **One chokepoint.** All persistence goes through `loadState()` / `saveState()` in `src/lib/store.js`. Every mutation calls `TextManager.save()`, which does a full `chrome.storage.local.set` of the array. There's no diffing — acceptable at these sizes, and §8 layers a per-entry dirty queue on top of this exact chokepoint rather than replacing it.
- **No debouncing.** Rapid successive writes are not batched. Locally this is a non-issue; it becomes one the moment writes are network-backed, which is why §8 moves the network push off this path entirely.

## 4. Key flows

### 4.1 Copy to clipboard
`copyToClipboard(id)` resolves the entry by id, so two saved entries with identical text track their frequencies independently.

1. `navigator.clipboard.writeText(text)`.
2. On failure, `fallbackCopyToClipboard()` uses a hidden `<textarea>` + `document.execCommand('copy')` and reports whether it succeeded.
3. If either route copied, `frequency` is incremented and `updatedAt` bumped, state is persisted, a toast is shown, and the popup closes after 100ms.

The increment is deliberately shared by both routes. Previously the fallback path copied the text but never counted it, so a copy could silently fail to register in the frequency sort; the counter also becomes the trigger for sync pushes in §8, making an uncounted copy an unsynced one.

The 100ms self-close is worth noting for §8: it means a network write started here would race a page that is already being torn down.

### 4.2 Derived views, not in-place sorting
`orderedLive()` and `visibleTexts()` return sorted, tombstone-filtered, search-filtered *copies*; `this.texts` is never reordered. This fixes a limitation called out in the previous revision — manual order used to be destroyed by switching to frequency mode and back, because sorting mutated the backing array. Manual mode sorts by `order`, frequency mode by `frequency` desc with `timestamp` desc as the tiebreak. Drag-and-drop is disabled in frequency mode, where manual position has no meaning.

### 4.3 Search/filter
`filterTexts` used to be a DOM-level filter that read `.text-content` back out of already-rendered nodes and toggled `display`. It now sets a `searchTerm` on the model and re-renders from `visibleTexts()`, debounced 120ms. Filtering the model rather than the DOM matters for two reasons: it removes a 500-node DOM read per keystroke, and it lets search reach entries that the render limit (§5) is currently holding back. Keyboard navigation reads the rendered array directly instead of re-querying the DOM for `display !== 'none'`.

### 4.4 Import / export
Export writes `{ version, exportedAt, entries }` and **keeps ids**, so re-importing a backup is idempotent rather than duplicating everything. Tombstones are excluded. Import sniffs `Array.isArray(parsed)` to accept the legacy bare-array format, routes every element through the same `migrateToV2()` the loader uses — the coercion logic is no longer duplicated between the two paths — skips ids already present, and stops at the item cap.

## 5. Rendering strategy

`renderTexts()` still does a full rebuild on every state change, but two changes make that viable well past the old 20-item cap:

- **Event delegation.** The container carries one listener per event type, dispatching via `e.target.closest('[data-id]')`. Previously each row got up to five of its own listeners; at 500 entries that was 2500 listeners rebuilt on every mutation, including every frequency increment.
- **A render limit.** At most 200 rows are placed in the DOM, with a "Show N more" button beyond that. Since search filters the model, any entry remains reachable by typing.

Measured on a 500-entry corpus, a full 200-row rebuild including forced layout costs ~10ms — roughly one frame. Virtualization is therefore deliberately *not* implemented: it would be speculative work on a code path that is not yet slow. Revisit if entry counts exceed ~2000 or a render exceeds 16ms.

The `maxTexts` cap is now a getter returning 20 while signed out, and will return `Infinity` once sync is enabled (§8) — which is what makes the two changes above prerequisites rather than polish.

## 6. Security considerations

- **XSS via saved text.** User text is interpolated into `innerHTML`, guarded by `escapeHtml()` (a `textContent` → `innerHTML` round-trip through a detached `<div>`). Note that this escapes `&<>` but not quotes, so it is safe for element bodies and *not* sufficient for attribute values — which is precisely why ids are pattern-validated at §2 rather than escaped at render time.
- **Permission scope.** `storage` and `clipboardWrite` only — no `host_permissions`, no `activeTab`, no `content_scripts`. The extension cannot read or modify page content on any site. §8 will need to widen this, and that widening should be reviewed on its own terms.
- **Import as an attack surface.** Import uses `JSON.parse` (no `eval`) and type-checks every field. A malicious file can at most inject text that is HTML-escaped at render time, or an id that is rejected by `isValidId()`.
- **No secrets in this codebase.** There is still no API key, network call, or remote service anywhere in the extension. §8 changes this, and the distinction it draws between *public identifiers* and *secrets* will need to be documented here when it lands.

## 7. Testing

`src/lib/` is DOM-free and unit-tested with Vitest (`npm test`), covering the functions where a bug silently destroys user data: schema migration across all three historical shapes, id validation, dedup keys, sparse-order arithmetic, and the load/save round trip including migrate-once behaviour and tombstone persistence. `chrome.storage.local` is faked in-process.

The crypto layer is tested for the properties that matter rather than for fixed vectors: keys are non-extractable and `exportKey` rejects, IVs never repeat, identical plaintext yields different ciphertext, ciphertext moved to another entry id fails to decrypt, tampered ciphertext is rejected rather than returning garbage, and the plaintext never appears inside the ciphertext.

`test/rules.test.js` exercises the security rules against the Firestore emulator — the highest-value tests here, since the rules are the only server-side enforcement and are pure logic. The emulator needs a Java runtime; without one the suite skips rather than failing, so `npm test` stays green on a machine that cannot run it.

`TextManager` itself remains `document`-coupled and is not unit-tested; it is verified by loading the built extension. Extracting the model and store layers was the prerequisite that made anything testable at all.

## 8. Google SSO + end-to-end-encrypted sync

### 8.1 Authentication (built)

`chrome.identity.getAuthToken` obtains a Google OAuth access token, which is exchanged for a Firebase session via `signInWithCredential`. Two details are load-bearing:

- **The options page owns sign-in, not the popup.** `getAuthToken` opens a native consent window, which steals focus, and an MV3 action popup is destroyed on focus loss — compounded by the popup's own 100ms self-close (§4.1). An options page is a normal tab and can wait.
- **`firebase/auth/web-extension`, not `firebase/auth`.** The default entry point touches `document` at module scope and throws inside a service worker. The web-extension build exists for MV3 and defaults to IndexedDB persistence, which is shared across extension contexts — so the session survives popup teardown, worker death and browser restart. Verified: a cold worker, after a full browser restart, restores the session and mints a fresh ID token with no page context.

Chrome caches OAuth tokens and will return an expired one, surfacing as `auth/invalid-credential`; `signIn()` therefore drops the cached token and retries once. The extension ID is pinned via the manifest `key` because an OAuth client is bound to one specific ID and an unpacked extension's ID otherwise derives from its filesystem path.

### 8.2 Encryption (built)

| Parameter | Value |
|---|---|
| KDF | PBKDF2-HMAC-SHA256, 600,000 iterations |
| Salt | 16 random bytes, stored at `users/{uid}.kdf.salt` |
| Key | AES-GCM 256, **non-extractable** |
| IV | 12 random bytes, fresh per write |
| AAD | the entry id |

The salt lives server-side because it must be fetchable on a brand-new device before any local state exists; a salt is not secret, its job is to prevent precomputation. The iteration count is recorded per user so it can be raised later without stranding existing accounts. AAD binds a ciphertext to its record, so ciphertext cannot be moved between documents by anyone with write access.

**The verifier.** A known plaintext sealed under the user's key, stored alongside the KDF params. Without it a wrong passphrase would only reveal itself as every entry failing to decrypt in turn; with it, unlock is one check with an unambiguous answer before any entry is touched. AES-GCM's authentication tag is what makes "wrong key" a clean failure rather than plausible garbage — so a wrong passphrase and an unreachable server are reported as distinct errors, never conflated.

**Key caching.** The derived key is cached in IndexedDB as a `CryptoKey` *object*. Structured clone supports `CryptoKey`, so a non-extractable key round-trips through storage without its raw bytes ever becoming reachable from JavaScript — strictly stronger than serialising key material into `chrome.storage`, which would require making the key extractable. Verified: `crypto.subtle.exportKey` throws on the restored key. IndexedDB is shared with the service worker, which is what will let sync run with no popup open.

The tradeoff is that a cached key survives browser restarts, so someone with access to the Chrome profile could drive the extension into decrypting. Auto-lock bounds that window: 7 days by default, or per browser session, or never cached at all — the last of which disables background sync, and says so in the UI.

**What is deliberately not encrypted.** `order`, `updatedAt`, `deletedAt` and `v` stay plaintext because merge and ordering must work on records the client cannot yet decrypt (the locked state). The accepted leak is entry count, timestamps, relative order, and approximate plaintext length via ciphertext size. Padding would close the length leak and is noted as a follow-up. `frequency` **is** encrypted, inside the payload: a plaintext usage counter would tell the server operator how often each snippet is used and how that shifts over time, which is a real side channel for a clipboard manager, and nothing server-side needs it.

### 8.3 Security rules (built, in `firestore.rules`)

Per-user isolation, exact field sets via `hasOnly` (which closes the "use my own document as free storage" hole), base64 and size validation, monotonic `updatedAt` so a buggy client cannot rewind the merge clock, and one-way tombstones. Hard deletes are permitted only for a document that is already tombstoned, which forces every deletion through the soft-delete path §8.4 depends on.

The rules **cannot** validate the ciphertext — that is the entire point of end-to-end encryption, not an oversight. They validate ownership, shape and size; the encryption validates content.

### 8.4 Sync engine (built)

**Push.** `save()` records touched ids in a dirty queue rather than awaiting the network; the worker, woken by `chrome.alarms`, encrypts and uploads them in a batch. This is what keeps the §4.1 copy path — one write per copy, followed 100ms later by the popup closing — from becoming a network round trip against a dying page. The queue is a set of ids, not a log, so ten rapid copies of one snippet collapse into a single upload carrying the final count. `permission-denied`/`unauthenticated` are treated as fatal and not retried — the session or the rules are wrong, and retrying can't fix either; anything else backs off 30s → 1m → 5m → 15m.

**First merge.** Runs once per device, the first time it holds both a decryption key and has never pulled before (`lastPullAt === 0` is the signal). Entirely client-side and read-only until confirmed: the server holds ciphertext and cannot compare or dedup by content, and any decrypt failure aborts the whole plan rather than partially merging under what might be the wrong key. Local and remote entries are fused by `dedupKey` — trimmed, NFC-normalized text — with the **remote id winning** so both devices converge on one identity, `frequency = max` (summing would double-count on a repeated merge), and `timestamp = min`. Local tombstones are dropped outright; nothing in a delete is worth preserving into a fresh account pairing. The plan is shown to the user (counts and duplicate count) and applied only on confirmation — the one irreversible step in the whole design.

**Steady-state pull**, run after every push so a device's own edits are never shadowed by something older arriving in the same cycle: a delta query (`updatedAt > lastPullAt`, with a 5s skew buffer) turns a full resync into a handful of reads. Merge is **last-write-wins on `updatedAt`** per record; a genuine tie (identical millisecond, different content — vanishingly rare) breaks on the decrypted text lexicographically, chosen because it's deterministic and doesn't depend on which device evaluates it, so both sides converge on the same answer independently. Two consequences that are surfaced rather than silently absorbed: **a concurrent edit on two devices loses one side's text entirely**, and **frequency is lossy across devices** (a copy on A and one on B in the same window yields +1, not +2, since only the winning `updatedAt` survives).

A device idle more than 30 days falls back from the delta query to a full read. That bound exists because of tombstone garbage collection: a daily alarm hard-deletes tombstones older than 30 days, and a device that missed the delete entirely (rather than seeing the tombstone and reconciling it) could otherwise resurrect an entry nobody meant to keep.

**`firebase/firestore/lite`, not the full SDK.** No realtime listeners (a popup lives for seconds), no WebChannel transport to fight with in worker contexts, and no built-in offline layer competing with the queue described above.

## 9. Known limitations / possible follow-ups

- No de-duplication on add; identical text can be saved multiple times as distinct entries. Import de-duplicates by id, not by content; first-merge deduplicates by content, but only once, at merge time.
- Hard cap of 20 items still applies to local-only (signed-out) use; lifting it for signed-in users is not yet built.
- `TextManager` is still a large `document`-coupled class doing routing, rendering, and mutation. It is the natural next extraction if it keeps growing.
- The two-device merge and pull paths are covered by unit tests against a faithful mock of Firestore's query semantics, but not yet by an actual two-profile, two-account run — that verification needs a human at two real devices and is recorded as the acceptance step for this phase rather than something that can be automated here.
