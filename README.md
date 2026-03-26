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

- Continuously while you read (every 200ms for the active tab, flushed to disk every 5s)
- When switching between tabs
- When the app goes to background (critical for mobile)
- On app quit

When the app restarts, every previously open tab is restored to its saved position.

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
| **Data file name**             | Path to the JSON file that stores positions                                           | `.obsidian/plugins/scroll-anchor/cursor-positions.json` |
| **Delay after opening a note** | Delay before restoring scroll position (increase if interfering with `#header` links) | 100 ms                                                  |
| **Save interval**              | How often positions are flushed to disk                                               | 5000 ms                                                 |
| **Max entries**                | Maximum number of file positions to remember                                          | 1000                                                    |

## Compatibility

- Obsidian v0.9.12+
- Desktop (Windows, macOS, Linux) and Mobile (iOS, Android)

## License

[MIT](LICENSE)
