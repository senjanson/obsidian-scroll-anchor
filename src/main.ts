import { App, Plugin, PluginSettingTab, Setting, MarkdownView, TAbstractFile, Editor, TFile, WorkspaceLeaf } from 'obsidian';

interface PluginSettings {
	dbFileName: string;
	delayAfterFileOpening: number;
	saveTimer: number;
	maxEntries: number;
}

const SAFE_DB_FLUSH_INTERVAL = 2000;

const DEFAULT_SETTINGS: PluginSettings = {
	dbFileName: '.obsidian/plugins/scroll-anchor/cursor-positions.json',
	delayAfterFileOpening: 50,
	saveTimer: SAFE_DB_FLUSH_INTERVAL,
	maxEntries: 1000,
};

interface EphemeralState {
	cursor?: {
		from: {
			ch: number
			line: number
		},
		to: {
			ch: number
			line: number
		}
	},
	scroll?: number
}


export default class ScrollAnchor extends Plugin {
	settings: PluginSettings;
	db: { [file_path: string]: EphemeralState };
	lastSavedDb: { [file_path: string]: EphemeralState };
	// Whether save is enabled (disabled during startup to prevent overwriting good data)
	saveEnabled = false;
	private scrollSaveTimeout: number | null = null;

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

		// Restore all leaf positions after layout is ready
		this.app.workspace.onLayoutReady(() => {
			// Wait for views to fully render before restoring
			setTimeout(() => {
				this.restoreAllLeafPositions();

				// Wait for scroll to settle before enabling saves
				// This prevents the periodic save from overwriting restored positions with 0
				setTimeout(() => {
					this.saveEnabled = true;
				}, 1000);
			}, 500);
		});

		// Restore position when a new file is opened (for files opened after startup)
		this.registerEvent(
			this.app.workspace.on('file-open', (file) => {
				if (file && this.saveEnabled) {
					this.restoreActiveLeafPosition(file);
				}
			})
		);

