# Remember Cursor Position Enhanced

An [Obsidian](https://obsidian.md/) plugin that remembers cursor position and scroll location for each note. Enhanced version with multi-tab support — all open tabs restore their positions when the app restarts.

## Features

- **Per-file position memory**: Independently saves cursor and scroll position for each note
- **Multi-tab restore**: All open tabs restore their positions on app restart, not just the last active one
- **Reading mode support**: Saves and restores scroll position in both editing and reading modes
- **Mobile friendly**: Aggressive save strategy for iOS/Android where the app may be killed by the system at any time
- **Configurable**: Adjustable save interval, restore delay, and maximum stored entries

## How It Works

The plugin saves cursor and scroll positions to a JSON file in your vault. Positions are saved:
- Periodically while you browse (every 200ms for active tab, flushed to disk every 5s)
- When switching between tabs
- When the app goes to background (important for mobile)
- On app quit

When the app restarts, all previously open tabs are restored to their saved positions.

## Installation

### From Obsidian Community Plugins (Recommended)

1. Open **Settings** → **Community plugins** → **Browse**
2. Search for "Remember Cursor Position Enhanced"
3. Click **Install**, then **Enable**

### Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` (if available) from the [latest release](https://github.com/asen-z/obsidian-remember-cursor-position-enhanced/releases)
2. Create a folder `remember-cursor-position-enhanced` in your vault's `.obsidian/plugins/` directory
3. Copy the downloaded files into this folder
4. Restart Obsidian and enable the plugin in **Settings** → **Community plugins**

## Settings

| Setting | Description | Default |
|---------|-------------|---------|
| **Data file name** | Path to the JSON file that stores positions | `.obsidian/plugins/remember-cursor-position-enhanced/cursor-positions.json` |
| **Delay after opening a note** | Delay before restoring scroll position (increase if interfering with `#header` links) | 100 ms |
| **Save interval** | How often positions are flushed to disk | 5000 ms |
| **Max entries** | Maximum number of file positions to remember | 1000 |

## Compatibility

- Obsidian v0.9.12+
- Works on Desktop (Windows, macOS, Linux) and Mobile (iOS, Android)

## Credits

This plugin is based on [Remember Cursor Position](https://github.com/dy-sh/obsidian-remember-cursor-position) by Dmitry Savosh. The enhanced version adds multi-tab position tracking, improved mobile persistence, and startup race condition fixes.

## License

[MIT](LICENSE)
