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
const MISSING_FILE_GRACE = 5 * 60 * 1000;

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
    // An entry for a note at the very top tells us nothing: opening it puts
    // it there anyway. Older versions stored one for every note ever opened.
    if (!isAtTop(st)) db[path] = st;
  }
  return db;
}

// A freshly opened note sits at the very top with the cursor at 0:0.
function isShown(el: HTMLElement): boolean {
  const fn = (el as any).isShown;
  return typeof fn === "function" ? fn.call(el) : el.offsetParent !== null;
}

function isAtTop(st: EphemeralState): boolean {
  const scrolled = typeof st.scroll === "number" && st.scroll > 1;
  const c = st.cursor;
  const cursorMoved =
    !!c && (c.from.line !== 0 || c.from.ch !== 0 || c.to.line !== 0 || c.to.ch !== 0);
  return !scrolled && !cursorMoved;
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
  if (Math.abs(a.scroll - b.scroll) >= 1) return false;
  // Same scroll but a different cursor (e.g. a short note that can't scroll)
  // still needs restoring.
  if (b.cursor && !sameEphemeralState({ cursor: a.cursor }, { cursor: b.cursor })) return false;
  return true;
}

export default class ScrollAnchor extends Plugin {
  settings!: PluginSettings;
  db: PositionDb = {};
  // Entries changed (or removed: null) since the last write. Empty means the
  // file on disk already matches, so there is nothing to serialize or write.
  // Also used to merge with a copy written by another device.
  private changes: Map<string, EphemeralState | null> = new Map();
  // What the data file looked like after our last read or write, to notice
  // when a sync service replaces it with another device's copy.
  private diskStamp: { path: string; mtime: number; size: number } | null = null;
  // The data file's text as of our last read or write: the common base when
  // merging another device's copy.
  private diskText: string | null = null;
  // Entries whose note was missing at startup; dropped if still missing later.
  private missingAtStartup: Set<string> | null = null;
  // The file on disk was broken or held junk entries: rewrite it once.
  private rewrite = false;
  // Whether save is enabled (disabled during startup to prevent overwriting good data)
  saveEnabled = false;
  private scrollSaveTimeout: number | null = null;
  // Tracks the leaf the user is currently on, so active-leaf-change can save the *outgoing* leaf
  private lastActiveLeaf: WorkspaceLeaf | null = null;
  // Files currently being restored — saves are suppressed for these to avoid writing a transient scroll=0
  private restoringFiles: Set<string> = new Set();
  // Serializes flush calls to prevent interleaved adapter.write
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
  // Views the user scrolled, clicked or typed in before saving was enabled at
  // startup. The startup restore passes leave them alone.
  private touchedAtStartup: WeakSet<MarkdownView> = new WeakSet();
  // Popout windows we listen on, with the function that stops listening.
  private windowListeners: Map<Window, () => void> = new Map();
  private timers: number[] = [];
  private flushIntervalId: number | null = null;

