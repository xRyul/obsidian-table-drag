import type { Plugin } from 'obsidian';
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
  private lastCenterAt = new WeakMap<HTMLTableElement, number>();
  // Track whether a table is currently considered "wide" for hysteresis-based centering
  private wideState = new WeakMap<HTMLTableElement, boolean>();

  constructor(
    private plugin: Plugin,
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
      ohandle = table.createDiv({
        cls: 'otd-ohandle',
        attr: {
          'role': 'separator',
          'aria-label': 'Resize table width',
          'tabindex': '0'
        }
      }) as HTMLDivElement;
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

    // rAF coalescing for pointer moves
    let rafId: number | null = null;
    let pendingTargetTotal: number | null = null;

    const totalStartFrom = () => startPx.reduce((a, b) => a + b, 0);

    const computeNext = (targetTotal: number): number[] => {
      const totalStart = totalStartFrom();
      const cur = [...startPx];
      const delta = targetTotal - totalStart;
      if (this.settings.outerHandleMode === 'scale') {
        const factor = totalStart > 0 ? targetTotal / totalStart : 1;
        const next = cur.map((w) => Math.max(this.settings.minColumnWidthPx, Math.floor(w * factor)));
        const diff = targetTotal - next.reduce((a, b) => a + b, 0);
        if (Math.abs(diff) >= 1)
          next[next.length - 1] = Math.max(
            this.settings.minColumnWidthPx,
            next[next.length - 1] + Math.round(diff)
          );
        return next;
      } else {
        const next = [...cur];
        const half = Math.round(delta / 2);
        next[0] = Math.max(this.settings.minColumnWidthPx, next[0] + half);
        next[next.length - 1] = Math.max(this.settings.minColumnWidthPx, next[next.length - 1] + (delta - half));
        const sum = next.reduce((a, b) => a + b, 0);
        if (sum !== targetTotal)
          next[next.length - 1] = Math.max(
            this.settings.minColumnWidthPx,
            next[next.length - 1] + (targetTotal - sum)
          );
        return next;
      }
    };

    const commit = () => {
      rafId = null;
      const t = pendingTargetTotal;
      pendingTargetTotal = null;
      if (t == null) return;
      const next = computeNext(t);
      this.applyColWidths(cols, next);
      (table.style as any).width = `${Math.floor(t)}px`;

      // Keep the table visually centered while dragging
      this.centerTableDuringResize(table, t);

      // Batch dependent updates (avoid Breakout recompute during drag to reduce flicker)
      positionColumnHandles();
      positionOuter();
    };

    const onOMove = (ev: PointerEvent) => {
      if (!active) return;
      const dx = ev.clientX - startX;
      const totalStart = totalStartFrom();
      let targetTotal = totalStart + dx;
      const minTotal = colCount * this.settings.minColumnWidthPx;
      if (targetTotal < minTotal) targetTotal = minTotal;
      if (this.settings.outerMaxWidthPx > 0) targetTotal = Math.min(targetTotal, this.settings.outerMaxWidthPx);
      pendingTargetTotal = targetTotal;
      if (rafId == null) {
        rafId = requestAnimationFrame(commit);
      }
    };

    const onOUp = (_ev: PointerEvent) => {
      if (!active) return;
      active = false;
      this.breakout.outerDragActive.delete(table);
      ohandle.releasePointerCapture((_ev as any).pointerId);
      window.removeEventListener('pointermove', onOMove);
      window.removeEventListener('pointerup', onOUp);

      // Flush any pending frame before persisting
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
        commit();
      }

      const finalPx = getColWidths(cols);
      const total = finalPx.reduce((a, b) => a + b, 0);
      const ratios = normalizeRatios(finalPx);
      this.storage.dataStore.tables[resolvedKeyStr] = {
        ratios,
        lastPxWidth: total,
        tablePxWidth: total,
        updatedAt: Date.now(),
      };
      // Reset drag-state hysteresis so next drag starts fresh
      this.wideState.delete(table);
      // Force an immediate breakout recompute to clear or apply transforms as needed,
      // then schedule another pass to settle after layout.
      this.breakout.updateBreakoutForTable(table);
      this.breakout.scheduleBreakoutForTable(table);
      this.log('outer-drag', { key: resolvedKeyStr, mode: this.settings.outerHandleMode, total });
      void this.storage.saveDataStore();
    };

    this.plugin.registerDomEvent(ohandle, 'pointerdown', (ev: PointerEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      active = true;
      startX = ev.clientX;
      startPx = getColWidths(cols);
      this.breakout.outerDragActive.add(table);
      ohandle.setPointerCapture((ev as any).pointerId);
      this.log('outer-ptrdown', { key: resolvedKeyStr, startPx, startX });
      this.plugin.registerDomEvent(window, 'pointermove', onOMove, { passive: true });
      this.plugin.registerDomEvent(window, 'pointerup', onOUp, { passive: true });
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
      const next = computeNext(targetTotal);
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
    this.plugin.registerDomEvent(ohandle, 'keydown', onKey);
  }

  /**
   * Center table horizontally during resize when it exceeds pane width
   */
  private centerTableDuringResize(table: HTMLTableElement, targetTotal: number): void {
    try {
      // Throttle during drag; but do NOT fight the breakout transform.
      if (this.breakout.outerDragActive.has(table)) {
        const now = performance.now();
        const last = this.lastCenterAt.get(table) || 0;
        if (now - last < 50) return; // at most 20Hz
        this.lastCenterAt.set(table, now);
      }

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

      // During drag, avoid changing scrollLeft or clearing/setting transforms.
      // Let the current breakout transform remain stable; on pointerup we will
      // immediately recompute breakout and clear/apply transforms as needed.
    } catch (e) {
      this.log('outer-drag-center-error', e);
    }
  }
}
