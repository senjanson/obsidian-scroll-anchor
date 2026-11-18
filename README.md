# Scroll Anchor

An [Obsidian](https://obsidian.md/) plugin that anchors your scroll and cursor position in every note, and restores them all when the app restarts.

## Features

- **Per-file position memory**: Independently saves cursor and scroll position for each note
- **Multi-tab restore**: All open tabs restore their positions on app restart, not just the last active one
- **Reading mode support**: Saves and restores scroll position in both editing and reading modes
- **Mobile-first design**: Aggressive save strategy for iOS/Android where the app may be killed by the system — you never lose your reading spot
- **Configurable**: Adjustable save interval, restore delay, and maximum stored entries

## How It Works

Positions are saved to a JSON file inside your vault. Saving happens:

- Continuously while you read (every 100 ms for the active tab, and as soon as you stop scrolling)
- When switching between tabs
- When the app goes to background (critical for mobile)
- On app quit, and when the plugin is disabled or updated

Positions are written to disk every 2 seconds (the **Save interval**), and only when something changed. The file is written safely, so a crash or a killed app never leaves you with an empty file.

When the app restarts, every previously open tab is restored to its saved position.

Only notes where you scrolled or moved the cursor away from the top are remembered. Entries for notes that were deleted, even outside Obsidian, are cleaned up automatically.

### Sync

If you sync your vault between devices (Obsidian Sync, iCloud, Syncthing, etc.), the plugin notices when the data file is replaced by another device's copy and merges it with the positions saved on this device, so each device sees the positions you read on the others.

## Installation

> The plugin is not yet listed in the Obsidian Community Plugins directory. Use one of the methods below.

### Method 1: BRAT (Recommended — supports auto-update)

[BRAT](https://github.com/TfTHacker/obsidian42-brat) is a community plugin that lets you install and auto-update plugins directly from GitHub.

1. Install **BRAT** from the Obsidian Community Plugins directory
2. Open **Settings** → **BRAT** → **Add Beta plugin**
3. Enter the repository URL:
   ```
   https://github.com/senjanson/obsidian-scroll-anchor
   ```
4. Click **Add Plugin**
5. Go to **Settings** → **Community plugins** and enable **Scroll Anchor**

To update later: open **Settings** → **BRAT** → **Check for updates to all beta plugins**.

### Method 2: Manual Installation

1. Go to the [latest release](https://github.com/senjanson/obsidian-scroll-anchor/releases) and download `main.js` and `manifest.json`
2. Create a folder `scroll-anchor` inside your vault's `.obsidian/plugins/` directory
3. Copy the two downloaded files into that folder
4. Restart Obsidian and enable **Scroll Anchor** in **Settings** → **Community plugins**

## Settings

| Setting                        | Description                                                                           | Default                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Data file name**             | Path to the JSON file that stores positions (empty uses the default)                  | `.obsidian/plugins/scroll-anchor/cursor-positions.json` |
| **Delay after opening a note** | Delay before restoring scroll position, 0–300 ms (increase if interfering with `#header` links) | 50 ms                                     |
| **Save interval**              | How often positions are flushed to disk, 2000–20000 ms                                | 2000 ms                                                 |
| **Max entries**                | Maximum number of file positions to remember                                          | 1000                                                    |

## Compatibility

- Obsidian v0.15.0+
- Desktop (Windows, macOS, Linux) and Mobile (iOS, Android)

## License

[MIT](LICENSE)
