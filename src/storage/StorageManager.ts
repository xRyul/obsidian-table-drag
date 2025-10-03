import type { Plugin, TFile } from 'obsidian';
import type { PluginData, TableKey, TableSizes, TableDragSettings } from '../types';
import { DEFAULT_SETTINGS } from '../types';
import { canonicalKeyString, normalizeFingerprint } from '../utils/helpers';

export class StorageManager {
  dataStore: PluginData = { tables: {}, version: 1 };
  settings: TableDragSettings = { ...DEFAULT_SETTINGS };

  constructor(private plugin: Plugin) {}

  async loadDataStore(): Promise<void> {
    const raw = await this.plugin.loadData();
    if (raw) this.dataStore = raw as PluginData;
  }

  async saveDataStore(): Promise<void> {
    await this.plugin.saveData(this.dataStore);
  }

  async loadSettings(): Promise<void> {
    const raw = (await this.plugin.loadData()) as PluginData | undefined;
    // Keep settings independent from table data for future evolution
    if (!raw || !(raw as any).settings) {
      this.settings = { ...DEFAULT_SETTINGS };
    } else {
      this.settings = { ...DEFAULT_SETTINGS, ...(raw as any).settings };
    }
  }

  async saveSettings(): Promise<void> {
    // Persist settings alongside dataStore
    const merged: any = { ...this.dataStore, settings: this.settings };
    await this.plugin.saveData(merged);
  }

  findOrMigrateToCanonicalKey(key: TableKey): string {
    const canonical = canonicalKeyString(key);
    if (this.dataStore.tables[canonical]) return canonical;

    // If any legacy key exists for this path+normalized fingerprint, migrate it to canonical
    const norm = normalizeFingerprint(key.fingerprint);
    let bestKey: string | null = null;
    let bestTs = -1;
    for (const [k, v] of Object.entries(this.dataStore.tables)) {
      try {
        const kk = JSON.parse(k) as any;
        if (kk.path !== key.path) continue;
        const kfp = typeof kk.fingerprint === 'string' ? normalizeFingerprint(kk.fingerprint) : (kk.fingerprint?.fp || '');
        if (kfp !== norm) continue;
        if (v.updatedAt > bestTs) { bestTs = v.updatedAt; bestKey = k; }
      } catch {}
    }
    if (bestKey) {
      this.dataStore.tables[canonical] = this.dataStore.tables[bestKey];
      // Keep the legacy entry for a while to avoid breaking older references; we could delete later.
      void this.saveDataStore();
      return canonical;
    }
    return canonical; // will create under canonical on first save
  }

  onFileRename(file: TFile, oldPath: string): void {
    const updates: Record<string, TableSizes> = {};
    for (const [k, v] of Object.entries(this.dataStore.tables)) {
      const keyObj = JSON.parse(k) as TableKey;
      if (keyObj.path === oldPath) keyObj.path = file.path;
      updates[JSON.stringify(keyObj)] = v;
    }
    this.dataStore.tables = updates;
    void this.saveDataStore();
  }

  /**
   * Get the most recent saved table sizes entry for a given file path, regardless of fingerprint.
   * Useful for adapting widths when the table structure (column count/headers) changes.
   */
  getLatestForPath(path: string): { key: TableKey, keyStr: string, sizes: TableSizes } | null {
    let best: { key: TableKey, keyStr: string, sizes: TableSizes } | null = null;
    let bestTs = -1;
    for (const [k, v] of Object.entries(this.dataStore.tables)) {
      try {
        const keyObj = JSON.parse(k) as TableKey;
        if (keyObj.path !== path) continue;
        const sizes = v as TableSizes;
        const ts = typeof sizes?.updatedAt === 'number' ? sizes.updatedAt : 0;
        if (ts > bestTs) {
          best = { key: keyObj, keyStr: k, sizes };
          bestTs = ts;
        }
      } catch {}
    }
    return best;
  }
}
