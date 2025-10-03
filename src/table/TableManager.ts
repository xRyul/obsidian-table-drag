import type { Plugin, MarkdownPostProcessorContext } from 'obsidian';
import type { TableKey, TableDragSettings } from '../types';
import type { StorageManager } from '../storage/StorageManager';
import type { BreakoutManager } from '../breakout/BreakoutManager';
import { getColWidths, normalizeRatios, measureAutofitWidth } from '../utils/helpers';
import { applyDeltaWithSnap, layoutRowHandleWithRects } from '../utils/layout';

export class TableManager {
  public lastActiveTableEl: HTMLTableElement | null = null;
  public lastActiveKey: TableKey | null = null;

  constructor(
    private plugin: Plugin,
    private settings: TableDragSettings,
    private storage: StorageManager,
    private breakout: BreakoutManager,
    private log: (event: string, details?: any) => void
  ) {}

  processReadingTables(sectionEl: HTMLElement, ctx: MarkdownPostProcessorContext): void {
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

  computeFingerprint(table: HTMLTableElement): string {
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

  attachResizersWithKey(table: HTMLTableElement, key: TableKey): void {
    const alreadyBound = table.getAttribute('data-otd-bound') === '1';

    // Prefer canonical key (path + normalized fingerprint). Migrate older keys if present.
    const resolvedKeyStr = this.storage.findOrMigrateToCanonicalKey(key);

    // If already bound, just re-apply stored widths and ensure breakout; avoid re-attaching observers/handles
    if (alreadyBound) {
      try {
        this.applyStoredRatiosPx(table, key);
        this.breakout.updateBreakoutForTable(table);
      } catch {}
      return;
    }

    // Determine column count from first row with max cells
    const colCount = Math.max(0, ...Array.from(table.rows).map((r) => r.cells.length));
    if (colCount < 2) return; // nothing to resize

    const cols = this.ensureColgroup(table, colCount);

    // Initialize widths
    const stored = this.storage.dataStore.tables[resolvedKeyStr];
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
      this.storage.dataStore.tables[resolvedKeyStr] = { ratios, lastPxWidth: Math.max(1, containerWidth), updatedAt: Date.now() };
      this.log('init-ratios', { key: resolvedKeyStr, ratios });
      void this.storage.saveDataStore();
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

    // Setup column handles
    this.attachColumnHandles(table, key, cols, colCount, resolvedKeyStr, containerWidth);

    // Position column handles initially
    this.positionColumnHandles(table, cols, colCount);

    // Apply breakout layout if needed initially
    this.breakout.scheduleBreakoutForTable(table);

    // Setup outer width handle
    if (this.settings.showOuterWidthHandle) {
      this.attachOuterWidthHandle(table, cols, colCount, resolvedKeyStr);
    }

    // Setup row resize handles
    if (this.settings.enableRowResize) {
      this.attachRowHandles(table, cols, stored, resolvedKeyStr);
    }

    // Setup resize observer for handle repositioning
    this.attachResizeObserver(table, cols, colCount);

    // Watch host pane for width changes
    const hostToObserve = (table.closest('.cm-scroller') as HTMLElement | null) || (table.closest('.markdown-reading-view, .markdown-preview-view') as HTMLElement | null);
    if (hostToObserve) {
      const roPane = new ResizeObserver(() => {
        // Only recompute breakout; table's own RO will reposition handles if size changed
        this.breakout.updateBreakoutForTable(table);
      });
      roPane.observe(hostToObserve);
      this.plugin.register(() => roPane.disconnect());
    }

    table.setAttribute('data-otd-bound', '1');
    
    // Schedule initial breakout computation after DOM layout completes
    // Use a small delay to ensure reading view containers have dimensions
    this.breakout.scheduleBreakoutForTable(table, 50);
  }

  private attachColumnHandles(
    table: HTMLTableElement,
    key: TableKey,
    cols: HTMLTableColElement[],
    colCount: number,
    resolvedKeyStr: string,
    containerWidth: number
  ): void {
    const positionColumnHandles = () => this.positionColumnHandles(table, cols, colCount);

    for (let i = 0; i < colCount - 1; i++) {
      let handle = table.querySelector('.otd-chandle[data-otd-index="' + i + '"]') as HTMLDivElement | null;
      if (!handle) {
        handle = document.createElement('div');
        handle.className = 'otd-chandle';
        handle.setAttribute('data-otd-index', String(i));
        handle.setAttribute('role', 'separator');
        handle.setAttribute('aria-label', `Resize column ${i + 1}`);
        handle.tabIndex = 0;
        table.appendChild(handle);
      }

      this.attachColumnHandleListeners(handle, i, table, key, cols, colCount, resolvedKeyStr, containerWidth, positionColumnHandles);
    }
  }

  private attachColumnHandleListeners(
    handle: HTMLDivElement,
    colIndex: number,
    table: HTMLTableElement,
    key: TableKey,
    cols: HTMLTableColElement[],
    colCount: number,
    resolvedKeyStr: string,
    containerWidth: number,
    positionColumnHandles: () => void
  ): void {
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
      cur[colIndex] = newLeft;
      cur[colIndex + 1] = newRight;
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
      this.storage.dataStore.tables[resolvedKeyStr] = { ratios, lastPxWidth: containerWidth, updatedAt: Date.now() };
      this.log('persist-drag', { key: resolvedKeyStr, ratios });
      void this.storage.saveDataStore();
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
      leftWidth = cur[colIndex];
      rightWidth = cur[colIndex + 1];
      window.addEventListener('pointermove', onPointerMove, { passive: true });
      window.addEventListener('pointerup', onPointerUp, { passive: true });
    });

    handle.addEventListener('dblclick', (ev: MouseEvent) => {
      this.lastActiveTableEl = table;
      this.lastActiveKey = key;
      ev.preventDefault();
      const cur = getColWidths(cols);
      const total = cur[colIndex] + cur[colIndex + 1];
      if (this.settings.doubleClickAction === 'autofit') {
        const targetWidth = measureAutofitWidth(table, colIndex, this.settings.minColumnWidthPx);
        const delta = targetWidth - cur[colIndex];
        const { newLeft, newRight } = applyDeltaWithSnap(cur[colIndex], cur[colIndex + 1], total, delta, this.settings.minColumnWidthPx, this.settings.snapStepPx, false);
        cur[colIndex] = newLeft;
        cur[colIndex + 1] = newRight;
        this.applyColWidths(cols, cur);
      } else if (this.settings.doubleClickAction === 'reset') {
        const half = Math.max(this.settings.minColumnWidthPx, Math.floor(total / 2));
        cur[colIndex] = half;
        cur[colIndex + 1] = total - half;
        this.applyColWidths(cols, cur);
      }
      const ratios = normalizeRatios(cur);
      this.storage.dataStore.tables[resolvedKeyStr] = { ratios, lastPxWidth: containerWidth, updatedAt: Date.now() };
      this.log('persist-dblclick', { key: resolvedKeyStr, ratios });
      void this.storage.saveDataStore();
      positionColumnHandles();
    });

    handle.addEventListener('keydown', (ev: KeyboardEvent) => {
      this.lastActiveTableEl = table;
      this.lastActiveKey = key;
      const cur = getColWidths(cols);
      const total = cur[colIndex] + cur[colIndex + 1];
      let used = false;
      const step = (ev.ctrlKey || (ev as any).metaKey) ? 1 : this.settings.keyboardStepPx;
      if (ev.key === 'ArrowLeft') {
        const { newLeft, newRight } = applyDeltaWithSnap(cur[colIndex], cur[colIndex + 1], total, -step, this.settings.minColumnWidthPx, this.settings.snapStepPx, true);
        cur[colIndex] = newLeft;
        cur[colIndex + 1] = newRight;
        used = true;
      } else if (ev.key === 'ArrowRight') {
        const { newLeft, newRight } = applyDeltaWithSnap(cur[colIndex], cur[colIndex + 1], total, step, this.settings.minColumnWidthPx, this.settings.snapStepPx, true);
        cur[colIndex] = newLeft;
        cur[colIndex + 1] = newRight;
        used = true;
      } else if (ev.key === 'Enter' || ev.key === ' ') {
        if (this.settings.doubleClickAction === 'autofit') {
          const targetWidth = measureAutofitWidth(table, colIndex, this.settings.minColumnWidthPx);
          const delta = targetWidth - cur[colIndex];
          const res = applyDeltaWithSnap(cur[colIndex], cur[colIndex + 1], total, delta, this.settings.minColumnWidthPx, this.settings.snapStepPx, false);
          cur[colIndex] = res.newLeft;
          cur[colIndex + 1] = res.newRight;
          used = true;
        } else if (this.settings.doubleClickAction === 'reset') {
          const half = Math.max(this.settings.minColumnWidthPx, Math.floor(total / 2));
          cur[colIndex] = half;
          cur[colIndex + 1] = total - half;
          used = true;
        }
      }
      if (used) {
        ev.preventDefault();
        this.applyColWidths(cols, cur);
        const ratios = normalizeRatios(cur);
        this.storage.dataStore.tables[resolvedKeyStr] = { ratios, lastPxWidth: containerWidth, updatedAt: Date.now() };
        this.log('persist-keyboard', { key: resolvedKeyStr, ratios });
        void this.storage.saveDataStore();
        positionColumnHandles();
      }
    });
  }

