import { App, MarkdownPostProcessorContext, Plugin, PluginSettingTab, Setting, TFile, Notice } from 'obsidian';
import { tableResizeExtension } from './cm6/tableResizeExtension';

export interface TableKey { path: string; lineStart: number; lineEnd: number; fingerprint: string }
interface TableSizes { ratios: number[]; lastPxWidth?: number; updatedAt: number }
interface PluginData { tables: Record<string, TableSizes>; version: number }

function normalizeFingerprint(fp: string): string {
  // Strip any '#index' suffix that LP may append
  const hash = fp.indexOf('#');
  return hash >= 0 ? fp.slice(0, hash) : fp;
}

function keyToString(key: TableKey): string {
  return JSON.stringify(key);
}

function canonicalKeyString(key: TableKey): string {
  return JSON.stringify({ path: key.path, fingerprint: normalizeFingerprint(key.fingerprint) });
}

interface TableDragSettings {
  minColumnWidthPx: number;
  requireAltToDrag: boolean;
  snapStepPx: number; // snapping step during drag
  keyboardStepPx: number; // arrow key step
  doubleClickAction: 'autofit' | 'reset' | 'none';
  wrapLongText: boolean; // allow long text/URLs to wrap in table cells
}

const DEFAULT_SETTINGS: TableDragSettings = {
  minColumnWidthPx: 60,
  requireAltToDrag: false,
  snapStepPx: 8,
  keyboardStepPx: 8,
  doubleClickAction: 'autofit',
  wrapLongText: true,
};

export default class TableDragPlugin extends Plugin {
  dataStore: PluginData = { tables: {}, version: 1 };
  settings: TableDragSettings = { ...DEFAULT_SETTINGS };

