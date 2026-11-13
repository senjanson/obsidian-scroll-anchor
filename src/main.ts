import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  MarkdownView,
  TAbstractFile,
  TFile,
  WorkspaceLeaf,
  normalizePath,
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

type PositionDb = { [file_path: string]: EphemeralState };

function isPos(p: unknown): p is { line: number; ch: number } {
  return (
    !!p &&
    typeof p === "object" &&
    Number.isInteger((p as any).line) &&
    Number.isInteger((p as any).ch) &&
    (p as any).line >= 0 &&
    (p as any).ch >= 0
  );
}

// Drop anything that is not a well-formed entry, so a hand-edited or
// half-synced file can never crash the plugin.
function sanitizeDb(raw: unknown): PositionDb {
  const db: PositionDb = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return db;
  for (const [path, v] of Object.entries(raw as Record<string, any>)) {
    if (path === "__proto__") continue; // would replace the object's prototype
    if (!v || typeof v !== "object") continue;
    const st: EphemeralState = {};
    if (typeof v.scroll === "number" && isFinite(v.scroll) && v.scroll >= 0) st.scroll = v.scroll;
    if (v.cursor && isPos(v.cursor.from) && isPos(v.cursor.to)) {
      st.cursor = {
        from: { line: v.cursor.from.line, ch: v.cursor.from.ch },
        to: { line: v.cursor.to.line, ch: v.cursor.to.ch },
      };
    }
    if (st.scroll !== undefined || st.cursor) db[path] = st;
  }
  return db;
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
  db: PositionDb;
  lastSavedDb: PositionDb;
  // Whether save is enabled (disabled during startup to prevent overwriting good data)
  saveEnabled = false;
  private scrollSaveTimeout: number | null = null;
  // Tracks the leaf the user is currently on, so active-leaf-change can save the *outgoing* leaf
  private lastActiveLeaf: WorkspaceLeaf | null = null;
  // Files currently being restored — saves are suppressed for these to avoid writing a transient scroll=0
  private restoringFiles: Set<string> = new Set();
  // Serializes writeDb calls to prevent interleaved adapter.write
  private writeInFlight: Promise<void> | null = null;
  // Which file each view last showed *and* had its position restored for.
  // Used to (a) skip restore when the user merely re-focuses a leaf that already
  // shows the file (split panes of the same note keep their own scroll), and
  // (b) skip saves while a leaf is mid-navigation (view.file already points to
  // the new file but the content/scroll still belong to the old state).
  // Keyed by view instance (not leaf): a leaf can get a brand-new view (deferred
  // tab loaded, view type switched back and forth), which must be restored again.
  private viewState: WeakMap<MarkdownView, { path: string; state?: EphemeralState }> =
    new WeakMap();
  private unloaded = false;
  // Views that were just sent to a specific spot (heading/block link, search
  // result, backlink, "go to line"...). Restoring would undo that jump.
  private navigatedAt: WeakMap<MarkdownView, number> = new WeakMap();
  private applyingOwnState = false;
  private pendingScrollViews: Set<MarkdownView> = new Set();
  private timers: number[] = [];
  private flushIntervalId: number | null = null;

  async onload() {
    await this.loadSettings();

    try {
      this.db = await this.readDb();
      this.lastSavedDb = JSON.parse(JSON.stringify(this.db));
    } catch (e) {
      console.error("Scroll Anchor: can't read database: " + e);
      this.db = {};
      this.lastSavedDb = {};
    }

    this.addSettingTab(new SettingTab(this.app, this));
    this.watchNavigation();

    // Restore all leaf positions after layout is ready.
    // Multiple passes give slow-rendering views a chance to receive the scroll position.
    this.app.workspace.onLayoutReady(() => {
      const passes = [500, 1200, 1800];
      for (const delay of passes) {
        this.later(() => {
          this.restoreAllLeafPositions();
        }, delay);
      }
      this.later(() => {
        const activeView = this.currentMarkdownView();
        this.lastActiveLeaf = activeView?.leaf ?? null;
        // Leaves that were visible at startup were handled by the restore passes.
        this.app.workspace.iterateAllLeaves((leaf) => {
          if (leaf.view instanceof MarkdownView && leaf.view.file) {
            this.viewState.set(leaf.view, { path: leaf.view.file.path });
          }
        });
        this.saveEnabled = true;
      }, 2200);
    });

    // Restore position when a new file is opened (for files opened after startup)
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file && this.saveEnabled) {
          const view = this.currentMarkdownView();
          if (view && view.file && view.file.path === file.path) {
            this.onLeafShowsFile(view, file);
          }
        }
      }),
    );

    // Save the *outgoing* leaf when switching tabs, and restore the *incoming* leaf.
    // file-open is unreliable for tab switches on some Obsidian versions, so we handle
    // restore here too — calling restoreLeafPosition twice is safe (no-op the second time).
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (newLeaf) => {
        // Only save the outgoing leaf when focus moves to a *different* leaf.
        // When a file is opened in the same leaf, that leaf's view already
        // points at the new file, so "saving the outgoing leaf" would write
        // the new file's transient (top-of-file) position over its saved one.
        if (this.saveEnabled && this.lastActiveLeaf && this.lastActiveLeaf !== newLeaf) {
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
            this.onLeafShowsFile(view, file);
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
      (evt: Event) => {
        if (!this.saveEnabled) return;
        // Save the pane that actually scrolled — it is often not the "active"
        // one (wheel over an unfocused split, or focus left in the sidebar).
        const target = evt.target instanceof Node ? evt.target : null;
        if (target) {
          const view = this.viewContaining(target);
          if (view) this.pendingScrollViews.add(view);
        }
        if (this.scrollSaveTimeout !== null) {
          window.clearTimeout(this.scrollSaveTimeout);
        }
        this.scrollSaveTimeout = window.setTimeout(() => {
          this.scrollSaveTimeout = null;
          const views = [...this.pendingScrollViews];
          this.pendingScrollViews.clear();
          for (const v of views) this.saveLeafPosition(v);
          this.saveActiveLeafPosition();
        }, 50);
      },
      true,
    );

    // Periodically flush db to disk
    this.restartFlushInterval();

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
    this.unloaded = true;
    if (this.scrollSaveTimeout !== null) {
      window.clearTimeout(this.scrollSaveTimeout);
      this.scrollSaveTimeout = null;
    }
    for (const id of this.timers) window.clearTimeout(id);
    this.timers = [];
    // Flush what we have so a disable / plugin update doesn't lose the last
    // few seconds of positions.
    if (this.saveEnabled) this.saveActiveLeafPosition();
    void this.writeDb(this.db);
  }

  // Obsidian hands the target of a link/search jump to the view through
  // setEphemeralState({ subpath | line | match | ... }) right before
  // "file-open" fires. Note it, so restore can stand aside.
  private watchNavigation() {
    const proto = MarkdownView.prototype as any;
    const original = proto.setEphemeralState;
    if (typeof original !== "function") return;
    const plugin = this;
    let active = true;
    const wrapper = function (this: MarkdownView, state: any) {
      if (
        active &&
        !plugin.applyingOwnState &&
        state &&
        (state.subpath || state.line !== undefined || state.match || state.cursor || state.startLoc)
      ) {
        plugin.navigatedAt.set(this, Date.now());
      }
      return original.call(this, state);
    };
    proto.setEphemeralState = wrapper;
    this.register(() => {
      active = false;
      // Only unwind if nobody wrapped on top of us; otherwise stay as a pass-through.
      if (proto.setEphemeralState === wrapper) proto.setEphemeralState = original;
    });
  }

  private recentlyNavigated(view: MarkdownView): boolean {
    const t = this.navigatedAt.get(view);
    return t !== undefined && Date.now() - t < 1500;
  }

  private later(fn: () => void, ms: number) {
    const id = window.setTimeout(() => {
      this.timers = this.timers.filter((t) => t !== id);
      if (!this.unloaded) fn();
    }, ms);
    this.timers.push(id);
  }

  restartFlushInterval() {
    if (this.flushIntervalId !== null) window.clearInterval(this.flushIntervalId);
    this.flushIntervalId = window.setInterval(() => {
      void this.writeDb(this.db);
    }, this.settings.saveTimer);
    this.registerInterval(this.flushIntervalId);
  }

  // Called whenever a leaf becomes active / opens a file. Restores only when the
  // leaf is showing this file for the first time (fresh open, navigation, or a
  // deferred tab being loaded) — never when the user just re-focuses a pane.
  onLeafShowsFile(view: MarkdownView, file: TFile) {
    const rec = this.viewState.get(view);
    if (rec && rec.path === file.path) {
      // Same pane, same note: keep this pane's own position (split panes of one
      // note stay independent). Only if something reset the view to the top
      // (e.g. it was moved to another split) put back this pane's last position.
      const current = this.getLeafEphemeralState(view);
      if (rec.state && !this.wasPositionedByOpener(current) && this.wasPositionedByOpener(rec.state)) {
        void this.restoreLeafPosition(view, file, rec.state);
      }
      return;
    }
    this.viewState.set(view, { path: file.path });
    void this.restoreLeafPosition(view, file);
  }

  // ---- Save Logic ----

  // The note the user is looking at. Clicking a note in the file explorer opens
  // it but leaves the explorer as the active leaf, so fall back to the most
  // recent leaf of the main area.
  currentMarkdownView(): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active) return active;
    const recent = this.app.workspace.getMostRecentLeaf();
    return recent && recent.view instanceof MarkdownView ? recent.view : null;
  }

  private viewContaining(node: Node): MarkdownView | null {
    let found: MarkdownView | null = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!found && leaf.view instanceof MarkdownView && leaf.view.containerEl.contains(node)) {
        found = leaf.view;
      }
    });
    return found;
  }

  saveActiveLeafPosition() {
    const view = this.currentMarkdownView();
    if (!view) return;
    this.saveLeafPosition(view);
  }

  saveLeafPosition(view: MarkdownView) {
    if (!view.file) return;
    // The leaf is mid-navigation (or was never registered): its scroll state does
    // not belong to view.file yet.
    const rec = this.viewState.get(view);
    if (!rec || rec.path !== view.file.path) return;
    // Suppress saves while a restore is in flight to avoid capturing a transient scroll=0
    if (this.restoringFiles.has(view.file.path)) return;

    const state = this.getLeafEphemeralState(view);
    if (typeof state.scroll !== "number" || isNaN(state.scroll)) return;

    rec.state = state;
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
    } catch (e) {
      // getEphemeralState is not available in all view states; ignore and fall back
    }

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

  async restoreLeafPosition(view: MarkdownView, file: TFile, override?: EphemeralState) {
    const st = override ?? this.db[file.path];
    if (!st) return;

    // Skip restore if the view is already at (or very near) the saved position.
    // This avoids the "flash" when switching between already-rendered tabs whose
    // DOM scroll state the browser has preserved naturally.
    const current = this.getLeafEphemeralState(view);
    if (isNearSameState(current, st)) return;

    this.restoringFiles.add(file.path);
    try {
      await this.delay(this.settings.delayAfterFileOpening);

      if (this.unloaded) return;
      if (this.recentlyNavigated(view)) return;
      // Don't scroll when a link scrolls and highlights text
      let containsFlashingSpan =
        this.app.workspace.containerEl.querySelector(".is-flashing");
      if (containsFlashingSpan) return;

      if (view.file && view.file.path === file.path) {
        // Re-check: the view may have settled into the right spot during the delay
        const nowCurrent = this.getLeafEphemeralState(view);
        if (isNearSameState(nowCurrent, st)) return;
        // Something else (a heading/block link, a search result, backlinks,
        // "go to line"...) already positioned this view: respect it.
        if (this.wasPositionedByOpener(nowCurrent)) return;
        this.setLeafEphemeralState(view, st, !!override);
      }
    } finally {
      setTimeout(() => this.restoringFiles.delete(file.path), 300);
    }
  }

  // A freshly opened note sits at the very top with the cursor at 0:0.
  // Anything else means the opener asked for a specific spot.
  wasPositionedByOpener(st: EphemeralState): boolean {
    const scrolled = typeof st.scroll === "number" && st.scroll > 1;
    const c = st.cursor;
    const cursorMoved =
      !!c && (c.from.line !== 0 || c.from.ch !== 0 || c.to.line !== 0 || c.to.ch !== 0);
    return scrolled || cursorMoved;
  }

  private applySelection(view: MarkdownView, state: EphemeralState) {
    if (!state.cursor || !view.editor) return;
    try {
      view.editor.setSelection(state.cursor.from, state.cursor.to);
    } catch (e) {
      // A stale or malformed cursor must never break restoring the scroll.
    }
  }

  setLeafEphemeralState(view: MarkdownView, state: EphemeralState, override = false) {
    this.applySelection(view, state);

    if (typeof state.scroll === "number" && !isNaN(state.scroll)) {
      const scroll = state.scroll;
      const path = view.file?.path;
      if (path) this.restoringFiles.add(path);
      // CM6 schedules its scroll-to-cursor update in the next animation frame.
      // We need a double rAF so our applyScroll runs in the frame AFTER CM6's
      // scroll-to-cursor, otherwise CM6 overwrites the position we just set.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (this.unloaded) return;
          if (!override && this.recentlyNavigated(view)) {
            if (path) setTimeout(() => this.restoringFiles.delete(path), 300);
            return;
          }
          // Obsidian may reset the selection while it finishes opening/focusing
          // the view (seen on 1.15 when the leaf is activated twice). Re-apply
          // it here, before the scroll, so the scroll still wins.
          const cur = view.editor?.getCursor("anchor");
          if (state.cursor && cur && cur.line === 0 && cur.ch === 0) {
            this.applySelection(view, state);
          }
          this.applyingOwnState = true;
          try {
            view.setEphemeralState({ scroll });
          } finally {
            this.applyingOwnState = false;
          }

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
    // Keep open leaves registered under the new path, otherwise saving would
    // stay blocked for a leaf whose file was renamed while open.
    this.app.workspace.iterateAllLeaves((leaf) => {
      const v = leaf.view;
      const rec = v instanceof MarkdownView ? this.viewState.get(v) : undefined;
      if (rec && rec.path === oldPath) rec.path = file.path;
    });
    const entry = this.db[oldPath];
    // Always drop a stale entry for the destination path, so a renamed file
    // never inherits the position of a different note that used to live there.
    delete this.db[file.path];
    if (!entry) return;
    this.db[file.path] = entry;
    delete this.db[oldPath];
  }

  deleteFile(file: TAbstractFile) {
    delete this.db[file.path];
  }

  // ---- Database ----

  private dbPath(): string {
    const raw = (this.settings.dbFileName || "").trim();
    const fallback = `${this.app.vault.configDir}/plugins/scroll-anchor/cursor-positions.json`;
    if (!raw || raw.endsWith("/")) return fallback;
    return normalizePath(raw);
  }

  private async readJson(path: string): Promise<PositionDb | null> {
    if (!(await this.app.vault.adapter.exists(path))) return null;
    const data = await this.app.vault.adapter.read(path);
    try {
      const parsed = JSON.parse(data);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      return sanitizeDb(parsed);
    } catch (e) {
      // Keep the unreadable file for inspection — but never clobber an earlier
      // backup with an empty/truncated one.
      if (data.trim().length > 0) {
        try {
          await this.app.vault.adapter.write(`${path}.bak`, data);
        } catch (backupErr) {
          console.error("Scroll Anchor: could not write backup", backupErr);
        }
      }
      console.error("Scroll Anchor: could not parse " + path, e);
      return null;
    }
  }

  async readDb(): Promise<PositionDb> {
    const path = this.dbPath();
    // The main file is written right after the ".tmp" copy, so if the app was
    // killed mid-write one of the two is always complete.
    return (await this.readJson(path)) ?? (await this.readJson(`${path}.tmp`)) ?? {};
  }

  writeDb(db: PositionDb): Promise<void> {
    // Serialize writes so concurrent callers can't interleave adapter.write.
    const run = async () => {
      const path = this.dbPath();
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
        // adapter.write truncates then writes; a kill in between leaves an empty
        // file. Write a full copy first so there is always one intact file.
        await this.app.vault.adapter.write(`${path}.tmp`, serialized);
        await this.app.vault.adapter.write(path, serialized);
        this.lastSavedDb = JSON.parse(serialized);
      }
    };

    const next = (this.writeInFlight ?? Promise.resolve())
      .catch(() => {})
      .then(run)
      .catch((e) => console.error("Scroll Anchor: could not save positions", e));
    this.writeInFlight = next;
    void next.finally(() => {
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
    if (!(settings.saveTimer >= SAFE_DB_FLUSH_INTERVAL)) {
      settings.saveTimer = SAFE_DB_FLUSH_INTERVAL;
    }
    if (!(Number.isInteger(settings.maxEntries) && settings.maxEntries > 0)) {
      settings.maxEntries = DEFAULT_SETTINGS.maxEntries;
    }
    if (!(settings.delayAfterFileOpening >= 0)) {
      settings.delayAfterFileOpening = DEFAULT_SETTINGS.delayAfterFileOpening;
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
            this.plugin.restartFlushInterval();
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
