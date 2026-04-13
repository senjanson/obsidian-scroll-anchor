import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  MarkdownView,
  TAbstractFile,
  TFile,
  WorkspaceLeaf,
} from "obsidian";

interface PluginSettings {
  dbFileName: string;
  delayAfterFileOpening: number;
  saveTimer: number;
  maxEntries: number;
}

const SAFE_DB_FLUSH_INTERVAL = 2000;

const DEFAULT_SETTINGS: PluginSettings = {
  dbFileName: "",
  delayAfterFileOpening: 50,
  saveTimer: SAFE_DB_FLUSH_INTERVAL,
  maxEntries: 1000,
};

interface EphemeralState {
  cursor?: {
    from: {
      ch: number;
      line: number;
    };
    to: {
      ch: number;
      line: number;
    };
  };
  scroll?: number;
}

function sameEphemeralState(a: EphemeralState, b: EphemeralState): boolean {
  if (a.scroll !== b.scroll) return false;
  const ac = a.cursor;
  const bc = b.cursor;
  if (!ac && !bc) return true;
  if (!ac || !bc) return false;
  return (
    ac.from.ch === bc.from.ch &&
    ac.from.line === bc.from.line &&
    ac.to.ch === bc.to.ch &&
    ac.to.line === bc.to.line
  );
}

// Loose equality for scroll — if current and saved differ by less than 1 unit,
// the view is effectively in the right place and we can skip restoring (avoids flash).
function isNearSameState(a: EphemeralState, b: EphemeralState): boolean {
  if (typeof a.scroll !== "number" || typeof b.scroll !== "number") return false;
  return Math.abs(a.scroll - b.scroll) < 1;
}

export default class ScrollAnchor extends Plugin {
  settings: PluginSettings;
  db: { [file_path: string]: EphemeralState };
  lastSavedDb: { [file_path: string]: EphemeralState };
  // Whether save is enabled (disabled during startup to prevent overwriting good data)
  saveEnabled = false;
  private scrollSaveTimeout: number | null = null;
  // Tracks the leaf the user is currently on, so active-leaf-change can save the *outgoing* leaf
  private lastActiveLeaf: WorkspaceLeaf | null = null;
  // Files currently being restored — saves are suppressed for these to avoid writing a transient scroll=0
  private restoringFiles: Set<string> = new Set();
  // Serializes writeDb calls to prevent interleaved adapter.write
  private writeInFlight: Promise<void> | null = null;