  async onload() {
    await this.loadDataStore();
    await this.loadSettings();

    // Reading view tables
    this.registerMarkdownPostProcessor((el, ctx) => this.processReadingTables(el, ctx));
    // Live Preview (CM6)
    this.registerEditorExtension(tableResizeExtension(this));

    this.addCommand({
      id: 'otd-reset-current-table',
      name: 'Reset current table widths',
      callback: () => this.resetCurrentTable(),
    });

    this.addSettingTab(new TableDragSettingTab(this.app, this));

    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.onFileRename(file as TFile, oldPath)));
  }

  onunload() {}

  private debug(...args: any[]) {
    // Lightweight debug helper; toggle with localStorage flag if needed
    try {
      const on = localStorage.getItem('otd-debug') === '1';
      if (on) console.debug('[otd]', ...args);
    } catch {}
  }

  private async loadDataStore() {
    const raw = await this.loadData();
    if (raw) this.dataStore = raw as PluginData;
  }
  private async saveDataStore() {
    await this.saveData(this.dataStore);
  }
  private async loadSettings() {
    const raw = (await this.loadData()) as PluginData | undefined;
    // Keep settings independent from table data for future evolution
    if (!raw || !(raw as any).settings) {
      this.settings = { ...DEFAULT_SETTINGS };
    } else {
      this.settings = { ...DEFAULT_SETTINGS, ...(raw as any).settings };
    }
  }
  async saveSettings() {
    // Persist settings alongside dataStore
    const merged: any = { ...this.dataStore, settings: this.settings };
    await this.saveData(merged);
  }

  private processReadingTables(sectionEl: HTMLElement, ctx: MarkdownPostProcessorContext) {
    // Use sectionEl for getSectionInfo to avoid null returns on child nodes
    const info = ctx.getSectionInfo(sectionEl);
    const path = ctx.sourcePath;

    sectionEl.querySelectorAll('table').forEach((table, idx) => {
      try {
        const fingerprint = this.computeFingerprint(table as HTMLTableElement);
        const key = info
          ? { path, lineStart: info.lineStart + idx, lineEnd: info.lineEnd + idx, fingerprint }
          : { path, lineStart: -1, lineEnd: -1, fingerprint };
        this.attachResizersWithKey(table as HTMLTableElement, key);
      } catch (e) {
        console.warn('[obsidian-table-drag] Failed to attach resizers:', e);
      }
    });
  }

  public computeFingerprint(table: HTMLTableElement): string {
    // Use header cells if available; otherwise fall back to first row's cells,
    // ensuring consistency between Reading view and Live Preview.
    let headerCells = Array.from(table.querySelectorAll('thead th')) as HTMLElement[];
    if (headerCells.length === 0) {
      const firstRow = table.querySelector('tr');
      if (firstRow) headerCells = Array.from(firstRow.querySelectorAll('th, td')) as HTMLElement[];
    }
    const header = headerCells.map((el) => (el.textContent || '').trim()).join('|');
    const cols = Math.max(0, ...Array.from(table.rows).map((r) => r.cells.length));
    return `${cols}:${header}`;
  }

  public attachResizersWithKey(table: HTMLTableElement, key: TableKey) {
    if (table.getAttribute('data-otd-bound') === '1') return; // idempotency guard

    // Prefer canonical key (path + normalized fingerprint). Migrate older keys if present.
    const resolvedKeyStr = this.findOrMigrateToCanonicalKey(key);

    // Determine column count from first row with max cells
    const colCount = Math.max(0, ...Array.from(table.rows).map((r) => r.cells.length));
    if (colCount < 2) return; // nothing to resize

    const cols = this.ensureColgroup(table, colCount);

    // Initialize widths
    const stored = this.dataStore.tables[resolvedKeyStr];
    this.debug('attachResizers', { path: key.path, fp: key.fingerprint, resolvedKeyStr, hasStored: !!stored });
    const tableRect = table.getBoundingClientRect();
    const containerWidth = Math.max(1, tableRect.width);

    let px: number[];
    if (stored && stored.ratios.length === colCount) {
      px = stored.ratios.map((r) => Math.max(this.settings.minColumnWidthPx, Math.round(r * containerWidth)));
    } else {
      // derive from header widths or equal split
      const headerCells = Array.from(table.querySelectorAll('thead th')) as HTMLTableCellElement[];
      if (headerCells.length === colCount) {
        px = headerCells.map((th) => Math.max(this.settings.minColumnWidthPx, Math.round(th.getBoundingClientRect().width)));
      } else {
        const base = Math.max(this.settings.minColumnWidthPx, Math.floor(containerWidth / colCount));
        px = new Array(colCount).fill(base);
      }
      // Normalize into ratios for future renders
      const ratios = normalizeRatios(px.map((w) => Math.max(1, w)));
      this.dataStore.tables[resolvedKeyStr] = { ratios, lastPxWidth: containerWidth, updatedAt: Date.now() };
      void this.saveDataStore();
    }

    // Apply widths via <colgroup>
    this.applyColWidths(cols, px);

    // Optional wrapping behavior for long text/URLs
    if (this.settings.wrapLongText) {
      table.classList.add('otd-wrap');
    } else {
      table.classList.remove('otd-wrap');
    }

    // Place handles on header cells when possible, otherwise first row's cells
    const headerRow = table.querySelector('thead tr') as HTMLTableRowElement | null;
    const row = headerRow ?? (table.querySelector('tr') as HTMLTableRowElement | null);
    if (!row) return;
    const cells = Array.from(row.cells) as HTMLTableCellElement[];

    for (let i = 0; i < Math.min(colCount - 1, cells.length - 0); i++) {
      const cell = cells[i];
      cell.classList.add('otd-th');
      const handle = document.createElement('div');
      handle.className = 'otd-handle';
      handle.setAttribute('data-otd-index', String(i));
      handle.setAttribute('role', 'separator');
      handle.setAttribute('aria-label', `Resize column ${i + 1}`);
      handle.tabIndex = 0;
      cell.appendChild(handle);

      // Make the handle span the full table height for discoverability
      {
        const tRect = table.getBoundingClientRect();
        const cRect = cell.getBoundingClientRect();
        layoutHandleToTableWithRects(handle, tRect, cRect);
      }

      let startX = 0;
      let leftWidth = 0;
      let rightWidth = 0;
      let active = false;

      const onPointerMove = (ev: PointerEvent) => {
        if (!active) return;
        const dx = ev.clientX - startX;
        const total = leftWidth + rightWidth;
        const disableSnap = ev.ctrlKey || (ev as any).metaKey;
        const { newLeft, newRight } = applyDeltaWithSnap(leftWidth, rightWidth, total, dx, this.settings.minColumnWidthPx, this.settings.snapStepPx, disableSnap);
        // Update widths live
        const cur = getColWidths(cols);
        cur[i] = newLeft;
        cur[i + 1] = newRight;
        this.applyColWidths(cols, cur);
      };

      const onPointerUp = (_ev: PointerEvent) => {
        if (!active) return;
        active = false;
        handle.releasePointerCapture((_ev as any).pointerId);
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        // Persist ratios
        const finalPx = getColWidths(cols);
        const ratios = normalizeRatios(finalPx);
        this.dataStore.tables[resolvedKeyStr] = { ratios, lastPxWidth: containerWidth, updatedAt: Date.now() };
        void this.saveDataStore();
      };

      // Pointer drag
      handle.addEventListener('pointerdown', (ev: PointerEvent) => {
        if (this.settings.requireAltToDrag && !ev.altKey) return; // require modifier if configured
        ev.preventDefault();
        ev.stopPropagation();
        active = true;
        startX = ev.clientX;
        handle.setPointerCapture((ev as any).pointerId);
        handle.focus();
        const cur = getColWidths(cols);
        leftWidth = cur[i];
        rightWidth = cur[i + 1];
        window.addEventListener('pointermove', onPointerMove, { passive: true });
        window.addEventListener('pointerup', onPointerUp, { passive: true });
      });

      // Double-click: autofit column
      handle.addEventListener('dblclick', (ev: MouseEvent) => {
        ev.preventDefault();
        const cur = getColWidths(cols);
        const total = cur[i] + cur[i + 1];
        if (this.settings.doubleClickAction === 'autofit') {
          const targetWidth = Math.max(this.settings.minColumnWidthPx, measureAutofitWidth(table, i));
          const delta = targetWidth - cur[i];
          const { newLeft, newRight } = applyDeltaWithSnap(cur[i], cur[i + 1], total, delta, this.settings.minColumnWidthPx, this.settings.snapStepPx, false);
          cur[i] = newLeft; cur[i + 1] = newRight;
        } else if (this.settings.doubleClickAction === 'reset') {
          const half = Math.max(this.settings.minColumnWidthPx, Math.floor(total / 2));
          cur[i] = half; cur[i + 1] = total - half;
        } else {
          return;
        }
        this.applyColWidths(cols, cur);
        const ratios = normalizeRatios(cur);
        this.dataStore.tables[resolvedKeyStr] = { ratios, lastPxWidth: containerWidth, updatedAt: Date.now() };
        void this.saveDataStore();
      });

      // Keyboard support
      handle.addEventListener('keydown', (ev: KeyboardEvent) => {
        const cur = getColWidths(cols);
        const total = cur[i] + cur[i + 1];
        let used = false;
        const step = (ev.ctrlKey || (ev as any).metaKey) ? 1 : this.settings.keyboardStepPx;
        if (ev.key === 'ArrowLeft') {
          const { newLeft, newRight } = applyDeltaWithSnap(cur[i], cur[i + 1], total, -step, this.settings.minColumnWidthPx, this.settings.snapStepPx, true);
          cur[i] = newLeft; cur[i + 1] = newRight; used = true;
        } else if (ev.key === 'ArrowRight') {
          const { newLeft, newRight } = applyDeltaWithSnap(cur[i], cur[i + 1], total, step, this.settings.minColumnWidthPx, this.settings.snapStepPx, true);
          cur[i] = newLeft; cur[i + 1] = newRight; used = true;
        } else if (ev.key === 'Enter' || ev.key === ' ') {
          if (this.settings.doubleClickAction === 'autofit') {
            const targetWidth = Math.max(this.settings.minColumnWidthPx, measureAutofitWidth(table, i));
            const delta = targetWidth - cur[i];
            const res = applyDeltaWithSnap(cur[i], cur[i + 1], total, delta, this.settings.minColumnWidthPx, this.settings.snapStepPx, false);
            cur[i] = res.newLeft; cur[i + 1] = res.newRight; used = true;
          } else if (this.settings.doubleClickAction === 'reset') {
            const half = Math.max(this.settings.minColumnWidthPx, Math.floor(total / 2));
            cur[i] = half; cur[i + 1] = total - half; used = true;
          }
        }
        if (used) {
          ev.preventDefault();
          this.applyColWidths(cols, cur);
          const ratios = normalizeRatios(cur);
          this.dataStore.tables[resolvedKeyStr] = { ratios, lastPxWidth: containerWidth, updatedAt: Date.now() };
          void this.saveDataStore();
        }
      });
    }

    // Update handle heights when the table resizes (schedule via rAF to avoid ResizeObserver loop errors)
    let layoutPending = false;
    const ro = new ResizeObserver(() => {
      if (layoutPending) return;
      layoutPending = true;
      requestAnimationFrame(() => {
        layoutPending = false;
        const tRect = table.getBoundingClientRect();
        const handles = table.querySelectorAll('.otd-handle');
        handles.forEach((h) => {
          const idx = Number((h as HTMLElement).getAttribute('data-otd-index'));
          const cell = cells[idx];
          if (!cell) return;
          const cRect = cell.getBoundingClientRect();
          layoutHandleToTableWithRects(h as HTMLElement, tRect, cRect);
        });
      });
    });
    ro.observe(table);

    table.setAttribute('data-otd-bound', '1');
  }

  private ensureColgroup(table: HTMLTableElement, colCount: number): HTMLTableColElement[] {
    // Find or create a namespaced colgroup for our widths
    let colgroupEl = table.querySelector('colgroup[data-otd="1"]') as HTMLTableElement | null;
    if (!colgroupEl) {
      const existing = table.querySelector('colgroup');
      colgroupEl = document.createElement('colgroup');
      colgroupEl.setAttribute('data-otd', '1');
      if (existing) {
        table.insertBefore(colgroupEl, existing.nextSibling);
      } else {
        table.insertBefore(colgroupEl, table.firstChild);
      }
    }
    // Ensure the right number of <col>
    let cols = Array.from(colgroupEl.querySelectorAll('col')) as HTMLTableColElement[];
    while (cols.length < colCount) {
      const c = document.createElement('col');
      colgroupEl.appendChild(c);
      cols.push(c as any);
    }
    while (cols.length > colCount) {
      const c = cols.pop();
      if (c) c.remove();
    }
    return cols as any;
  }

  private applyColWidths(cols: HTMLTableColElement[], px: number[]) {
    for (let i = 0; i < cols.length && i < px.length; i++) {
      const w = Math.max(this.settings.minColumnWidthPx, Math.floor(px[i]));
      (cols[i] as any).style.width = `${w}px`;
    }
  }

  private resetCurrentTable() {
    // No-op placeholder: command wiring present for future enhancement
    new Notice('Table Drag: Reset command not yet implemented for cursor context.');
  }

  private onFileRename(file: TFile, oldPath: string) {
    const updates: Record<string, TableSizes> = {};
    for (const [k, v] of Object.entries(this.dataStore.tables)) {
      const keyObj = JSON.parse(k) as TableKey;
      if (keyObj.path === oldPath) keyObj.path = file.path;
      updates[JSON.stringify(keyObj)] = v;
    }
    this.dataStore.tables = updates;
    void this.saveDataStore();
  }

  private findOrMigrateToCanonicalKey(key: TableKey): string {
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
}

