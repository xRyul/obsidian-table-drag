import { Plugin, TFile, Notice } from 'obsidian';
import { tableResizeExtension } from './cm6/tableResizeExtension';
import type { TableKey } from './types';
import { StorageManager } from './storage/StorageManager';
import { BreakoutManager } from './breakout/BreakoutManager';
import { DebugManager } from './debug/DebugManager';
import { TableManager } from './table/TableManager';
import { TableDragSettingTab } from './settings/SettingsTab';

export type { TableKey } from './types';

export default class TableDragPlugin extends Plugin {
  public storage!: StorageManager;
  public breakout!: BreakoutManager;
  public debug!: DebugManager;
  public table!: TableManager;

  async onload() {
    // Initialize managers
    this.storage = new StorageManager(this);
    await this.storage.loadDataStore();
    await this.storage.loadSettings();

    // Create breakout manager (needs settings)
    this.breakout = new BreakoutManager(
      this.storage.settings,
      (event, details) => this.debug?.log(event, details)
    );

    // Create debug manager (needs breakout for snapshots)
    this.debug = new DebugManager(this.storage.settings, this.breakout);

    // Create table manager (needs all other managers)
    this.table = new TableManager(
      this,
      this.storage.settings,
      this.storage,
      this.breakout,
      (event, details) => this.debug.log(event, details)
    );

    // Reading view tables
    this.registerMarkdownPostProcessor((el, ctx) => this.table.processReadingTables(el, ctx));
    
    // Live Preview (CM6)
    this.registerEditorExtension(tableResizeExtension(this));

    // Debug commands
    this.addCommand({
      id: 'otd-copy-debug-log',
      name: 'Table Drag: Copy debug log',
      callback: () => this.debug.copyDebugLog(
        (t) => this.table.computeFingerprint(t),
        this.storage.dataStore.version
      )
    });

    this.addCommand({
      id: 'otd-clear-debug-log',
      name: 'Table Drag: Clear debug log',
      callback: () => this.debug.clearDebugLog()
    });

    // File rename handler
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) =>
        this.storage.onFileRename(file as TFile, oldPath)
      )
    );

    // Settings tab
    this.addSettingTab(new TableDragSettingTab(this.app, this));
  }

  onunload() {
    // Cleanup is handled automatically by Obsidian for registered events/extensions
  }

  // Public API for CM6 extension
  public scheduleBreakoutForTable(table: HTMLTableElement, delayMs = 0): void {
    this.breakout.scheduleBreakoutForTable(table, delayMs);
  }

  public computeFingerprint(table: HTMLTableElement): string {
    return this.table.computeFingerprint(table);
  }

  public applyStoredRatiosPx(table: HTMLTableElement, key: TableKey): void {
    this.table.applyStoredRatiosPx(table, key);
  }

  public attachResizersWithKey(table: HTMLTableElement, key: TableKey): void {
    this.table.attachResizersWithKey(table, key);
  }

  // Settings access for backward compatibility
  get settings() {
    return this.storage?.settings;
  }
}