  private positionColumnHandles(table: HTMLTableElement, cols: HTMLTableColElement[], colCount: number): void {
    const widths = getColWidths(cols);
    const tRect = table.getBoundingClientRect();
    let acc = 0;
    for (let i = 0; i < colCount - 1; i++) {
      acc += Math.max(0, widths[i]);
      const ch = table.querySelector('.otd-chandle[data-otd-index="' + i + '"]') as HTMLDivElement | null;
      if (!ch) continue;
      ch.style.top = '0px';
      ch.style.left = `${Math.max(0, acc - 3)}px`;
      ch.style.height = `${Math.max(0, tRect.height)}px`;
    }
  }

  private attachOuterWidthHandle(table: HTMLTableElement, cols: HTMLTableColElement[], colCount: number, resolvedKeyStr: string): void {
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
      ohandle!.style.right = '-2px';
    };
    positionOuter();

    this.attachOuterHandleListeners(ohandle, table, cols, colCount, resolvedKeyStr, positionOuter);
  }

  private attachOuterHandleListeners(
    ohandle: HTMLDivElement,
    table: HTMLTableElement,
    cols: HTMLTableColElement[],
    colCount: number,
    resolvedKeyStr: string,
    positionOuter: () => void
  ): void {
    let startX = 0;
    let startPx: number[] = [];
    let active = false;

    const positionColumnHandles = () => this.positionColumnHandles(table, cols, colCount);

    const onOMove = (ev: PointerEvent) => {
      if (!active) return;
      const dx = ev.clientX - startX;
      const cur = [...startPx];
      const totalStart = startPx.reduce((a, b) => a + b, 0);
      let targetTotal = totalStart + dx;
      const minTotal = colCount * this.settings.minColumnWidthPx;
      if (targetTotal < minTotal) targetTotal = minTotal;
      if (this.settings.outerMaxWidthPx > 0) targetTotal = Math.min(targetTotal, this.settings.outerMaxWidthPx);
      const delta = targetTotal - totalStart;
      let next: number[];
      if (this.settings.outerHandleMode === 'scale') {
        const factor = targetTotal / totalStart;
        next = cur.map(w => Math.max(this.settings.minColumnWidthPx, Math.floor(w * factor)));
        const diff = targetTotal - next.reduce((a, b) => a + b, 0);
        if (Math.abs(diff) >= 1) next[next.length - 1] = Math.max(this.settings.minColumnWidthPx, next[next.length - 1] + Math.round(diff));
      } else {
        next = [...cur];
        const half = Math.round(delta / 2);
        next[0] = Math.max(this.settings.minColumnWidthPx, next[0] + half);
        next[next.length - 1] = Math.max(this.settings.minColumnWidthPx, next[next.length - 1] + (delta - half));
        const sum = next.reduce((a, b) => a + b, 0);
        if (sum !== targetTotal) next[next.length - 1] = Math.max(this.settings.minColumnWidthPx, next[next.length - 1] + (targetTotal - sum));
      }
      this.applyColWidths(cols, next);
      (table.style as any).width = `${Math.floor(targetTotal)}px`;
      
      // Keep the table visually centered while dragging
      try {
        const ctxD = this.breakout.measureContextForEl(table);
        const bleed = this.settings.bleedWideTables ? Math.max(0, this.settings.bleedGutterPx || 0) : 0;
        const paneAvail = Math.max(0, ctxD.paneWidth - bleed * 2);
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
      } catch (e) {
        this.log('outer-drag-center-error', e);
      }
      
      this.breakout.scheduleBreakoutForTable(table);
      positionColumnHandles();
      positionOuter();
    };

    const onOUp = (_ev: PointerEvent) => {
      if (!active) return;
      active = false;
      this.breakout.outerDragActive.delete(table);
      ohandle!.releasePointerCapture((_ev as any).pointerId);
      window.removeEventListener('pointermove', onOMove);
      window.removeEventListener('pointerup', onOUp);
      const finalPx = getColWidths(cols);
      const total = finalPx.reduce((a, b) => a + b, 0);
      const ratios = normalizeRatios(finalPx);
      this.storage.dataStore.tables[resolvedKeyStr] = { ratios, lastPxWidth: total, tablePxWidth: total, updatedAt: Date.now() };
      this.breakout.scheduleBreakoutForTable(table);
      this.log('outer-drag', { key: resolvedKeyStr, mode: this.settings.outerHandleMode, total });
      void this.storage.saveDataStore();
    };

    ohandle.addEventListener('pointerdown', (ev: PointerEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      active = true;
      startX = ev.clientX;
      startPx = getColWidths(cols);
      this.breakout.outerDragActive.add(table);
      ohandle!.setPointerCapture((ev as any).pointerId);
      this.log('outer-ptrdown', { key: resolvedKeyStr, startPx, startX });
      window.addEventListener('pointermove', onOMove, { passive: true });
      window.addEventListener('pointerup', onOUp, { passive: true });
    });

    const onKey = (ev: KeyboardEvent) => {
      const cur = getColWidths(cols);
      const totalStart = cur.reduce((a, b) => a + b, 0);
      const step = (ev.ctrlKey || (ev as any).metaKey) ? 1 : this.settings.keyboardStepPx;
      let used = false;
      let targetTotal = totalStart;
      if (ev.key === 'ArrowLeft') {
        targetTotal = totalStart - step;
        used = true;
      }
      if (ev.key === 'ArrowRight') {
        targetTotal = totalStart + step;
        used = true;
      }
      if (!used) return;
      ev.preventDefault();
      const minTotal = colCount * this.settings.minColumnWidthPx;
      if (targetTotal < minTotal) targetTotal = minTotal;
      if (this.settings.outerMaxWidthPx > 0) targetTotal = Math.min(targetTotal, this.settings.outerMaxWidthPx);
      let next: number[];
      if (this.settings.outerHandleMode === 'scale') {
        const factor = targetTotal / totalStart;
        next = cur.map(w => Math.max(this.settings.minColumnWidthPx, Math.floor(w * factor)));
        const diff = targetTotal - next.reduce((a, b) => a + b, 0);
        if (Math.abs(diff) >= 1) next[next.length - 1] = Math.max(this.settings.minColumnWidthPx, next[next.length - 1] + Math.round(diff));
      } else {
        const delta = targetTotal - totalStart;
        next = [...cur];
        const half = Math.round(delta / 2);
        next[0] = Math.max(this.settings.minColumnWidthPx, next[0] + half);
        next[next.length - 1] = Math.max(this.settings.minColumnWidthPx, next[next.length - 1] + (delta - half));
        const sum = next.reduce((a, b) => a + b, 0);
        if (sum !== targetTotal) next[next.length - 1] = Math.max(this.settings.minColumnWidthPx, next[next.length - 1] + (targetTotal - sum));
      }
      this.applyColWidths(cols, next);
      (table.style as any).width = `${Math.floor(targetTotal)}px`;
      
      // Keep centered while using keyboard adjustments
      try {
        const ctxD = this.breakout.measureContextForEl(table);
        const bleed = this.settings.bleedWideTables ? Math.max(0, this.settings.bleedGutterPx || 0) : 0;
        const paneAvail = Math.max(0, ctxD.paneWidth - bleed * 2);
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
      
      this.breakout.updateBreakoutForTable(table);
      const ratios = normalizeRatios(next);
      this.storage.dataStore.tables[resolvedKeyStr] = { ratios, lastPxWidth: targetTotal, tablePxWidth: targetTotal, updatedAt: Date.now() };
      void this.storage.saveDataStore();
      positionColumnHandles();
      positionOuter();
    };
    ohandle.addEventListener('keydown', onKey);
  }

  private attachRowHandles(table: HTMLTableElement, cols: HTMLTableColElement[], stored: any, resolvedKeyStr: string): void {
    const rows = Array.from(table.rows) as HTMLTableRowElement[];
    rows.forEach((row, rIndex) => {
      let rHandle = table.querySelector('.otd-rhandle[data-otd-row-index="' + rIndex + '"]') as HTMLDivElement | null;
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

      this.attachRowHandleListeners(rHandle, row, rIndex, cols, stored, resolvedKeyStr);
    });
  }

  private attachRowHandleListeners(
    rHandle: HTMLDivElement,
    row: HTMLTableRowElement,
    rIndex: number,
    cols: HTMLTableColElement[],
    stored: any,
    resolvedKeyStr: string
  ): void {
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
      const fallbackRatios = stored?.ratios ?? normalizeRatios(getColWidths(cols));
      const keyData = this.storage.dataStore.tables[resolvedKeyStr] ?? { ratios: fallbackRatios, updatedAt: Date.now() };
      keyData.rowHeights = keyData.rowHeights || {};
      keyData.rowHeights[rIndex] = finalH;
      keyData.updatedAt = Date.now();
      this.storage.dataStore.tables[resolvedKeyStr] = keyData;
      this.log('persist-row-drag', { key: resolvedKeyStr, rIndex, height: finalH });
      void this.storage.saveDataStore();
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
      if (ev.key === 'ArrowUp') {
        target = Math.max(this.settings.rowMinHeightPx, Math.floor(target - step));
        used = true;
      }
      if (ev.key === 'ArrowDown') {
        target = Math.max(this.settings.rowMinHeightPx, Math.floor(target + step));
        used = true;
      }
      if ((ev.key === 'Enter' || ev.key === ' ') && row.style.height) {
        row.style.height = '';
        used = true;
      }
      if (used) {
        ev.preventDefault();
        row.style.height = `${target}px`;
        const fallbackRatios = stored?.ratios ?? normalizeRatios(getColWidths(cols));
        const keyData = this.storage.dataStore.tables[resolvedKeyStr] ?? { ratios: fallbackRatios, updatedAt: Date.now() };
        keyData.rowHeights = keyData.rowHeights || {};
        keyData.rowHeights[rIndex] = target;
        keyData.updatedAt = Date.now();
        this.storage.dataStore.tables[resolvedKeyStr] = keyData;
        this.log('persist-row-keyboard', { key: resolvedKeyStr, rIndex, height: target });
        void this.storage.saveDataStore();
      }
    });
  }

  private attachResizeObserver(table: HTMLTableElement, cols: HTMLTableColElement[], colCount: number): void {
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
          const ch = table.querySelector('.otd-chandle[data-otd-index="' + i + '"]') as HTMLElement | null;
          if (ch) {
            ch.style.top = '0px';
            ch.style.left = `${Math.max(0, acc - 3)}px`;
            ch.style.height = `${Math.max(0, tRect.height)}px`;
          }
        }
        if (this.settings.enableRowResize) {
          const rows = Array.from(table.rows) as HTMLTableRowElement[];
          rows.forEach((row, rIndex) => {
            const rHandle = table.querySelector('.otd-rhandle[data-otd-row-index="' + rIndex + '"]') as HTMLElement | null;
            if (!rHandle) return;
            const rRect = row.getBoundingClientRect();
            layoutRowHandleWithRects(rHandle, tRect, rRect);
          });
        }
        // Re-evaluate breakout when table size changes
        this.breakout.scheduleBreakoutForTable(table);
      });
    });
    ro.observe(table);
  }

  ensureColgroup(table: HTMLTableElement, colCount: number): HTMLTableColElement[] {
    // Find or create a namespaced colgroup for our widths
    let colgroupEl = table.querySelector('colgroup[data-otd="1"]') as HTMLTableColElement | null;
    if (!colgroupEl) {
      const existing = table.querySelector('colgroup');
      colgroupEl = document.createElement('colgroup') as HTMLTableColElement;
      colgroupEl.setAttribute('data-otd', '1');
      if (existing) {
        table.insertBefore(colgroupEl!, existing.nextSibling);
      } else {
        table.insertBefore(colgroupEl!, table.firstChild);
      }
    }
    // Ensure the right number of <col>
    const cols: HTMLTableColElement[] = Array.from((colgroupEl as HTMLTableColElement).querySelectorAll('col')) as HTMLTableColElement[];
    while (cols.length < colCount) {
      const c = document.createElement('col');
      (colgroupEl as HTMLTableColElement).appendChild(c);
      cols.push(c as any);
    }
    while (cols.length > colCount) {
      const c = cols.pop();
      if (c) c.remove();
    }
    return cols as any;
  }

  applyColWidths(cols: HTMLTableColElement[], px: number[]): void {
    for (let i = 0; i < cols.length && i < px.length; i++) {
      const w = Math.max(this.settings.minColumnWidthPx, Math.floor(px[i]));
      (cols[i] as any).style.width = `${w}px`;
    }
  }

  applyRatiosAsPercent(cols: HTMLTableColElement[], ratios: number[]): void {
    for (let i = 0; i < cols.length && i < ratios.length; i++) {
      const pct = Math.max(1, Math.round(ratios[i] * 10000) / 100); // 2 decimals
      (cols[i] as any).style.width = `${pct}%`;
    }
  }

  applyStoredRatiosPercent(table: HTMLTableElement, key: TableKey): void {
    const colCount = Math.max(0, ...Array.from(table.rows).map((r) => r.cells.length));
    if (colCount < 2) return;
    const cols = this.ensureColgroup(table, colCount);
    const kstr = this.storage.findOrMigrateToCanonicalKey(key);
    const stored = this.storage.dataStore.tables[kstr];
    if (!stored || !stored.ratios || stored.ratios.length !== colCount) return;
    this.applyRatiosAsPercent(cols, stored.ratios);
  }

  applyStoredRatiosPx(table: HTMLTableElement, key: TableKey): void {
    const colCount = Math.max(0, ...Array.from(table.rows).map((r) => r.cells.length));
    if (colCount < 2) return;
    const cols = this.ensureColgroup(table, colCount);
    const kstr = this.storage.findOrMigrateToCanonicalKey(key);
    const stored = this.storage.dataStore.tables[kstr];
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
}
