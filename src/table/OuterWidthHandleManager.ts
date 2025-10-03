import type { TableDragSettings } from '../types';
import type { StorageManager } from '../storage/StorageManager';
import type { BreakoutManager } from '../breakout/BreakoutManager';
import { getColWidths, normalizeRatios } from '../utils/helpers';

/**
 * OuterWidthHandleManager - Manages the outer table width resize handle
 * 
 * @description
 * Handles resizing the entire table width using the right-edge handle (`.otd-ohandle`).
 * Supports two modes:
 * - **scale**: All columns scale proportionally
 * - **edge**: Only first and last columns adjust
 * 
 * Also manages horizontal centering for oversized tables during resize.
 * 
 * Extracted from TableManager to improve maintainability and testability.
 * 
 * @class
 */
export class OuterWidthHandleManager {
  constructor(
    private settings: TableDragSettings,
    private storage: StorageManager,
    private breakout: BreakoutManager,
    private log: (event: string, details?: any) => void
  ) {}

  /**
   * Attach outer width resize handle to table's right edge
   * @param table - The table element
   * @param cols - Array of col elements
   * @param colCount - Number of columns
   * @param resolvedKeyStr - Canonical storage key
   * @param positionColumnHandles - Callback to reposition column handles after resize
   */
  attachHandle(
    table: HTMLTableElement,
    cols: HTMLTableColElement[],
    colCount: number,
    resolvedKeyStr: string,
    positionColumnHandles: () => void
  ): void {
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

    this.attachListeners(ohandle, table, cols, colCount, resolvedKeyStr, positionOuter, positionColumnHandles);
  }

  /**
   * Position outer width handle
   */
  positionHandle(table: HTMLTableElement): void {
    const ohandle = table.querySelector('.otd-ohandle') as HTMLDivElement | null;
    if (!ohandle) return;
    const tRect = table.getBoundingClientRect();
    ohandle.style.top = '0px';
    ohandle.style.height = `${Math.max(0, tRect.height)}px`;
    ohandle.style.right = '-2px';
  }

  private applyColWidths(cols: HTMLTableColElement[], widths: number[]): void {
    for (let i = 0; i < cols.length && i < widths.length; i++) {
      const w = Math.max(this.settings.minColumnWidthPx, Math.floor(widths[i]));
      (cols[i] as any).style.width = `${w}px`;
    }
  }

  private attachListeners(
    ohandle: HTMLDivElement,
    table: HTMLTableElement,
    cols: HTMLTableColElement[],
    colCount: number,
    resolvedKeyStr: string,
    positionOuter: () => void,
    positionColumnHandles: () => void
  ): void {
    let startX = 0;
    let startPx: number[] = [];
    let active = false;

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
        next = cur.map((w) => Math.max(this.settings.minColumnWidthPx, Math.floor(w * factor)));
        const diff = targetTotal - next.reduce((a, b) => a + b, 0);
        if (Math.abs(diff) >= 1)
          next[next.length - 1] = Math.max(
            this.settings.minColumnWidthPx,
            next[next.length - 1] + Math.round(diff)
          );
      } else {
        next = [...cur];
        const half = Math.round(delta / 2);
        next[0] = Math.max(this.settings.minColumnWidthPx, next[0] + half);
        next[next.length - 1] = Math.max(this.settings.minColumnWidthPx, next[next.length - 1] + (delta - half));
        const sum = next.reduce((a, b) => a + b, 0);
        if (sum !== targetTotal)
          next[next.length - 1] = Math.max(this.settings.minColumnWidthPx, next[next.length - 1] + (targetTotal - sum));
      }
      this.applyColWidths(cols, next);
      (table.style as any).width = `${Math.floor(targetTotal)}px`;

      // Keep the table visually centered while dragging
      this.centerTableDuringResize(table, targetTotal);