  async onload() {
    await this.loadSettings();

    try {
      this.db = await this.readDb();
      this.lastSavedDb = await this.readDb();
    } catch (e) {
      console.error("Scroll Anchor: can't read database: " + e);
      this.db = {};
      this.lastSavedDb = {};
    }

    this.addSettingTab(new SettingTab(this.app, this));

    // Restore all leaf positions after layout is ready.
    // Multiple passes give slow-rendering views a chance to receive the scroll position.
    this.app.workspace.onLayoutReady(() => {
      const passes = [500, 1200, 1800];
      for (const delay of passes) {
        setTimeout(() => {
          this.restoreAllLeafPositions();
        }, delay);
      }
      setTimeout(() => {
        const activeView =
          this.app.workspace.getActiveViewOfType(MarkdownView);
        this.lastActiveLeaf = activeView?.leaf ?? null;
        this.saveEnabled = true;
      }, 2200);
    });

    // Restore position when a new file is opened (for files opened after startup)
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file && this.saveEnabled) {
          const view = this.app.workspace.getActiveViewOfType(MarkdownView);
          if (view && view.file && view.file.path === file.path) {
            void this.restoreLeafPosition(view, file);
          }
        }
      }),
    );

    // Save the *outgoing* leaf when switching tabs, and restore the *incoming* leaf.
    // file-open is unreliable for tab switches on some Obsidian versions, so we handle
    // restore here too — calling restoreLeafPosition twice is safe (no-op the second time).
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (newLeaf) => {
        if (this.saveEnabled && this.lastActiveLeaf) {
          const prevView = this.lastActiveLeaf.view;
          if (prevView instanceof MarkdownView) {
            this.saveLeafPosition(prevView);
          }
        }
        this.lastActiveLeaf = newLeaf;

        if (this.saveEnabled && newLeaf && newLeaf.view instanceof MarkdownView) {
          const view = newLeaf.view;
          const file = view.file;
          if (file) {
            void this.restoreLeafPosition(view, file);
          }
        }
      }),
    );

    // Save on quit — only flush db, don't re-read positions (views may be tearing down)
    this.registerEvent(
      this.app.workspace.on("quit", () => {
        void this.writeDb(this.db);
      }),
    );

    // Handle file rename
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.renameFile(file, oldPath);
      }),
    );

    // Handle file delete
    this.registerEvent(
      this.app.vault.on("delete", (file) => this.deleteFile(file)),
    );

    // Periodically save active leaf position
    this.registerInterval(
      window.setInterval(() => {
        if (this.saveEnabled) {
          this.saveActiveLeafPosition();
        }
      }, 100),
    );

    // Save on scroll stop (debounced) — captures position as soon as user stops scrolling
    this.registerDomEvent(
      window,
      "scroll",
      () => {
        if (!this.saveEnabled) return;
        if (this.scrollSaveTimeout !== null) {
          window.clearTimeout(this.scrollSaveTimeout);
        }
        this.scrollSaveTimeout = window.setTimeout(() => {
          this.saveActiveLeafPosition();
          this.scrollSaveTimeout = null;
        }, 50);
      },
      true,
    );

    // Periodically flush db to disk
    this.registerInterval(
      window.setInterval(() => {
        void this.writeDb(this.db);
      }, this.settings.saveTimer),
    );

    // Capture beforeunload — only flush, don't re-read positions
    this.registerDomEvent(window, "beforeunload", () => {
      void this.writeDb(this.db);
    });

    // visibilitychange for mobile — save + flush
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        if (this.saveEnabled) {
          this.saveActiveLeafPosition();
        }
        void this.writeDb(this.db);
      }
    });
  }

  onunload() {
    if (this.scrollSaveTimeout !== null) {
      window.clearTimeout(this.scrollSaveTimeout);
      this.scrollSaveTimeout = null;
    }
  }

  // ---- Save Logic ----

  saveActiveLeafPosition() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    this.saveLeafPosition(view);
  }

  saveLeafPosition(view: MarkdownView) {
    if (!view.file) return;
    // Suppress saves while a restore is in flight to avoid capturing a transient scroll=0
    if (this.restoringFiles.has(view.file.path)) return;

    const state = this.getLeafEphemeralState(view);
    if (typeof state.scroll !== "number" || isNaN(state.scroll)) return;

    const path = view.file.path;
    const existing = this.db[path];
    if (existing && sameEphemeralState(existing, state)) return;

    // Re-insert to refresh insertion order so maxEntries trim behaves as LRU.
    delete this.db[path];
    this.db[path] = state;
  }

  getLeafEphemeralState(view: MarkdownView): EphemeralState {
    let state: EphemeralState = {};

    // Prefer the public API — more reliable than the private currentMode.getScroll()
    try {
      const ephState = view.getEphemeralState();
      if (ephState && typeof ephState.scroll === "number") {
        state.scroll = ephState.scroll;
      }
    } catch {}

    // Fallback to private API if public one didn't yield a number
    if (typeof state.scroll !== "number" || isNaN(state.scroll)) {
      // @ts-ignore - currentMode is not in the public API
      state.scroll = view.currentMode?.getScroll?.();
    }

    let editor = view.editor;
    if (editor) {
      let from = editor.getCursor("anchor");
      let to = editor.getCursor("head");
      if (from && to) {
        state.cursor = {
          from: { ch: from.ch, line: from.line },
          to: { ch: to.ch, line: to.line },
        };
      }
    }

    return state;
  }

  // ---- Restore Logic ----

  restoreAllLeafPositions() {
    const leaves: { view: MarkdownView; path: string }[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView) {
        const file = leaf.view.file;
        if (file && this.db[file.path]) {
          leaves.push({ view: leaf.view, path: file.path });
        }
      }
    });

    for (const { view, path } of leaves) {
      const st = this.db[path];
      this.setLeafEphemeralState(view, st);
    }
  }

  async restoreLeafPosition(view: MarkdownView, file: TFile) {
    const st = this.db[file.path];
    if (!st) return;

    // Skip restore if the view is already at (or very near) the saved position.
    // This avoids the "flash" when switching between already-rendered tabs whose
    // DOM scroll state the browser has preserved naturally.
    const current = this.getLeafEphemeralState(view);
    if (isNearSameState(current, st)) return;

    this.restoringFiles.add(file.path);
    try {
      await this.delay(this.settings.delayAfterFileOpening);

      // Don't scroll when a link scrolls and highlights text
      let containsFlashingSpan =
        this.app.workspace.containerEl.querySelector(".is-flashing");
      if (containsFlashingSpan) return;

      if (view.file && view.file.path === file.path) {
        // Re-check: the view may have settled into the right spot during the delay
        const nowCurrent = this.getLeafEphemeralState(view);
        if (isNearSameState(nowCurrent, st)) return;
        this.setLeafEphemeralState(view, st);
      }
    } finally {
      setTimeout(() => this.restoringFiles.delete(file.path), 300);
    }
  }

  setLeafEphemeralState(view: MarkdownView, state: EphemeralState) {
    if (state.cursor && view.editor) {
      view.editor.setSelection(state.cursor.from, state.cursor.to);
    }

    if (typeof state.scroll === "number" && !isNaN(state.scroll)) {
      const scroll = state.scroll;
      const path = view.file?.path;
      if (path) this.restoringFiles.add(path);
      // CM6 schedules its scroll-to-cursor update in the next animation frame.
      // We need a double rAF so our applyScroll runs in the frame AFTER CM6's
      // scroll-to-cursor, otherwise CM6 overwrites the position we just set.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          view.setEphemeralState({ scroll });

          // @ts-ignore
          if (view.currentMode?.applyScroll) {
            // @ts-ignore
            view.currentMode.applyScroll(scroll);
          }

          if (path) {
            setTimeout(() => this.restoringFiles.delete(path), 300);
          }
        });
      });
    }
  }

  // ---- File Operations ----

  renameFile(file: TAbstractFile, oldPath: string) {
    if (!this.db[oldPath]) return;
    this.db[file.path] = this.db[oldPath];
    delete this.db[oldPath];
  }

  deleteFile(file: TAbstractFile) {
    delete this.db[file.path];
  }

  // ---- Database ----

  async readDb(): Promise<{ [file_path: string]: EphemeralState }> {
    const path = this.settings.dbFileName;
    if (!(await this.app.vault.adapter.exists(path))) return {};

    const data = await this.app.vault.adapter.read(path);
    try {
      return JSON.parse(data);
    } catch (e) {
      // Preserve the corrupt file for inspection, then start fresh.
      const backup = `${path}.bak`;
      try {
        await this.app.vault.adapter.write(backup, data);
      } catch {}
      console.error("Scroll Anchor: db parse failed, backed up to " + backup, e);
      return {};
    }
  }

  writeDb(db: { [file_path: string]: EphemeralState }): Promise<void> {
    // Serialize writes so concurrent callers can't interleave adapter.write.
    const run = async () => {
      const path = this.settings.dbFileName;
      const slash = path.lastIndexOf("/");
      if (slash > 0) {
        const parent = path.substring(0, slash);
        if (!(await this.app.vault.adapter.exists(parent))) {
          await this.app.vault.adapter.mkdir(parent);
        }
      }

      // Trim db if too large
      const keys = Object.keys(db);
      if (keys.length > this.settings.maxEntries) {
        const toRemove = keys.slice(0, keys.length - this.settings.maxEntries);
        for (const key of toRemove) {
          delete db[key];
        }
      }

      const serialized = JSON.stringify(db);
      if (serialized !== JSON.stringify(this.lastSavedDb)) {
        await this.app.vault.adapter.write(path, serialized);
        this.lastSavedDb = JSON.parse(serialized);
      }
    };

    const next = (this.writeInFlight ?? Promise.resolve())
      .catch(() => {})
      .then(run);
    this.writeInFlight = next;
    next.finally(() => {
      if (this.writeInFlight === next) this.writeInFlight = null;
    });
    return next;
  }

  // ---- Settings ----

  async loadSettings() {
    let settings: PluginSettings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData(),
    );
    if (!settings.dbFileName) {
      settings.dbFileName = `${this.app.vault.configDir}/plugins/scroll-anchor/cursor-positions.json`;
    }
    if (settings?.saveTimer < SAFE_DB_FLUSH_INTERVAL) {
      settings.saveTimer = SAFE_DB_FLUSH_INTERVAL;
    }
    this.settings = settings;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