class TableDragSettingTab extends PluginSettingTab {
  plugin: TableDragPlugin;
  constructor(app: App, plugin: TableDragPlugin) { super(app, plugin); this.plugin = plugin; }
  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Obsidian Table Drag' });

    new Setting(containerEl)
      .setName('Minimum column width (px)')
      .setDesc('Columns will not shrink below this width')
      .addText((t) => t.setPlaceholder('60').setValue(String(this.plugin.settings.minColumnWidthPx)).onChange(async (v) => {
        const n = parseInt(v, 10);
        if (!Number.isNaN(n) && n > 0) {
          this.plugin.settings.minColumnWidthPx = n; await this.plugin.saveSettings();
        }
      }));

    new Setting(containerEl)
      .setName('Snap step (px)')
      .setDesc('Widths snap to this increment during drag. Hold Ctrl/Cmd to bypass.')
      .addText((t) => t.setPlaceholder('8').setValue(String(this.plugin.settings.snapStepPx)).onChange(async (v) => {
        const n = parseInt(v, 10);
        if (!Number.isNaN(n) && n > 0) { this.plugin.settings.snapStepPx = n; await this.plugin.saveSettings(); }
      }));

    new Setting(containerEl)
      .setName('Keyboard step (px)')
      .setDesc('Arrow keys resize by this many pixels (Ctrl/Cmd = 1px).')
      .addText((t) => t.setPlaceholder('8').setValue(String(this.plugin.settings.keyboardStepPx)).onChange(async (v) => {
        const n = parseInt(v, 10);
        if (!Number.isNaN(n) && n > 0) { this.plugin.settings.keyboardStepPx = n; await this.plugin.saveSettings(); }
      }));

