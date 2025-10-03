import { App, MarkdownPostProcessorContext, Plugin, PluginSettingTab, Setting, TFile, Notice } from 'obsidian';
import { tableResizeExtension } from './cm6/tableResizeExtension';

export interface TableKey { path: string; lineStart: number; lineEnd: number; fingerprint: string }
interface TableSizes { ratios: number[]; lastPxWidth?: number; rowHeights?: Record<number, number>; tablePxWidth?: number; updatedAt: number }
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
  // Outer width handle
  showOuterWidthHandle: boolean;
  outerHandleMode: 'edge' | 'scale';
  outerMaxWidthPx: number; // 0 = unlimited
  // Breakout padding from pane edges (prevents hugging sidebars)
  bleedWideTables?: boolean; // when true, apply a small gutter on both sides in breakout
  bleedGutterPx?: number;    // size of the gutter on each side
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
  showOuterWidthHandle: true,
  outerHandleMode: 'edge',
  outerMaxWidthPx: 0,
  bleedWideTables: true,
  bleedGutterPx: 16,
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
  // Track when the outer width handle is actively dragging to avoid auto-centering mid-drag
  private outerDragActive = new WeakSet<HTMLTableElement>();

  // Cached measurements for breakout calculations (updated per-table when needed)
  // NOTE: Return precise left/right offsets so we can align exactly with the host pane edges.
  private measureContextForEl(el: HTMLElement): {
    host: 'cm6' | 'reading' | 'unknown';
    paneWidth: number;     // full usable pane width for content (excludes gutters in LP)
    lineWidth: number;     // readable line width
    sideMargin: number;    // kept for backward compat; equals leftOffset
    leftOffset: number;    // exact px from content start to pane left edge
    rightOffset: number;   // exact px from content end to pane right edge
  } {
    // Try CM6 first
    const scroller = el.closest('.cm-scroller') as HTMLElement | null;
    const sizer = el.closest('.cm-sizer') as HTMLElement | null;
    if (scroller && sizer) {
      const scRect = scroller.getBoundingClientRect();
      const paneClientW = scroller.clientWidth || scRect.width || 0; // excludes vertical scrollbar
      // Prefer the real content width (readable line length) from .cm-content; fall back to .cm-sizer
      const contentEl = (el.closest('.cm-content') as HTMLElement | null) || (scroller.querySelector('.cm-content') as HTMLElement | null);
      const contentRect = contentEl?.getBoundingClientRect();
      const lineWidth = (contentEl?.clientWidth || contentEl?.getBoundingClientRect()?.width || 0) || (sizer.clientWidth || sizer.getBoundingClientRect().width || 0);
      // Account for gutters if present (so centering stays accurate with line numbers)
      const gutters = scroller.querySelector('.cm-gutters') as HTMLElement | null;
      const gutterW = gutters ? (gutters.clientWidth || gutters.getBoundingClientRect().width || 0) : 0;
      const contentPane = Math.max(0, paneClientW - gutterW);
      // Compute exact offsets using DOM rects to avoid padding/margin guesswork
      let leftOffset = 0; let rightOffset = 0;
      if (contentRect) {
        const paneLeft = scRect.left + gutterW; // left edge of usable pane (after gutters)
        const paneRight = scRect.left + paneClientW; // right edge of usable pane
        leftOffset = Math.max(0, Math.round(contentRect.left - paneLeft));
        rightOffset = Math.max(0, Math.round(paneRight - contentRect.right));
      } else {
        // Fallback to symmetric calc if rects not available
        const side = Math.max(0, (contentPane - lineWidth) / 2);
        leftOffset = side; rightOffset = side;
      }
      return { host: 'cm6', paneWidth: contentPane, lineWidth, sideMargin: leftOffset, leftOffset, rightOffset };
    }
    // Reading view fallback
    const reading = el.closest('.markdown-reading-view, .markdown-preview-view') as HTMLElement | null;
    const previewSizer = el.closest('.markdown-preview-sizer') as HTMLElement | null;
    if (reading && previewSizer) {
      const paneClientW = reading.clientWidth || reading.getBoundingClientRect().width || 0;
      const lineWidth = previewSizer.clientWidth || previewSizer.getBoundingClientRect().width || 0;
      const rRect = reading.getBoundingClientRect();
      const sRect = previewSizer.getBoundingClientRect();
      // exact offsets from the preview sizer to the reading pane's inner edges
      const leftOffset = Math.max(0, Math.round(sRect.left - rRect.left));
      const rightOffset = Math.max(0, Math.round(rRect.right - sRect.right));
      return { host: 'reading', paneWidth: paneClientW, lineWidth, sideMargin: leftOffset, leftOffset, rightOffset };
    }
    return { host: 'unknown', paneWidth: 0, lineWidth: 0, sideMargin: 0, leftOffset: 0, rightOffset: 0 };
  }

  /** Choose the element we should wrap for breakout.
   * In Live Preview (CM6), wrap the .cm-table-widget to avoid inner clipping/scrollbars.
   * In Reading view, wrap the table itself.
   */
  private getBreakoutContainer(table: HTMLTableElement): HTMLElement {
    return (table.closest('.cm-table-widget') as HTMLElement | null) || table;
  }

  /** Remove legacy wrapper from earlier versions (wrapper directly around <table>). */
  private cleanupLegacyBreakout(table: HTMLTableElement) {
    const p = table.parentElement;
    if (p && p.classList.contains('otd-breakout-wrap')) {
      const gp = p.parentElement;
      if (gp) gp.insertBefore(table, p);
      p.remove();
    }
  }

  /** Ensure a breakout wrapper exists for the container and return it. */
  private ensureBreakoutWrapper(table: HTMLTableElement): HTMLDivElement {
    this.cleanupLegacyBreakout(table);
    const container = this.getBreakoutContainer(table);
    const parent = container.parentElement;
    if (parent && parent.classList.contains('otd-breakout-wrap')) return parent as HTMLDivElement;
    const wrap = document.createElement('div');
    wrap.className = 'otd-breakout-wrap';
    if (parent) parent.insertBefore(wrap, container);
    wrap.appendChild(container);
    return wrap;
  }

  /** Remove breakout wrapper if present (moves container back to original parent). */
  private removeBreakoutWrapper(table: HTMLTableElement) {
    // Clean legacy wrapper too
    this.cleanupLegacyBreakout(table);
    const container = this.getBreakoutContainer(table);
    const wrap = container.parentElement;
    if (wrap && wrap.classList.contains('otd-breakout-wrap')) {
      const parent = wrap.parentElement;
      if (parent) parent.insertBefore(container, wrap);
      wrap.remove();
    }
  }

  private breakoutRAF = new WeakMap<HTMLTableElement, number>();
  /** Schedule a breakout computation for the next animation frame (coalesces bursts). */
  public scheduleBreakoutForTable(table: HTMLTableElement) {
    if (this.breakoutRAF.has(table)) return;
    const id = requestAnimationFrame(() => {
      this.breakoutRAF.delete(table);
      this.updateBreakoutForTable(table);
    });
    this.breakoutRAF.set(table, id);
  }

  /**
   * Update or remove breakout for a given table based on its intrinsic width vs readable line width.
   * - If table is wider than the readable line width, we wrap it in a scrollable container that expands to pane width
   *   and offsets the centered sizer margins so the table visually fills the pane.
   * - Otherwise, we remove any wrapper and keep normal flow.
   */
  public updateBreakoutForTable(table: HTMLTableElement) {
    try {
      const ctx = this.measureContextForEl(table);
      if (ctx.paneWidth <= 0 || ctx.lineWidth <= 0) { this.removeBreakoutWrapper(table); return; }
      const container = this.getBreakoutContainer(table);
      const intrinsic = Math.max(table.scrollWidth, table.offsetWidth, 0);
      const specified = parseFloat((table.style.width || '').replace('px','')) || 0;
      const desired = Math.max(intrinsic, specified);

      if (desired > ctx.lineWidth + 1) {
        // Optional bleed padding to avoid hugging pane edges
        const bleed = this.settings.bleedWideTables ? Math.max(0, this.settings.bleedGutterPx || 0) : 0;
        const leftAdj = Math.max(0, ctx.leftOffset - bleed);
        const rightAdj = Math.max(0, ctx.rightOffset - bleed);
        const paneAvail = Math.max(0, ctx.paneWidth - bleed*2);
        if (ctx.host === 'cm6') {
          // Live Preview: do NOT wrap. Expand to pane width and offset via transform (no layout overflow).
          this.cleanupLegacyBreakout(table);
          const targetW = `${Math.floor(paneAvail)}px`;
          const targetTranslate = `translateX(${-Math.floor(leftAdj)}px)`;
          const el = container as HTMLElement;
          if (el.style.width !== targetW) el.style.width = targetW;
          // Use transform instead of negative margins so the editor never gains a global horizontal scrollbar
          if (el.style.transform !== targetTranslate) el.style.transform = targetTranslate;
          // Table-only horizontal scroll when table wider than pane
          const wantScroll = desired > paneAvail + 1 ? 'auto' : 'visible';
          if (el.style.overflowX !== wantScroll) el.style.overflowX = wantScroll;
          // Ensure visibility above margins
          if (el.style.position !== 'relative') el.style.position = 'relative';
          if (el.style.zIndex !== '1') el.style.zIndex = '1';
          // When not overflowing the pane, pad both sides so the table stays centered visually
          const pad = wantScroll === 'visible' ? Math.max(0, Math.floor((paneAvail - desired) / 2)) : 0;
          if (el.style.paddingLeft !== `${pad}px`) el.style.paddingLeft = `${pad}px`;
          if (el.style.paddingRight !== `${pad}px`) el.style.paddingRight = `${pad}px`;
          el.classList.add('otd-breakout-cm');
          // Center initial scroll once (not during active outer drag)
          if (wantScroll === 'auto' && !this.outerDragActive.has(table)) {
            if (!(el as any).dataset?.otdCentered) {
              const center = Math.max(0, Math.floor((Math.max(el.scrollWidth, desired) - paneAvail) / 2));
              el.scrollLeft = center;
              (el as any).dataset = (el as any).dataset || {} as any;
              (el as any).dataset.otdCentered = '1';
            }
          }
        } else {
          // Reading view: use a wrapper so only the table area scrolls
          const wrap = this.ensureBreakoutWrapper(table);
          const targetW = `${Math.floor(paneAvail)}px`;
          const targetML = `${-Math.floor(leftAdj)}px`;
          const targetMR = `${-Math.floor(rightAdj)}px`;
          if (wrap.style.width !== targetW) wrap.style.width = targetW;
          if (wrap.style.marginLeft !== targetML) wrap.style.marginLeft = targetML;
          if (wrap.style.marginRight !== targetMR) wrap.style.marginRight = targetMR;
          const wantScroll = desired > paneAvail + 1 ? 'auto' : 'visible';
          if (wrap.style.overflowX !== wantScroll) wrap.style.overflowX = wantScroll;
          // When not overflowing the pane, pad both sides so the table stays centered visually
          const pad = wantScroll === 'visible' ? Math.max(0, Math.floor((paneAvail - desired) / 2)) : 0;
          if (wrap.style.paddingLeft !== `${pad}px`) wrap.style.paddingLeft = `${pad}px`;
          if (wrap.style.paddingRight !== `${pad}px`) wrap.style.paddingRight = `${pad}px`;
          // Center initial scroll once (not during active outer drag)
          if (wantScroll === 'auto' && !this.outerDragActive.has(table)) {
            if (!(wrap as any).dataset?.otdCentered) {
              const center = Math.max(0, Math.floor((Math.max((wrap as any).scrollWidth || 0, desired) - paneAvail) / 2));
              (wrap as any).scrollLeft = center;
              (wrap as any).dataset = (wrap as any).dataset || {} as any;
              (wrap as any).dataset.otdCentered = '1';
            }
          }
          table.classList.add('otd-breakout');
        }
        this.log('breakout-apply', { paneWidth: ctx.paneWidth, lineWidth: ctx.lineWidth, desired, side: ctx.sideMargin, host: ctx.host });
      } else {
        // Remove any CM6 inline breakout styles and wrappers
        (container as HTMLElement).style.width = '';
        (container as HTMLElement).style.marginLeft = '';
        (container as HTMLElement).style.marginRight = '';
        (container as HTMLElement).style.transform = '';
        (container as HTMLElement).style.overflowX = '';
        (container as HTMLElement).style.position = '';
        (container as HTMLElement).style.zIndex = '';
        (container as HTMLElement).style.paddingLeft = '';
        (container as HTMLElement).style.paddingRight = '';
        container.classList.remove('otd-breakout-cm');
        this.removeBreakoutWrapper(table);
        table.classList.remove('otd-breakout');
      }
    } catch (e) {
      // Non-fatal
    }
  }

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

    // If already bound, just re-apply stored widths and ensure breakout; avoid re-attaching observers/handles
    if (alreadyBound) {
      try {
        this.applyStoredRatiosPx(table, key);
        this.updateBreakoutForTable(table);
      } catch {}
      return;
    }

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
      if (stored.tablePxWidth && stored.tablePxWidth > 0) {
        (table.style as any).width = `${Math.floor(stored.tablePxWidth)}px`;
      }
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

    // Column handles appended to table so they span full height and are clickable along entire column boundary
    const positionColumnHandles = () => {
      const widths = getColWidths(cols);
      const tRect = table.getBoundingClientRect();
      let acc = 0;
      for (let i = 0; i < colCount - 1; i++) {
        acc += Math.max(0, widths[i]);
        const ch = table.querySelector('.otd-chandle[data-otd-index="'+i+'"]') as HTMLDivElement | null;
        if (!ch) continue;
        ch.style.top = '0px';
        ch.style.left = `${Math.max(0, acc - 3)}px`;
        ch.style.height = `${Math.max(0, tRect.height)}px`;
      }
    };

    for (let i = 0; i < colCount - 1; i++) {
      let handle = table.querySelector('.otd-chandle[data-otd-index="'+i+'"]') as HTMLDivElement | null;
      if (!handle) {
        handle = document.createElement('div');
        handle.className = 'otd-chandle';
        handle.setAttribute('data-otd-index', String(i));
        handle.setAttribute('role', 'separator');
        handle.setAttribute('aria-label', `Resize column ${i + 1}`);
        handle.tabIndex = 0;
        table.appendChild(handle);
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
        const cur = getColWidths(cols);
        cur[i] = newLeft;
        cur[i + 1] = newRight;
        this.applyColWidths(cols, cur);
        positionColumnHandles();
      };

      const onPointerUp = (_ev: PointerEvent) => {
        if (!active) return;
        active = false;
        handle!.releasePointerCapture((_ev as any).pointerId);
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        const finalPx = getColWidths(cols);
        const ratios = normalizeRatios(finalPx);
        this.dataStore.tables[resolvedKeyStr] = { ratios, lastPxWidth: containerWidth, updatedAt: Date.now() };
        this.log('persist-drag', { key: resolvedKeyStr, ratios });
        void this.saveDataStore();
      };

      handle.addEventListener('pointerdown', (ev: PointerEvent) => {
        if (this.settings.requireAltToDrag && !ev.altKey) return;
        ev.preventDefault();
        ev.stopPropagation();
        active = true;
        startX = ev.clientX;
        handle!.setPointerCapture((ev as any).pointerId);
        handle!.focus();
        this.lastActiveTableEl = table;
        this.lastActiveKey = key;
        const cur = getColWidths(cols);
        leftWidth = cur[i];
        rightWidth = cur[i + 1];
        window.addEventListener('pointermove', onPointerMove, { passive: true });
        window.addEventListener('pointerup', onPointerUp, { passive: true });
      });

      handle.addEventListener('dblclick', (ev: MouseEvent) => {
        this.lastActiveTableEl = table; this.lastActiveKey = key;
        ev.preventDefault();
        const cur = getColWidths(cols);
        const total = cur[i] + cur[i + 1];
        if (this.settings.doubleClickAction === 'autofit') {
          const targetWidth = Math.max(this.settings.minColumnWidthPx, measureAutofitWidth(table, i));
          const delta = targetWidth - cur[i];
          const { newLeft, newRight } = applyDeltaWithSnap(cur[i], cur[i + 1], total, delta, this.settings.minColumnWidthPx, this.settings.snapStepPx, false);
          cur[i] = newLeft; cur[i + 1] = newRight; this.applyColWidths(cols, cur);
        } else if (this.settings.doubleClickAction === 'reset') {
          const half = Math.max(this.settings.minColumnWidthPx, Math.floor(total / 2));
          cur[i] = half; cur[i + 1] = total - half; this.applyColWidths(cols, cur);
        }
        const ratios = normalizeRatios(cur);
        this.dataStore.tables[resolvedKeyStr] = { ratios, lastPxWidth: containerWidth, updatedAt: Date.now() };
        this.log('persist-dblclick', { key: resolvedKeyStr, ratios });
        void this.saveDataStore();
        positionColumnHandles();
      });

      handle.addEventListener('keydown', (ev: KeyboardEvent) => {
        this.lastActiveTableEl = table; this.lastActiveKey = key;
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
          ev.preventDefault(); this.applyColWidths(cols, cur);
          const ratios = normalizeRatios(cur);
          this.dataStore.tables[resolvedKeyStr] = { ratios, lastPxWidth: containerWidth, updatedAt: Date.now() };
          this.log('persist-keyboard', { key: resolvedKeyStr, ratios });
          void this.saveDataStore();
          positionColumnHandles();
        }
      });
    }

    // Position column handles initially
    positionColumnHandles();

    // Apply breakout layout if needed initially
    this.scheduleBreakoutForTable(table);

    // Outer width handle (grow beyond readable line length)
    if (this.settings.showOuterWidthHandle) {
      let ohandle = table.querySelector('.otd-ohandle') as HTMLDivElement | null;
      if (!ohandle) {
        ohandle = document.createElement('div');
        ohandle.className = 'otd-ohandle';
        ohandle.setAttribute('role', 'separator');
        ohandle.setAttribute('aria-label', 'Resize table width');
        ohandle.tabIndex = 0;
        table.appendChild(ohandle);
        this.log('outer-mounted', { key: resolvedKeyStr });
      }
      const positionOuter = () => {
        const tRect = table.getBoundingClientRect();
        ohandle!.style.top = '0px';
        ohandle!.style.height = `${Math.max(0, tRect.height)}px`;
        // Keep the handle mostly inside the table so it's always clickable when not overflowing.
        // CSS default is right:-2px with width:10px -> 8px inside, 2px outside.
        ohandle!.style.right = '-2px';
      };
      positionOuter();

      let startX = 0;
      let startPx: number[] = [];
      let active = false;
      const onOMove = (ev: PointerEvent) => {
        if (!active) return;
        const dx = ev.clientX - startX;
        const cur = [...startPx];
        const totalStart = startPx.reduce((a,b)=>a+b,0);
        let targetTotal = totalStart + dx;
        const minTotal = colCount * this.settings.minColumnWidthPx;
        if (targetTotal < minTotal) targetTotal = minTotal;
        if (this.settings.outerMaxWidthPx > 0) targetTotal = Math.min(targetTotal, this.settings.outerMaxWidthPx);
        const delta = targetTotal - totalStart;
        let next: number[];
        if (this.settings.outerHandleMode === 'scale') {
          const factor = targetTotal / totalStart;
          next = cur.map(w => Math.max(this.settings.minColumnWidthPx, Math.floor(w * factor)));
          // adjust rounding to match target
          const diff = targetTotal - next.reduce((a,b)=>a+b,0);
          if (Math.abs(diff) >= 1) next[next.length-1] = Math.max(this.settings.minColumnWidthPx, next[next.length-1] + Math.round(diff));
        } else {
          // edge mode: split delta across first and last columns
          next = [...cur];
          const half = Math.round(delta/2);
          next[0] = Math.max(this.settings.minColumnWidthPx, next[0] + half);
          next[next.length-1] = Math.max(this.settings.minColumnWidthPx, next[next.length-1] + (delta - half));
          // ensure total matches target by adjusting last col
          const sum = next.reduce((a,b)=>a+b,0);
          if (sum !== targetTotal) next[next.length-1] = Math.max(this.settings.minColumnWidthPx, next[next.length-1] + (targetTotal - sum));
        }
        this.applyColWidths(cols, next);
        (table.style as any).width = `${Math.floor(targetTotal)}px`;
        // Keep the table visually centered while dragging by adjusting scrollLeft symmetrically
        try {
          const ctxD = this.measureContextForEl(table);
          const bleed = this.settings.bleedWideTables ? Math.max(0, this.settings.bleedGutterPx || 0) : 0;
          const paneAvail = Math.max(0, ctxD.paneWidth - bleed*2);
          const cmWrap = table.closest('.cm-table-widget') as HTMLElement | null;
          const rvWrap = (table.parentElement && table.parentElement.classList.contains('otd-breakout-wrap')) ? table.parentElement as HTMLElement : null;
          const scrollEl = cmWrap || rvWrap;
          this.log('outer-drag-center', { targetTotal, paneAvail, cmWrap: !!cmWrap, rvWrap: !!rvWrap, scrollEl: !!scrollEl, host: ctxD.host });
          if (scrollEl) {
            if (targetTotal > paneAvail + 1) {
              const center = Math.max(0, Math.floor((targetTotal - paneAvail) / 2));
              const oldScroll = scrollEl.scrollLeft;
              if (Math.abs(scrollEl.scrollLeft - center) > 1) {
                scrollEl.scrollLeft = center;
                this.log('outer-drag-scroll', { oldScroll, newScroll: center, targetTotal, paneAvail });
              }
            } else if (scrollEl.scrollLeft !== 0) {
              scrollEl.scrollLeft = 0;
              this.log('outer-drag-reset-scroll', { targetTotal, paneAvail });
            }
          }
        } catch (e) { this.log('outer-drag-center-error', e); }
        // Update breakout wrapper while dragging so visuals track
        this.scheduleBreakoutForTable(table);
        positionColumnHandles();
        positionOuter();
      };
      const onOUp = (_ev: PointerEvent) => {
        if (!active) return;
        active = false;
        this.outerDragActive.delete(table);
        ohandle!.releasePointerCapture((_ev as any).pointerId);
        window.removeEventListener('pointermove', onOMove);
        window.removeEventListener('pointerup', onOUp);
        const finalPx = getColWidths(cols);
        const total = finalPx.reduce((a,b)=>a+b,0);
        const ratios = normalizeRatios(finalPx);
        this.dataStore.tables[resolvedKeyStr] = { ratios, lastPxWidth: total, tablePxWidth: total, updatedAt: Date.now() };
        this.scheduleBreakoutForTable(table);
        this.log('outer-drag', { key: resolvedKeyStr, mode: this.settings.outerHandleMode, total });
        void this.saveDataStore();
      };
      ohandle.addEventListener('pointerdown', (ev: PointerEvent) => {
        ev.preventDefault(); ev.stopPropagation();
        active = true;
        startX = ev.clientX;
        startPx = getColWidths(cols);
        this.outerDragActive.add(table);
        ohandle!.setPointerCapture((ev as any).pointerId);
        this.log('outer-ptrdown', { key: resolvedKeyStr, startPx, startX });
        window.addEventListener('pointermove', onOMove, { passive: true });
        window.addEventListener('pointerup', onOUp, { passive: true });
      });
      const onKey = (ev: KeyboardEvent) => {
        const cur = getColWidths(cols);
        const totalStart = cur.reduce((a,b)=>a+b,0);
        const step = (ev.ctrlKey || (ev as any).metaKey) ? 1 : this.settings.keyboardStepPx;
        let used = false; let targetTotal = totalStart;
        if (ev.key === 'ArrowLeft') { targetTotal = totalStart - step; used = true; }
        if (ev.key === 'ArrowRight') { targetTotal = totalStart + step; used = true; }
        if (!used) return;
        ev.preventDefault();
        const minTotal = colCount * this.settings.minColumnWidthPx;
        if (targetTotal < minTotal) targetTotal = minTotal;
        if (this.settings.outerMaxWidthPx > 0) targetTotal = Math.min(targetTotal, this.settings.outerMaxWidthPx);
        let next: number[];
        if (this.settings.outerHandleMode === 'scale') {
          const factor = targetTotal / totalStart;
          next = cur.map(w => Math.max(this.settings.minColumnWidthPx, Math.floor(w * factor)));
          const diff = targetTotal - next.reduce((a,b)=>a+b,0);
          if (Math.abs(diff) >= 1) next[next.length-1] = Math.max(this.settings.minColumnWidthPx, next[next.length-1] + Math.round(diff));
        } else {
          const delta = targetTotal - totalStart;
          next = [...cur];
          const half = Math.round(delta/2);
          next[0] = Math.max(this.settings.minColumnWidthPx, next[0] + half);
          next[next.length-1] = Math.max(this.settings.minColumnWidthPx, next[next.length-1] + (delta - half));
          const sum = next.reduce((a,b)=>a+b,0);
          if (sum !== targetTotal) next[next.length-1] = Math.max(this.settings.minColumnWidthPx, next[next.length-1] + (targetTotal - sum));
        }
        this.applyColWidths(cols, next);
        (table.style as any).width = `${Math.floor(targetTotal)}px`;
        // Keep centered while using keyboard adjustments
        try {
          const ctxD = this.measureContextForEl(table);
          const bleed = this.settings.bleedWideTables ? Math.max(0, this.settings.bleedGutterPx || 0) : 0;
          const paneAvail = Math.max(0, ctxD.paneWidth - bleed*2);
          const cmWrap = table.closest('.cm-table-widget') as HTMLElement | null;
          const rvWrap = (table.parentElement && table.parentElement.classList.contains('otd-breakout-wrap')) ? table.parentElement as HTMLElement : null;
          const scrollEl = cmWrap || rvWrap;
          if (scrollEl) {
            if (targetTotal > paneAvail + 1) {
              const center = Math.max(0, Math.floor((targetTotal - paneAvail) / 2));
              if (Math.abs(scrollEl.scrollLeft - center) > 1) scrollEl.scrollLeft = center;
            } else if (scrollEl.scrollLeft !== 0) {
              scrollEl.scrollLeft = 0;
            }
          }
        } catch {}
        this.updateBreakoutForTable(table);
        const ratios = normalizeRatios(next);
        this.dataStore.tables[resolvedKeyStr] = { ratios, lastPxWidth: targetTotal, tablePxWidth: targetTotal, updatedAt: Date.now() };
        void this.saveDataStore();
        positionColumnHandles(); positionOuter();
      };
      ohandle.addEventListener('keydown', onKey);
    }
    // Row resize handles
    if (this.settings.enableRowResize) {
      const rows = Array.from(table.rows) as HTMLTableRowElement[];
      rows.forEach((row, rIndex) => {
        // Append row handle directly to the table to span full width
        let rHandle = table.querySelector('.otd-rhandle[data-otd-row-index="'+rIndex+'"]') as HTMLDivElement | null;
        if (!rHandle) {
          rHandle = document.createElement('div') as HTMLDivElement;
          rHandle.className = 'otd-rhandle';
          rHandle.setAttribute('tabindex', '0');
          rHandle.setAttribute('role', 'separator');
          rHandle.setAttribute('aria-label', `Resize row ${rIndex + 1}`);
          rHandle.setAttribute('data-otd-row-index', String(rIndex));
          table.appendChild(rHandle);
        }

        // Initial layout
        {
          const tRect = table.getBoundingClientRect();
          const rRect = row.getBoundingClientRect();
          layoutRowHandleWithRects(rHandle, tRect, rRect);
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
        // Reposition column handles
        const widths = getColWidths(cols);
        let acc = 0;
        for (let i = 0; i < colCount - 1; i++) {
          acc += Math.max(0, widths[i]);
          const ch = table.querySelector('.otd-chandle[data-otd-index="'+i+'"]') as HTMLElement | null;
          if (ch) {
            ch.style.top = '0px';
            ch.style.left = `${Math.max(0, acc - 3)}px`;
            ch.style.height = `${Math.max(0, tRect.height)}px`;
          }
        }
        if (this.settings.enableRowResize) {
          const rows = Array.from(table.rows) as HTMLTableRowElement[];
          rows.forEach((row, rIndex) => {
            const rHandle = table.querySelector('.otd-rhandle[data-otd-row-index="'+rIndex+'"]') as HTMLElement | null;
            if (!rHandle) return;
            const rRect = row.getBoundingClientRect();
            layoutRowHandleWithRects(rHandle, tRect, rRect);
          });
        }
        // Re-evaluate breakout when table size changes
        this.scheduleBreakoutForTable(table);
      });
    });
    ro.observe(table);

    // Also watch the host pane/scroller for width changes (sidebars, window resize, readable width toggle)
    const hostToObserve = (table.closest('.cm-scroller') as HTMLElement | null) || (table.closest('.markdown-reading-view, .markdown-preview-view') as HTMLElement | null);
    if (hostToObserve) {
      const roPane = new ResizeObserver(() => {
        // Only recompute breakout; table's own RO will reposition handles if size changed
        this.updateBreakoutForTable(table);
      });
      roPane.observe(hostToObserve);
      this.register(() => roPane.disconnect());
    }

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
    if (stored.tablePxWidth && stored.tablePxWidth > 0) {
      (table.style as any).width = `${Math.floor(stored.tablePxWidth)}px`;
    }
    let w = table.getBoundingClientRect().width;
    if (!w || w <= 0) w = stored.lastPxWidth || stored.tablePxWidth || 0;
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

    // Outer width handle
    containerEl.createEl('h3', { text: 'Outer width handle' });
    new Setting(containerEl)
      .setName('Show outer width handle')
      .setDesc('Displays a grab handle outside the right edge to grow/shrink table width beyond readable line length')
      .addToggle((t) => t.setValue(this.plugin.settings.showOuterWidthHandle).onChange(async (v) => { this.plugin.settings.showOuterWidthHandle = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName('Outer handle mode')
      .setDesc('edge = split growth between first and last columns; scale = scale all columns')
      .addDropdown((d) => d.addOptions({ edge: 'Edge columns', scale: 'Scale all' }).setValue(this.plugin.settings.outerHandleMode).onChange(async (v) => { this.plugin.settings.outerHandleMode = v as any; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName('Outer max width (px, 0 = unlimited)')
      .setDesc('Caps how wide a table can grow when dragging the outer handle')
      .addText((t) => t.setPlaceholder('0').setValue(String(this.plugin.settings.outerMaxWidthPx)).onChange(async (v) => { const n = parseInt(v,10); if (!Number.isNaN(n) && n >= 0) { this.plugin.settings.outerMaxWidthPx = n; await this.plugin.saveSettings(); } }));

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

function layoutRowHandleWithRects(handle: HTMLElement, tableRect: DOMRect, rowRect: DOMRect) {
  // Position at the row's bottom edge across full table width relative to table
  const h = (handle.getBoundingClientRect().height || 6);
  const top = rowRect.bottom - tableRect.top - h;
  handle.style.top = `${Math.max(0, top)}px`;
  handle.style.left = `0px`;
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