      this.breakout.scheduleBreakoutForTable(table);
      positionColumnHandles();
      positionOuter();
    };

    const onOUp = (_ev: PointerEvent) => {
      if (!active) return;
      active = false;
      this.breakout.outerDragActive.delete(table);
      ohandle.releasePointerCapture((_ev as any).pointerId);
      window.removeEventListener('pointermove', onOMove);
      window.removeEventListener('pointerup', onOUp);
      const finalPx = getColWidths(cols);
      const total = finalPx.reduce((a, b) => a + b, 0);
      const ratios = normalizeRatios(finalPx);
      this.storage.dataStore.tables[resolvedKeyStr] = {
        ratios,
        lastPxWidth: total,
        tablePxWidth: total,
        updatedAt: Date.now(),
      };
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
      ohandle.setPointerCapture((ev as any).pointerId);
      this.log('outer-ptrdown', { key: resolvedKeyStr, startPx, startX });
      window.addEventListener('pointermove', onOMove, { passive: true });
      window.addEventListener('pointerup', onOUp, { passive: true });
    });

    const onKey = (ev: KeyboardEvent) => {
      const cur = getColWidths(cols);
      const totalStart = cur.reduce((a, b) => a + b, 0);
      const step = ev.ctrlKey || (ev as any).metaKey ? 1 : this.settings.keyboardStepPx;
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
        next = cur.map((w) => Math.max(this.settings.minColumnWidthPx, Math.floor(w * factor)));
        const diff = targetTotal - next.reduce((a, b) => a + b, 0);
        if (Math.abs(diff) >= 1)
          next[next.length - 1] = Math.max(
            this.settings.minColumnWidthPx,
            next[next.length - 1] + Math.round(diff)
          );
      } else {
        const delta = targetTotal - totalStart;
        next = [...cur];
        const half = Math.round(delta / 2);
        next[0] = Math.max(this.settings.minColumnWidthPx, next[0] + half);
        next[next.length - 1] = Math.max(this.settings.minColumnWidthPx, next[next.length - 1] + (delta - half));
        const sum = next.reduce((a, b) => a + b, 0);
        if (sum !== targetTotal)
          next[next.length - 1] = Math.max(this.settings.minColumnWidthPx, next[next.length - 1] + (targetTotal - sum));
      }
      this.applyColWidths(cols, next);
      (table.style as any).width = `${Math.floor(targetTotal)}px`;

      // Keep centered while using keyboard adjustments
      this.centerTableDuringResize(table, targetTotal);

      this.breakout.updateBreakoutForTable(table);
      const ratios = normalizeRatios(next);
      this.storage.dataStore.tables[resolvedKeyStr] = {
        ratios,
        lastPxWidth: targetTotal,
        tablePxWidth: targetTotal,
        updatedAt: Date.now(),
      };
      void this.storage.saveDataStore();
      positionColumnHandles();
      positionOuter();
    };
    ohandle.addEventListener('keydown', onKey);
  }

  /**
   * Center table horizontally during resize when it exceeds pane width
   */
  private centerTableDuringResize(table: HTMLTableElement, targetTotal: number): void {
    try {
      const ctxD = this.breakout.measureContextForEl(table);
      const bleed = this.settings.bleedWideTables ? Math.max(0, this.settings.bleedGutterPx || 0) : 0;
      const paneAvail = Math.max(0, ctxD.paneWidth - bleed * 2);
      const cmWrap = table.closest('.cm-table-widget') as HTMLElement | null;
      const rvWrap =
        table.parentElement && table.parentElement.classList.contains('otd-breakout-wrap')
          ? (table.parentElement as HTMLElement)
          : null;
      const scrollEl = cmWrap || rvWrap;
      this.log('outer-drag-center', {
        targetTotal,
        paneAvail,
        cmWrap: !!cmWrap,
        rvWrap: !!rvWrap,
        scrollEl: !!scrollEl,
        host: ctxD.host,
      });
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
  }
}