class SettingTab extends PluginSettingTab {
  plugin: ScrollAnchor;

  constructor(app: App, plugin: ScrollAnchor) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    let { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl)
      .setName("Data file name")
      .setDesc("Save positions to this file")
      .addText((text) =>
        text
          .setPlaceholder("Example: cursor-positions.json")
          .setValue(this.plugin.settings.dbFileName)
          .onChange(async (value) => {
            this.plugin.settings.dbFileName = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Delay after opening a new note")
      .setDesc(
        "Delay before restoring scroll position after opening a note. Increase if the plugin interferes with links to headers like [link](note.md#header). Set to 0 if you don't use section links. Range: 0-300 ms (default: 50 ms).",
      )
      .addSlider((text) =>
        text
          .setLimits(0, 300, 10)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.delayAfterFileOpening)
          .onChange(async (value) => {
            this.plugin.settings.delayAfterFileOpening = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Save interval")
      .setDesc(
        "How often to save cursor positions to disk. Lower values reduce data loss if the app is killed. Range: 2000-20000 ms (default: 2000 ms).",
      )
      .addSlider((text) =>
        text
          .setLimits(SAFE_DB_FLUSH_INTERVAL, SAFE_DB_FLUSH_INTERVAL * 10, 10)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.saveTimer)
          .onChange(async (value) => {
            this.plugin.settings.saveTimer = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Max entries")
      .setDesc(
        "Maximum number of file positions to remember. Older entries are removed when this limit is exceeded. Default: 1000.",
      )
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.maxEntries))
          .onChange(async (value) => {
            const num = parseInt(value);
            if (!isNaN(num) && num > 0) {
              this.plugin.settings.maxEntries = num;
              await this.plugin.saveSettings();
            }
          }),
      );
  }
}
