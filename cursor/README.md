# Multi-Text Clipboard Manager

A Chrome extension that allows you to store and manage multiple texts with easy clipboard access.

## Features

- ✅ Store up to 20 texts
- ✅ Persistent storage using Chrome storage API
- ✅ Add, edit, and delete texts
- ✅ Copy selected text to system clipboard
- ✅ Search functionality
- ✅ Modern, responsive UI
- ✅ Works across browser restarts and system reboots

## Installation

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable "Developer mode" in the top right
4. Click "Load unpacked" and select the extension folder
5. The extension icon should appear in your Chrome toolbar

## Creating Icons

The extension requires PNG icons in the following sizes:
- 16x16 pixels
- 32x32 pixels  
- 48x48 pixels
- 128x128 pixels

To create the icons:

1. Use the provided `icon.svg` as a base
2. Convert it to PNG format in the required sizes
3. Save them in the `icons/` folder as:
   - `icon16.png`
   - `icon32.png`
   - `icon48.png`
   - `icon128.png`

You can use online SVG to PNG converters or tools like:
- [Convertio](https://convertio.co/svg-png/)
- [CloudConvert](https://cloudconvert.com/svg-to-png)
- [SVG to PNG Converter](https://svgtopng.com/)

## Usage

1. Click the extension icon in your Chrome toolbar
2. Click the "+" button to add new text
3. Click on any text item to copy it to clipboard
4. Use the edit button to modify existing texts
5. Use the delete button to remove texts
6. Use the search box to filter texts

## Technical Details

- **Manifest Version**: 3
- **Permissions**: storage, clipboardWrite
- **Storage**: Chrome local storage API
- **UI**: Modern CSS with gradients and animations
- **JavaScript**: ES6+ with async/await

## File Structure

```
├── manifest.json          # Extension manifest
├── popup.html            # Main popup interface
├── popup.css             # Styling
├── popup.js              # Main functionality
├── icon.svg              # Source icon (SVG)
├── icons/                # PNG icons directory
│   ├── icon16.png
│   ├── icon32.png
│   ├── icon48.png
│   └── icon128.png
└── README.md             # This file
```

## Browser Compatibility

- Chrome 88+ (Manifest V3 support required)
- Other Chromium-based browsers (Edge, Brave, etc.)

## License

MIT License - feel free to modify and distribute.
