# QuickPaste

A Chrome extension that allows you to store and manage multiple texts with easy clipboard access.

## Features

- ✅ Store up to 20 texts
- ✅ Persistent storage using Chrome storage API
- ✅ Add, edit, and delete texts
- ✅ Copy selected text to system clipboard
- ✅ Search functionality
- ✅ Modern, responsive UI
- ✅ Flexible sorting: Manual or Frequency-based
- ✅ Import and export your texts as a JSON backup
- ✅ Works across browser restarts and system reboots

## Installation

QuickPaste is now built from source before loading, so the folder you load
into Chrome is `dist/`, not the repository root.

1. Download or clone this repository
2. Install [Node.js](https://nodejs.org/) 18 or newer if you don't have it
3. From the project folder, run:

   ```bash
   npm install && npm run build
   ```

4. Open Chrome and go to `chrome://extensions/`
5. Enable "Developer mode" in the top right
6. Click "Load unpacked" and select the **`dist`** folder — not the project
   folder itself. Loading the project root fails with *"Value 'key' is missing
   or invalid"*, because the manifest at the root is a build-time template.
7. The extension icon should appear in your Chrome toolbar

While making changes, `npm run dev` rebuilds automatically on save — click the
reload icon on the extension's card in `chrome://extensions/` to pick them up.

## Usage

1. Click the extension icon in your Chrome toolbar
2. Click the "+" button to add new text
3. Click on any text item to copy it to clipboard
4. Use the edit button to modify existing texts
5. Use the delete button to remove texts
6. Use the search box to filter texts
7. Use ↑/↓ to move through the list and Enter to copy the highlighted item

### Sorting and reordering

Pick **Manual Order** to arrange items yourself by dragging them with the
handle on the left, or **Most Frequent** to float your most-copied texts to the
top automatically. Switching between the two is safe — your manual arrangement
is remembered and comes back when you switch to Manual Order again.

### Backing up

The 💾 button saves all your texts to a `clipboard-backup.json` file, and 📂
loads one back in. Importing adds texts you don't already have and skips ones
you do, so importing the same backup twice won't create duplicates.

## Syncing across devices (in progress)

Signing in is optional — QuickPaste works fully without an account, and stores
nothing anywhere but your own machine unless you ask it to.

Open the extension's options page (right-click the toolbar icon → **Options**)
to sign in with Google and set an encryption passphrase. Your snippets are
encrypted on your device before anything leaves it, so the server only ever
holds unreadable data.

> **Your passphrase cannot be recovered.** Not by you, and not by us — that's
> what makes the encryption worth having. If you forget it, your synced
> snippets are gone for good. Write it down somewhere safe.

You can choose how long a device stays unlocked — 7 days, until Chrome
restarts, or ask every time — and lock it immediately with **Lock now**.

On sign-in (or unlocking on a new device), if this device and the server both
have snippets, you'll see a summary — "This device has 12 snippets, and the
server has 8, 3 of which look identical. Combining them leaves 17 total." —
before anything is combined. That's the one step that can't be undone, so
nothing happens until you confirm it.

After that, edits sync both ways: add, edit, delete, or reorder on one device
and it appears on the others within about 30 seconds, or the next time you
open the extension.

## Development

```bash
npm install       # install dependencies
npm run build     # produce dist/
npm run dev       # rebuild on every save
npm test          # run the unit tests
npm run emulators # Firebase emulators (needed for the rules tests; requires Java)
```

The security-rules tests skip automatically if the emulator isn't running.

## Technical Details

- **Manifest Version**: 3
- **Permissions**: storage, clipboardWrite
- **Storage**: Chrome local storage API
- **UI**: Modern CSS with gradients and animations
- **JavaScript**: ES6+ modules with async/await, bundled by Vite

## File Structure

```
├── manifest.template.json  # Manifest source; placeholders filled at build time
├── vite.config.js          # Build configuration
├── vitest.config.js        # Test configuration
├── package.json
├── public/
│   └── icons/              # PNG icons, copied verbatim into dist/
├── firestore.rules         # Server-side access rules
├── src/
│   ├── popup/              # popup.html, popup.css, popup.js
│   ├── options/            # Account & sync settings page
│   ├── background/         # Service worker
│   └── lib/                # DOM-free, unit tested
├── test/                   # Unit tests
├── dist/                   # Build output — THIS is what you load into Chrome
├── DESIGN.md               # System design notes
└── README.md               # This file
```

## Browser Compatibility

- Chrome 88+ (Manifest V3 support required)
- Other Chromium-based browsers (Edge, Brave, etc.)

## License

MIT License - feel free to modify and distribute.