  async onload() {
    await this.loadSettings();

    try {
      this.db = await this.readDb();
    } catch (e) {
      console.error("Scroll Anchor: can't read database: " + e);
      this.db = {};
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
        // The user may have scrolled or followed a link while saving was off.
        // Record those panes now, since their scroll events were ignored.
        this.app.workspace.iterateAllLeaves((leaf) => {
          const v = leaf.view;
          if (v instanceof MarkdownView && (this.touchedAtStartup.has(v) || this.navigatedAt.has(v))) {
            this.saveLeafPosition(v);
          }
        });
        // Notes deleted while Obsidian was closed never fire "delete". Note
        // which entries point nowhere now, and drop them only if they are
        // still missing a few minutes later, so a device that is still
        // downloading notes from sync doesn't throw away their positions.
        this.checkMissingFiles();
      }, 2200);
      this.later(() => this.checkMissingFiles(), MISSING_FILE_GRACE);
    });

    // Loading a saved workspace layout (or anything else that rebuilds panes)
    // can show notes in panes that never become active, so active-leaf-change
    // and file-open never reach them. Pick up every visible pane we don't know.
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        if (!this.saveEnabled) return;
        this.app.workspace.iterateAllLeaves((leaf) => {
          const view = leaf.view;
          if (!(view instanceof MarkdownView) || !view.file) return;
          const rec = this.viewState.get(view);
          if (rec && rec.path === view.file.path) return;
          if (!isShown(view.containerEl)) return;
          this.onLeafShowsFile(view, view.file);
        });
      }),
    );

    // Popout windows have their own DOM: listen for scrolls there too.
    this.listenOnWindow(window);
    this.registerEvent(
      this.app.workspace.on("window-open", (_win, win) => this.listenOnWindow(win)),
    );
    this.registerEvent(
      this.app.workspace.on("window-close", (_win, win) => {
        const stop = this.windowListeners.get(win);
        if (stop) {
          stop();
          this.windowListeners.delete(win);
        }
      }),
    );
    // Popouts that were already open when the plugin loaded (plugin update).
    const floating = (this.app.workspace as any).floatingSplit;
    for (const child of floating?.children ?? []) {
      if (child?.win && child.win !== window) this.listenOnWindow(child.win);
    }
    this.register(() => {
      for (const stop of this.windowListeners.values()) stop();
      this.windowListeners.clear();
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
        void this.flush(false);
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

    // Periodically flush db to disk
    this.restartFlushInterval();

    // Capture beforeunload — only flush, don't re-read positions
    this.registerDomEvent(window, "beforeunload", () => {
      void this.flush(false);
    });

    // visibilitychange for mobile — save + flush
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        if (this.saveEnabled) {
          this.saveActiveLeafPosition();
        }
        // Going to the background: write right away, no time for a sync check.
        void this.flush(false);
      } else {
        // Back from the background: sync may have brought another device's copy.
        void this.flush(true);
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
    void this.flush(false);
  }

  // Save on scroll stop (debounced): captures the position as soon as the user
  // stops scrolling. Also notes which panes the user touched during startup.
  private listenOnWindow(win: Window) {
    if (this.windowListeners.has(win)) return;
    const onScroll = (evt: Event) => this.onScrollEvent(evt);
    const onInput = (evt: Event) => this.onUserInput(evt);
    const inputs = ["wheel", "mousedown", "keydown", "touchstart"];
    win.addEventListener("scroll", onScroll, true);
    for (const t of inputs) win.addEventListener(t, onInput, { capture: true, passive: true });
    this.windowListeners.set(win, () => {
      win.removeEventListener("scroll", onScroll, true);
      for (const t of inputs) win.removeEventListener(t, onInput, true);
    });
  }

  private onUserInput(evt: Event) {
    if (this.saveEnabled) return;
    const target = evt.target instanceof Node ? evt.target : null;
    const view = (target && this.viewContaining(target)) ?? (evt.type === "keydown" ? this.currentMarkdownView() : null);
    if (view) this.touchedAtStartup.add(view);
  }

  private onScrollEvent(evt: Event) {
    if (!this.saveEnabled) return;
    // Save the pane that actually scrolled — it is often not the "active"
    // one (wheel over an unfocused split, focus left in the sidebar, or a
    // pane in a popout window).
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
      void this.flush(true);
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
    if (isAtTop(state)) {
      // Back at the top: forget the old spot instead of storing a useless entry.
      if (existing) this.removeEntry(path);
      return;
    }
    if (existing && sameEphemeralState(existing, state)) return;
    this.setEntry(path, state);
  }

  private setEntry(path: string, state: EphemeralState) {
    // Re-insert to refresh insertion order so maxEntries trim behaves as LRU.
    delete this.db[path];
    this.db[path] = state;
    this.changes.set(path, state);
  }

  private removeEntry(path: string) {
    if (!Object.prototype.hasOwnProperty.call(this.db, path)) return;
    delete this.db[path];
    this.changes.set(path, null);
  }

  // First call (at startup) remembers which entries point to a note that does
  // not exist; a later call drops those that are still missing.
  checkMissingFiles() {
    const missing = Object.keys(this.db).filter(
      (p) => !(this.app.vault.getAbstractFileByPath(p) instanceof TFile),
    );
    if (this.missingAtStartup === null) {
      this.missingAtStartup = new Set(missing);
      return;
    }
    for (const p of missing) {
      if (this.missingAtStartup.has(p)) this.removeEntry(p);
    }
    this.missingAtStartup = new Set();
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
        // Leave alone panes the user already scrolled, clicked or typed in,
        // or that a link jump positioned, since startup.
        if (this.touchedAtStartup.has(leaf.view) || this.navigatedAt.has(leaf.view)) return;
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

  // Anything but "top of the note, cursor at 0:0" means the opener asked for a
  // specific spot.
  wasPositionedByOpener(st: EphemeralState): boolean {
    return !isAtTop(st);
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
    this.removeEntry(file.path);
    if (!entry) return;
    this.removeEntry(oldPath);
    this.setEntry(file.path, entry);
  }

  deleteFile(file: TAbstractFile) {
    this.removeEntry(file.path);
  }

  // ---- Database ----

  private dbPath(): string {
    const raw = (this.settings.dbFileName || "").trim();
    const fallback = `${this.app.vault.configDir}/plugins/scroll-anchor/cursor-positions.json`;
    if (!raw || raw.endsWith("/")) return fallback;
    const path = normalizePath(raw);
    // Obsidian refuses paths outside the vault; fall back instead of failing every save.
    if (path.split("/").some((part) => part === "..")) return fallback;
    return path;
  }

  private async readJson(
    path: string,
  ): Promise<{ db: PositionDb; clean: boolean; text: string } | null> {
    if (!(await this.app.vault.adapter.exists(path))) return null;
    const data = await this.app.vault.adapter.read(path);
    try {
      const parsed = JSON.parse(data);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      const db = sanitizeDb(parsed);
      // "clean" = nothing was dropped, so the file needs no rewrite.
      return { db, clean: Object.keys(db).length === Object.keys(parsed).length, text: data };
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

  private async stampOf(path: string) {
    try {
      const st = await this.app.vault.adapter.stat(path);
      return st ? { path, mtime: st.mtime, size: st.size } : null;
    } catch (e) {
      return null;
    }
  }

  async readDb(): Promise<PositionDb> {
    const path = this.dbPath();
    // The main file is written right after the ".tmp" copy, so if the app was
    // killed mid-write one of the two is always complete.
    const main = await this.readJson(path);
    const res = main ?? (await this.readJson(`${path}.tmp`));
    this.diskStamp = await this.stampOf(path);
    this.diskText = main ? main.text : null;
    if (!res) return {};
    // Rewrite the main file if it was broken or held junk entries.
    if (!main || !res.clean) this.rewrite = true;
    return res.db;
  }

  // Another device's copy arrived through sync. Three-way merge against what
  // we last read or wrote: take each entry the other device changed, unless
  // it changed here too since our last write. An entry the other copy lacks
  // is kept: that copy may simply not have seen our last write yet.
  private mergeExternal(external: PositionDb) {
    let base: PositionDb = {};
    try {
      base = this.diskText ? sanitizeDb(JSON.parse(this.diskText)) : {};
    } catch (e) {
      // no usable base: treat every entry of the other copy as changed
    }
    for (const [path, st] of Object.entries(external)) {
      if (this.changes.has(path)) continue;
      const b = base[path];
      if (b && sameEphemeralState(b, st)) continue;
      delete this.db[path];
      this.db[path] = st;
    }
    // If we hold anything the other copy lacks or has differently, write the
    // union back so the other device gets it too.
    for (const [path, st] of Object.entries(this.db)) {
      const e = external[path];
      if (!e || !sameEphemeralState(e, st)) {
        this.rewrite = true;
        break;
      }
    }
  }

  // Write pending changes. With checkDisk, first look whether the file was
  // replaced by another device (one cheap stat) and merge it in. Exit paths
  // (quit, background, disable) skip the check to write as fast as possible.
  flush(checkDisk: boolean): Promise<void> {
    // Serialize so concurrent callers can't interleave adapter.write.
    const run = async () => {
      const path = this.dbPath();

      if (checkDisk) {
        const stamp = await this.stampOf(path);
        const prev = this.diskStamp;
        if (prev && prev.path !== path) {
          // The data file setting changed: start tracking the new file. The
          // next change writes the whole db there (same as before).
          this.diskStamp = stamp;
        } else if (stamp && (!prev || stamp.mtime !== prev.mtime || stamp.size !== prev.size)) {
          const ext = await this.readJson(path);
          if (ext) {
            this.mergeExternal(ext.db);
            this.diskText = ext.text;
          }
          this.diskStamp = stamp;
        }
      }

      // Trim db if too large
      const keys = Object.keys(this.db);
      if (keys.length > this.settings.maxEntries) {
        for (const key of keys.slice(0, keys.length - this.settings.maxEntries)) {
          this.removeEntry(key);
        }
      }

      if (this.changes.size === 0 && !this.rewrite) return;
      const pending = this.changes;
      this.changes = new Map();
      this.rewrite = false;
      try {
        const slash = path.lastIndexOf("/");
        if (slash > 0) {
          const parent = path.substring(0, slash);
          if (!(await this.app.vault.adapter.exists(parent))) {
            await this.app.vault.adapter.mkdir(parent);
          }
        }
        const serialized = JSON.stringify(this.db);
        // adapter.write truncates then writes; a kill in between leaves an empty
        // file. Write a full copy first so there is always one intact file.
        await this.app.vault.adapter.write(`${path}.tmp`, serialized);
        await this.app.vault.adapter.write(path, serialized);
        this.diskText = serialized;
        this.diskStamp = await this.stampOf(path);
      } catch (e) {
        // Keep the changes so the next flush tries again.
        for (const [p, st] of pending) if (!this.changes.has(p)) this.changes.set(p, st);
        this.rewrite = true;
        throw e;
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
