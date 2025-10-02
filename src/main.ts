import { App, MarkdownPostProcessorContext, Plugin, PluginSettingTab, Setting, TFile, Notice } from 'obsidian';
import { tableResizeExtension } from './cm6/tableResizeExtension';

export interface TableKey { path: string; lineStart: number; lineEnd: number; fingerprint: string }
interface TableSizes { ratios: number[]; lastPxWidth?: number; rowHeights?: Record<number, number>; updatedAt: number }
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
  enableRowResize: boolean; // show row handles
  rowMinHeightPx: number;
  rowKeyboardStepPx: number;
  // Diagnostics
  enableDebugLogs: boolean;
  debugVerbose: boolean;
  debugBufferSize: number;
}

const DEFAULT_SETTINGS: TableDragSettings = {
  minColumnWidthPx: 60,
  requireAltToDrag: false,
  snapStepPx: 8,
  keyboardStepPx: 8,
  doubleClickAction: 'autofit',
  wrapLongText: true,
  enableRowResize: true,
  rowMinHeightPx: 24,
  rowKeyboardStepPx: 4,
  enableDebugLogs: false,
  debugVerbose: false,
  debugBufferSize: 500,
};

export default class TableDragPlugin extends Plugin {
  dataStore: PluginData = { tables: {}, version: 1 };
  settings: TableDragSettings = { ...DEFAULT_SETTINGS };
  private lastActiveTableEl: HTMLTableElement | null = null;
  private lastActiveKey: TableKey | null = null;
  private debugBuffer: { ts: number; event: string; details?: any }[] = [];

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

    // Phase 5 commands
    this.addCommand({
      id: 'otd-materialize-insert-html-copy',
      name: 'Materialize widths: insert HTML copy of last active table',
      callback: () => this.materializeInsertHtmlCopy(),
    });
    this.addCommand({
      id: 'otd-materialize-copy-to-clipboard',
      name: 'Materialize widths: copy HTML of last active table',
      callback: () => this.materializeCopyToClipboard(),
    });