		// Save active leaf position when switching tabs
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				if (this.saveEnabled) {
					this.saveActiveLeafPosition();
				}
			})
		);

		// Save on quit — only flush db, don't re-read positions (views may be tearing down)
		this.registerEvent(
			this.app.workspace.on('quit', () => {
				this.writeDb(this.db);
			}),
		);

		// Handle file rename
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => this.renameFile(file, oldPath)),
		);

		// Handle file delete
		this.registerEvent(
			this.app.vault.on('delete', (file) => this.deleteFile(file)),
		);

		// Periodically save active leaf position
		this.registerInterval(
			window.setInterval(() => {
				if (this.saveEnabled) {
					this.saveActiveLeafPosition();
				}
			}, 100)
		);

		// Save on scroll stop (debounced) — captures position as soon as user stops scrolling
		this.registerDomEvent(window, 'scroll', () => {
			if (!this.saveEnabled) return;
			if (this.scrollSaveTimeout !== null) {
				window.clearTimeout(this.scrollSaveTimeout);
			}
			this.scrollSaveTimeout = window.setTimeout(() => {
				this.saveActiveLeafPosition();
				this.scrollSaveTimeout = null;
			}, 50);
		}, true);

		// Periodically flush db to disk
		this.registerInterval(
			window.setInterval(() => this.writeDb(this.db), this.settings.saveTimer)
		);

		// Capture beforeunload — only flush, don't re-read positions
		this.registerDomEvent(window, 'beforeunload', () => {
			this.writeDb(this.db);
		});

		// visibilitychange for mobile — save + flush
		this.registerDomEvent(document, 'visibilitychange', () => {
			if (document.visibilityState === 'hidden') {
				if (this.saveEnabled) {
					this.saveActiveLeafPosition();
				}
				this.writeDb(this.db);
			}
		});
	}

	// ---- Save Logic ----

	saveActiveLeafPosition() {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !view.file) return;

		const state = this.getLeafEphemeralState(view);
		if (!state || isNaN(state.scroll)) return;

		// Guard: don't overwrite a previously saved non-zero scroll with 0
		// This prevents data corruption during view transitions
		const existing = this.db[view.file.path];
		if (existing && existing.scroll > 0 && state.scroll === 0) {
			return;
		}

		this.db[view.file.path] = state;
	}

	getLeafEphemeralState(view: MarkdownView): EphemeralState {
		let state: EphemeralState = {};

		// @ts-ignore - currentMode is not in the public API
		state.scroll = Number(view.currentMode?.getScroll()?.toFixed(4));

		let editor = view.editor;
		if (editor) {
			let from = editor.getCursor("anchor");
			let to = editor.getCursor("head");
			if (from && to) {
				state.cursor = {
					from: { ch: from.ch, line: from.line },
					to: { ch: to.ch, line: to.line }
				};
			}
		}

		return state;
	}

	// ---- Restore Logic ----

	async restoreAllLeafPositions() {
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

	async restoreActiveLeafPosition(file: TFile) {
		const st = this.db[file.path];
		if (!st) return;

		// Wait for note to finish loading
		await this.delay(this.settings.delayAfterFileOpening);

		// Don't scroll when a link scrolls and highlights text
		let containsFlashingSpan = this.app.workspace.containerEl.querySelector('.is-flashing');
		if (containsFlashingSpan) return;

		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view && view.file && view.file.path === file.path) {
			this.setLeafEphemeralState(view, st);
		}
	}

	setLeafEphemeralState(view: MarkdownView, state: EphemeralState) {
		if (state.cursor && view.editor) {
			view.editor.setSelection(state.cursor.from, state.cursor.to);
		}

		if (state.scroll) {
			// Use both methods for maximum compatibility
			view.setEphemeralState({ scroll: state.scroll });

			// @ts-ignore
			if (view.currentMode?.applyScroll) {
				// @ts-ignore
				view.currentMode.applyScroll(state.scroll);
			}
		}
	}

	// ---- File Operations ----

	renameFile(file: TAbstractFile, oldPath: string) {
		this.db[file.path] = this.db[oldPath];
		delete this.db[oldPath];
	}

	deleteFile(file: TAbstractFile) {
		delete this.db[file.path];
	}

	// ---- Database ----

	async readDb(): Promise<{ [file_path: string]: EphemeralState }> {
		let db: { [file_path: string]: EphemeralState } = {};

		if (await this.app.vault.adapter.exists(this.settings.dbFileName)) {
			let data = await this.app.vault.adapter.read(this.settings.dbFileName);
			db = JSON.parse(data);
		}

		return db;
	}

	async writeDb(db: { [file_path: string]: EphemeralState }) {
		let newParentFolder = this.settings.dbFileName.substring(0, this.settings.dbFileName.lastIndexOf("/"));
		if (!(await this.app.vault.adapter.exists(newParentFolder)))
			await this.app.vault.adapter.mkdir(newParentFolder);

		// Trim db if too large
		const keys = Object.keys(db);
		if (keys.length > this.settings.maxEntries) {
			const toRemove = keys.slice(0, keys.length - this.settings.maxEntries);
			for (const key of toRemove) {
				delete db[key];
			}
		}

		if (JSON.stringify(this.db) !== JSON.stringify(this.lastSavedDb)) {
			await this.app.vault.adapter.write(
				this.settings.dbFileName,
				JSON.stringify(db)
			);
			this.lastSavedDb = JSON.parse(JSON.stringify(db));
		}
	}

	// ---- Settings ----

	async loadSettings() {
		let settings: PluginSettings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
		if (settings?.saveTimer < SAFE_DB_FLUSH_INTERVAL) {
			settings.saveTimer = SAFE_DB_FLUSH_INTERVAL;
		}
		this.settings = settings;
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async delay(ms: number) {
		return new Promise(resolve => setTimeout(resolve, ms));
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

		containerEl.createEl('h2', { text: 'Scroll Anchor - Settings' });

		new Setting(containerEl)
			.setName('Data file name')
			.setDesc('Save positions to this file')
			.addText((text) =>
				text
					.setPlaceholder('Example: cursor-positions.json')
					.setValue(this.plugin.settings.dbFileName)
					.onChange(async (value) => {
						this.plugin.settings.dbFileName = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Delay after opening a new note')
			.setDesc(
				"Delay before restoring scroll position after opening a note. Increase if the plugin interferes with links to headers like [link](note.md#header). Set to 0 if you don't use section links. Range: 0-300 ms (default: 50 ms)."
			)
			.addSlider((text) =>
				text
					.setLimits(0, 300, 10)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.delayAfterFileOpening)
					.onChange(async (value) => {
						this.plugin.settings.delayAfterFileOpening = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Save interval')
			.setDesc(
				"How often to save cursor positions to disk. Lower values reduce data loss if the app is killed. Range: 2000-20000 ms (default: 2000 ms)."
			)
			.addSlider((text) =>
				text
					.setLimits(SAFE_DB_FLUSH_INTERVAL, SAFE_DB_FLUSH_INTERVAL * 10, 10)
					.setDynamicTooltip()
					.setValue(this.plugin.settings.saveTimer)
					.onChange(async (value) => {
						this.plugin.settings.saveTimer = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName('Max entries')
			.setDesc(
				"Maximum number of file positions to remember. Older entries are removed when this limit is exceeded. Default: 1000."
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
					})
			);
	}
}