    new Setting(containerEl)
      .setName('Double-click action')
      .setDesc('Action when double-clicking a handle (or pressing Enter/Space)')
      .addDropdown((d) => {
        d.addOptions({ 'autofit': 'Autofit', 'reset': 'Reset', 'none': 'None' })
         .setValue(this.plugin.settings.doubleClickAction)
         .onChange(async (v) => { this.plugin.settings.doubleClickAction = v as any; await this.plugin.saveSettings(); });
      });

    new Setting(containerEl)
      .setName('Wrap long text in cells')
      .setDesc('Allows long URLs and text to wrap when columns are narrow; increases row height as needed.')
      .addToggle((t) => t.setValue(this.plugin.settings.wrapLongText).onChange(async (v) => {
        this.plugin.settings.wrapLongText = v; await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Require Alt key to drag')
      .setDesc('If enabled, hold Alt while dragging to resize (reduces conflicts)')
      .addToggle((t) => t.setValue(this.plugin.settings.requireAltToDrag).onChange(async (v) => {
        this.plugin.settings.requireAltToDrag = v; await this.plugin.saveSettings();
      }));
  }
}

function normalizeRatios(px: number[]): number[] {
  const sum = px.reduce((a, b) => a + Math.max(1, b), 0);
  if (sum <= 0) return px.map(() => 1 / px.length);
  return px.map((w) => Math.max(1, w) / sum);
}

function getColWidths(cols: HTMLTableColElement[]): number[] {
  return cols.map((c) => {
    const v = (c.style.width || '').trim();
    const n = parseFloat(v.replace('px', ''));
    return Number.isFinite(n) ? n : 0;
  }) as number[];
}

function roundToStep(v: number, step: number) { return step > 0 ? Math.round(v / step) * step : v; }

function applyDeltaWithSnap(left: number, right: number, total: number, dx: number, minPx: number, step: number, disableSnap: boolean): { newLeft: number; newRight: number } {
  let nl = left + dx;
  nl = Math.max(minPx, Math.min(total - minPx, nl));
  if (!disableSnap && step > 0) {
    nl = roundToStep(nl, step);
    nl = Math.max(minPx, Math.min(total - minPx, nl));
  }
  const nr = total - nl;
  return { newLeft: nl, newRight: nr };
}

function layoutHandleToTableWithRects(handle: HTMLElement, tableRect: DOMRect, cellRect: DOMRect) {
  const deltaTop = tableRect.top - cellRect.top;
  handle.style.top = `${deltaTop}px`;
  handle.style.height = `${Math.max(0, tableRect.height)}px`;
}

function measureAutofitWidth(table: HTMLTableElement, colIndex: number): number {
  let max = 0;
  const rows = Array.from(table.rows) as HTMLTableRowElement[];
  for (const r of rows) {
    if (colIndex >= r.cells.length) continue;
    const cell = r.cells[colIndex] as HTMLTableCellElement;
    if (!cell) continue;
    const style = getComputedStyle(cell);
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const contentWidth = cell.scrollWidth || cell.clientWidth;
    const w = Math.ceil(contentWidth + padding + 2); // small buffer
    if (w > max) max = w;
  }
  return max;
}