    // Debug commands
    this.addCommand({ id: 'otd-copy-debug-log', name: 'Table Drag: Copy debug log', callback: () => this.copyDebugLog() });
    this.addCommand({ id: 'otd-clear-debug-log', name: 'Table Drag: Clear debug log', callback: () => this.clearDebugLog() });

    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.onFileRename(file as TFile, oldPath)));
  }

  onunload() {}

  private log(event: string, details?: any) {
    if (!this.settings.enableDebugLogs) return;
    const entry = { ts: Date.now(), event, details: this.settings.debugVerbose ? details : undefined };
    this.debugBuffer.push(entry);
    if (this.debugBuffer.length > Math.max(50, this.settings.debugBufferSize)) this.debugBuffer.shift();
    try { console.debug('[otd]', event, details ?? ''); } catch {}
  }

  private copyDebugLog() {
    const lines = this.debugBuffer.map(e => ({ ts: new Date(e.ts).toISOString(), event: e.event, details: e.details }));
    const text = JSON.stringify({ version: this.dataStore?.version ?? 1, settings: this.settings, logs: lines }, null, 2);
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => new Notice('Table Drag: Debug log copied to clipboard.'));
    } else {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      new Notice('Table Drag: Debug log copied to clipboard.');
    }
  }

  private clearDebugLog() { this.debugBuffer = []; new Notice('Table Drag: Debug log cleared.'); }

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
    const alreadyBound = table.getAttribute('data-otd-bound') === '1';

    // Prefer canonical key (path + normalized fingerprint). Migrate older keys if present.
    const resolvedKeyStr = this.findOrMigrateToCanonicalKey(key);

    // Determine column count from first row with max cells
    const colCount = Math.max(0, ...Array.from(table.rows).map((r) => r.cells.length));
    if (colCount < 2) return; // nothing to resize

    const cols = this.ensureColgroup(table, colCount);

    // Initialize widths
    const stored = this.dataStore.tables[resolvedKeyStr];
    const tableRect = table.getBoundingClientRect();
    const containerWidth = Math.max(0, tableRect.width);

    // If we have stored ratios, apply robustly (px if container > 0; else % and reapply on resize)
    if (stored && stored.ratios.length === colCount) {
      if (containerWidth > 0) {
        const px = stored.ratios.map((r) => Math.max(this.settings.minColumnWidthPx, Math.round(r * containerWidth)));
        this.applyColWidths(cols, px);
        table.classList.add('otd-managed');
        this.log('rv-apply-px', { key: resolvedKeyStr, container: containerWidth, px });
      } else {
        this.applyRatiosAsPercent(cols, stored.ratios);
        table.classList.add('otd-managed');
        this.log('rv-apply-%', { key: resolvedKeyStr, ratios: stored.ratios });
        const ro = new ResizeObserver(() => {
          const w = table.getBoundingClientRect().width;
          if (w && w > 0) {
            const px = stored.ratios.map((r) => Math.max(this.settings.minColumnWidthPx, Math.round(r * w)));
            this.applyColWidths(cols, px);
            this.log('rv-apply-px-late', { key: resolvedKeyStr, container: w, px });
            ro.disconnect();
          }
        });
        ro.observe(table);
      }
    } else {
      // derive from header widths or equal split
      let px: number[];
      const headerCells = Array.from(table.querySelectorAll('thead th')) as HTMLTableCellElement[];
      if (headerCells.length === colCount) {
        px = headerCells.map((th) => Math.max(this.settings.minColumnWidthPx, Math.round(th.getBoundingClientRect().width)));
      } else {
        const base = Math.max(this.settings.minColumnWidthPx, Math.floor(Math.max(1, containerWidth) / colCount));
        px = new Array(colCount).fill(base);
      }
      // Normalize into ratios for future renders
      const ratios = normalizeRatios(px.map((w) => Math.max(1, w)));
      this.dataStore.tables[resolvedKeyStr] = { ratios, lastPxWidth: Math.max(1, containerWidth), updatedAt: Date.now() };
      this.log('init-ratios', { key: resolvedKeyStr, ratios });
      void this.saveDataStore();
      this.applyColWidths(cols, px);
      table.classList.add('otd-managed');
    }

    // Optional wrapping behavior for long text/URLs
    if (this.settings.wrapLongText) {
      table.classList.add('otd-wrap');
    } else {
      table.classList.remove('otd-wrap');
    }

    // Apply persisted row heights if any
    const storedRowHeights = stored?.rowHeights ?? {};
    if (storedRowHeights && Object.keys(storedRowHeights).length > 0) {
      Array.from(table.rows).forEach((r, idx) => {
        const h = storedRowHeights[idx];
        if (typeof h === 'number' && h > 0) {
          (r as HTMLTableRowElement).style.height = `${Math.max(this.settings.rowMinHeightPx, Math.floor(h))}px`;
        }
      });
    }

    // Place handles on header cells when possible, otherwise first row's cells
    const headerRow = table.querySelector('thead tr') as HTMLTableRowElement | null;
    const row = headerRow ?? (table.querySelector('tr') as HTMLTableRowElement | null);
    if (!row) return;
    const cells = Array.from(row.cells) as HTMLTableCellElement[];

    for (let i = 0; i < Math.min(colCount - 1, cells.length - 0); i++) {
      const cell = cells[i];
      cell.classList.add('otd-th');
      let handle = cell.querySelector('.otd-handle[data-otd-index="'+i+'"]') as HTMLDivElement | null;
      if (!handle) {
        handle = document.createElement('div');
        handle.className = 'otd-handle';
        handle.setAttribute('data-otd-index', String(i));
        handle.setAttribute('role', 'separator');
        handle.setAttribute('aria-label', `Resize column ${i + 1}`);
        handle.tabIndex = 0;
        cell.appendChild(handle);
      }

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
        this.log('persist-drag', { key: resolvedKeyStr, ratios });
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
        // remember last active table/key for materialization
        this.lastActiveTableEl = table;
        this.lastActiveKey = key;
        const cur = getColWidths(cols);
        leftWidth = cur[i];
        rightWidth = cur[i + 1];
        window.addEventListener('pointermove', onPointerMove, { passive: true });
        window.addEventListener('pointerup', onPointerUp, { passive: true });
      });

      // Double-click: autofit column
      handle.addEventListener('dblclick', (ev: MouseEvent) => {
        // remember last active
        this.lastActiveTableEl = table;
        this.lastActiveKey = key;
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
        this.log('persist-dblclick', { key: resolvedKeyStr, ratios });
        void this.saveDataStore();
      });

      // Keyboard support
      handle.addEventListener('keydown', (ev: KeyboardEvent) => {
        // remember last active
        this.lastActiveTableEl = table;
        this.lastActiveKey = key;
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
          this.log('persist-keyboard', { key: resolvedKeyStr, ratios });
          void this.saveDataStore();
        }
      });
    }

    // Row resize handles
    if (this.settings.enableRowResize) {
      const rows = Array.from(table.rows) as HTMLTableRowElement[];
      rows.forEach((row, rIndex) => {
        // Append row handle to the first cell to own positioning context
        const firstCell = row.cells[0] as HTMLTableCellElement | undefined;
        if (!firstCell) return;
        let rHandle = firstCell.querySelector('.otd-rhandle[data-otd-row-index="'+rIndex+'"]') as HTMLDivElement | null;
        if (!rHandle) {
          rHandle = document.createElement('div') as HTMLDivElement;
          rHandle.className = 'otd-rhandle';
          rHandle.setAttribute('tabindex', '0');
          rHandle.setAttribute('role', 'separator');
          rHandle.setAttribute('aria-label', `Resize row ${rIndex + 1}`);
          rHandle.setAttribute('data-otd-row-index', String(rIndex));
          firstCell.style.position = firstCell.style.position || 'relative';
          firstCell.appendChild(rHandle);
        }

        // Initial layout
        {
          const tRect = table.getBoundingClientRect();
          const cRect = firstCell.getBoundingClientRect();
          const rRect = row.getBoundingClientRect();
          layoutRowHandleWithRects(rHandle, tRect, cRect, rRect);
        }

        let startY = 0;
        let startHeight = 0;
        let activeR = false;
        const onRMove = (ev: PointerEvent) => {
          if (!activeR) return;
          const dy = ev.clientY - startY;
          const target = Math.max(this.settings.rowMinHeightPx, Math.floor(startHeight + dy));
          row.style.height = `${target}px`;
        };
        const onRUp = (_ev: PointerEvent) => {
          if (!activeR) return;
          activeR = false;
          rHandle.releasePointerCapture((_ev as any).pointerId);
          window.removeEventListener('pointermove', onRMove);
          window.removeEventListener('pointerup', onRUp);
          // Persist row height
          const finalH = Math.max(this.settings.rowMinHeightPx, Math.floor(row.getBoundingClientRect().height));
          const keyData = this.dataStore.tables[resolvedKeyStr] ?? { ratios: stored?.ratios ?? px.map((w)=>w/px.reduce((a,b)=>a+b,0)), updatedAt: Date.now() };
          keyData.rowHeights = keyData.rowHeights || {};
          keyData.rowHeights[rIndex] = finalH;
          keyData.updatedAt = Date.now();
          this.dataStore.tables[resolvedKeyStr] = keyData;
          this.log('persist-row-drag', { key: resolvedKeyStr, rIndex, height: finalH });
          void this.saveDataStore();
        };
        rHandle.addEventListener('pointerdown', (ev: PointerEvent) => {
          ev.preventDefault();
          ev.stopPropagation();
          activeR = true;
          startY = ev.clientY;
          startHeight = row.getBoundingClientRect().height;
          rHandle.setPointerCapture((ev as any).pointerId);
          rHandle.focus();
          window.addEventListener('pointermove', onRMove, { passive: true });
          window.addEventListener('pointerup', onRUp, { passive: true });
        });
        rHandle.addEventListener('keydown', (ev: KeyboardEvent) => {
          let used = false;
          let target = row.getBoundingClientRect().height;
          const step = (ev.ctrlKey || (ev as any).metaKey) ? 1 : this.settings.rowKeyboardStepPx;
          if (ev.key === 'ArrowUp') { target = Math.max(this.settings.rowMinHeightPx, Math.floor(target - step)); used = true; }
          if (ev.key === 'ArrowDown') { target = Math.max(this.settings.rowMinHeightPx, Math.floor(target + step)); used = true; }
          if ((ev.key === 'Enter' || ev.key === ' ') && row.style.height) { row.style.height = ''; used = true; }
          if (used) {
            ev.preventDefault();
            row.style.height = `${target}px`;
            const keyData = this.dataStore.tables[resolvedKeyStr] ?? { ratios: stored?.ratios ?? px.map((w)=>w/px.reduce((a,b)=>a+b,0)), updatedAt: Date.now() };
            keyData.rowHeights = keyData.rowHeights || {};
            keyData.rowHeights[rIndex] = target;
            keyData.updatedAt = Date.now();
            this.dataStore.tables[resolvedKeyStr] = keyData;
            this.log('persist-row-keyboard', { key: resolvedKeyStr, rIndex, height: target });
            void this.saveDataStore();
          }
        });
      });
    }

    // Update handle layout when the table resizes (schedule via rAF to avoid ResizeObserver loop errors)
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
        if (this.settings.enableRowResize) {
          const rows = Array.from(table.rows) as HTMLTableRowElement[];
          rows.forEach((row, rIndex) => {
            const firstCell = row.cells[0] as HTMLTableCellElement | undefined;
            if (!firstCell) return;
            const rHandle = firstCell.querySelector('.otd-rhandle[data-otd-row-index="'+rIndex+'"]') as HTMLElement | null;
            if (!rHandle) return;
            const cRect = firstCell.getBoundingClientRect();
            const rRect = row.getBoundingClientRect();
            layoutRowHandleWithRects(rHandle, tRect, cRect, rRect);
          });
        }
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

  private applyRatiosAsPercent(cols: HTMLTableColElement[], ratios: number[]) {
    for (let i = 0; i < cols.length && i < ratios.length; i++) {
      const pct = Math.max(1, Math.round(ratios[i] * 10000) / 100); // 2 decimals
      (cols[i] as any).style.width = `${pct}%`;
    }
  }

  public applyStoredRatiosPercent(table: HTMLTableElement, key: TableKey) {
    const colCount = Math.max(0, ...Array.from(table.rows).map((r) => r.cells.length));
    if (colCount < 2) return;
    const cols = this.ensureColgroup(table, colCount);
    const kstr = this.findOrMigrateToCanonicalKey(key);
    const stored = this.dataStore.tables[kstr];
    if (!stored || !stored.ratios || stored.ratios.length !== colCount) return;
    this.applyRatiosAsPercent(cols, stored.ratios);
  }

  public applyStoredRatiosPx(table: HTMLTableElement, key: TableKey) {
    const colCount = Math.max(0, ...Array.from(table.rows).map((r) => r.cells.length));
    if (colCount < 2) return;
    const cols = this.ensureColgroup(table, colCount);
    const kstr = this.findOrMigrateToCanonicalKey(key);
    const stored = this.dataStore.tables[kstr];
    if (!stored || !stored.ratios || stored.ratios.length !== colCount) return;
    let w = table.getBoundingClientRect().width;
    if (!w || w <= 0) w = stored.lastPxWidth || 0;
    if (!w || w <= 0) return;
    const px = stored.ratios.map(r => Math.max(this.settings.minColumnWidthPx, Math.round(r * w)));
    this.applyColWidths(cols, px);
    table.classList.add('otd-managed');
    this.log('lp-apply-px', { key: kstr, container: w, px });
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

  private buildMaterializedHtml(table: HTMLTableElement, keyStr: string): string | null {
    const stored = this.dataStore.tables[keyStr];
    if (!stored) return null;
    const ratios = stored.ratios;
    if (!ratios || ratios.length === 0) return null;
    // Build a fresh copy of the current table DOM to capture content
    const clone = table.cloneNode(true) as HTMLTableElement;
    // Remove any existing colgroups
    Array.from(clone.querySelectorAll('colgroup')).forEach((cg) => cg.remove());
    const cg = document.createElement('colgroup');
    ratios.forEach((r) => {
      const col = document.createElement('col');
      const pct = Math.max(1, Math.round(r * 10000) / 100); // 2 decimal places
      (col as any).setAttribute('style', `width: ${pct}%`);
      cg.appendChild(col);
    });
    clone.insertBefore(cg, clone.firstChild);
    clone.setAttribute('data-otd-materialized', '1');
    // Serialize
    const div = document.createElement('div');
    div.appendChild(clone);
    return div.innerHTML;
  }

  private materializeInsertHtmlCopy() {
    const view = this.app.workspace.getActiveViewOfType((this.app as any).workspace.getActiveViewOfType?.constructor) as any;
    const mdView = this.app.workspace.getActiveViewOfType((this.app as any).plugins?.plugins?.['markdown']?.MarkdownView || (window as any).MarkdownView) || this.app.workspace.getActiveViewOfType((window as any).MarkdownView);
    const editorView = this.app.workspace.getActiveViewOfType((window as any).MarkdownView);
    const editor = editorView?.editor ?? (this.app.workspace.getActiveViewOfType((window as any).MarkdownView) as any)?.editor;
    const table = this.lastActiveTableEl;
    const key = this.lastActiveKey;
    if (!editor || !table || !key) {
      new Notice('Table Drag: No recent table interaction found to materialize. Click/drag a table first.');
      return;
    }
    const keyStr = this.findOrMigrateToCanonicalKey(key);
    const html = this.buildMaterializedHtml(table, keyStr);
    if (!html) { new Notice('Table Drag: No stored widths for this table.'); return; }
    const pos = editor.getCursor();
    editor.replaceRange(`\n\n<!-- Materialized table (otd) -->\n${html}\n\n`, pos);
    new Notice('Inserted materialized HTML table at cursor.');
  }

  private materializeCopyToClipboard() {
    const table = this.lastActiveTableEl;
    const key = this.lastActiveKey;
    if (!table || !key) { new Notice('Table Drag: No recent table to copy. Click/drag a table first.'); return; }
    const keyStr = this.findOrMigrateToCanonicalKey(key);
    const html = this.buildMaterializedHtml(table, keyStr);
    if (!html) { new Notice('Table Drag: No stored widths for this table.'); return; }
    navigator.clipboard.writeText(html).then(() => new Notice('Materialized table HTML copied to clipboard.'));
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

    // Row resizing
    containerEl.createEl('h3', { text: 'Row resizing' });
    new Setting(containerEl)
      .setName('Enable row resizing')
      .setDesc('Show horizontal handles to adjust row heights')
      .addToggle((t) => t.setValue(this.plugin.settings.enableRowResize).onChange(async (v) => {
        this.plugin.settings.enableRowResize = v; await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName('Row minimum height (px)')
      .setDesc('Rows will not be resized below this height')
      .addText((t) => t.setPlaceholder('24').setValue(String(this.plugin.settings.rowMinHeightPx)).onChange(async (v) => {
        const n = parseInt(v, 10);
        if (!Number.isNaN(n) && n > 0) { this.plugin.settings.rowMinHeightPx = n; await this.plugin.saveSettings(); }
      }));
    new Setting(containerEl)
      .setName('Row keyboard step (px)')
      .setDesc('ArrowUp/ArrowDown resize rows by this many pixels (Ctrl/Cmd = 1px).')
      .addText((t) => t.setPlaceholder('4').setValue(String(this.plugin.settings.rowKeyboardStepPx)).onChange(async (v) => {
        const n = parseInt(v, 10);
        if (!Number.isNaN(n) && n > 0) { this.plugin.settings.rowKeyboardStepPx = n; await this.plugin.saveSettings(); }
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

    // Diagnostics
    containerEl.createEl('h3', { text: 'Diagnostics' });
    new Setting(containerEl)
      .setName('Enable debug logs')
      .setDesc('When enabled, the plugin collects a detailed log to help troubleshoot issues.')
      .addToggle((t) => t.setValue(this.plugin.settings.enableDebugLogs).onChange(async (v) => { this.plugin.settings.enableDebugLogs = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName('Verbose details')
      .setDesc('Include detailed arrays (ratios/widths) in the log')
      .addToggle((t) => t.setValue(this.plugin.settings.debugVerbose).onChange(async (v) => { this.plugin.settings.debugVerbose = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName('Debug buffer size')
      .setDesc('Maximum number of log entries to keep in memory')
      .addText((t) => t.setPlaceholder('500').setValue(String(this.plugin.settings.debugBufferSize)).onChange(async (v) => {
        const n = parseInt(v, 10); if (!Number.isNaN(n) && n > 50) { this.plugin.settings.debugBufferSize = n; await this.plugin.saveSettings(); }
      }));
    new Setting(containerEl)
      .addButton((b) => b.setButtonText('Copy debug log').onClick(() => this.plugin.copyDebugLog()))
      .addButton((b) => b.setButtonText('Clear debug log').setWarning().onClick(() => this.plugin.clearDebugLog()));
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

function layoutRowHandleWithRects(handle: HTMLElement, tableRect: DOMRect, firstCellRect: DOMRect, rowRect: DOMRect) {
  // Position at the row's bottom edge across full table width
  const top = rowRect.bottom - firstCellRect.top - (handle.getBoundingClientRect().height || 6);
  const left = tableRect.left - firstCellRect.left;
  handle.style.top = `${Math.max(0, top)}px`;
  handle.style.left = `${left}px`;
  handle.style.width = `${Math.max(0, tableRect.width)}px`;
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
