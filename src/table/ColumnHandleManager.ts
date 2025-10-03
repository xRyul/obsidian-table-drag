import type { Plugin } from 'obsidian';
import type { TableKey, TableDragSettings } from '../types';
import type { StorageManager } from '../storage/StorageManager';
import { getColWidths, normalizeRatios, measureAutofitWidth } from '../utils/helpers';
import { applyDeltaWithSnap } from '../utils/layout';

/**
 * ColumnHandleManager - Manages interactive column resize handles
 * 
 * @description
 * Handles all column resizing functionality including:
 * - Creating and positioning column resize handles (`.otd-chandle`)
 * - Managing drag, keyboard, and double-click interactions
 * - Persisting column width changes via StorageManager
 * 
 * Extracted from TableManager to improve maintainability and testability.
 * 
 * @class
 */
export class ColumnHandleManager {
  constructor(
    private plugin: Plugin,
    private settings: TableDragSettings,
    private storage: StorageManager,
    private log: (event: string, details?: any) => void
  ) {}

  /**
   * Attach column resize handles between columns
   * @param table - The table element
   * @param key - Table identification key
   * @param cols - Array of col elements
   * @param colCount - Number of columns
   * @param resolvedKeyStr - Canonical storage key
   * @param containerWidth - Current container width in pixels
   */
  attachHandles(
    table: HTMLTableElement,
    key: TableKey,
    cols: HTMLTableColElement[],
    colCount: number,
    resolvedKeyStr: string,
    containerWidth: number,
    onActiveTable?: (table: HTMLTableElement, key: TableKey) => void
  ): void {
    const positionHandles = () => this.positionHandles(table, cols, colCount);

    for (let i = 0; i < colCount - 1; i++) {
      let handle = table.querySelector(`.otd-chandle[data-otd-index="${i}"]`) as HTMLDivElement | null;
      if (!handle) {
        handle = table.createDiv({
          cls: 'otd-chandle',
          attr: {
            'data-otd-index': String(i),
            'role': 'separator',
            'aria-label': `Resize column ${i + 1}`,
            'tabindex': '0'
          }
        }) as HTMLDivElement;
      }

      this.attachListeners(
        handle,
        i,
        table,
        key,
        cols,
        colCount,
        resolvedKeyStr,
        containerWidth,
        positionHandles,
        onActiveTable
      );
    }
  }

  /**
   * Position column handles based on current column widths
   */
  positionHandles(table: HTMLTableElement, cols: HTMLTableColElement[], colCount: number): void {
    const widths = getColWidths(cols);
    const tRect = table.getBoundingClientRect();
    let acc = 0;
    for (let i = 0; i < colCount - 1; i++) {
      acc += Math.max(0, widths[i]);
      const ch = table.querySelector(`.otd-chandle[data-otd-index="${i}"]`) as HTMLDivElement | null;
      if (!ch) continue;
      ch.style.top = '0px';
      ch.style.left = `${Math.max(0, acc - 3)}px`;
      ch.style.height = `${Math.max(0, tRect.height)}px`;
    }
  }

  private attachListeners(
    handle: HTMLDivElement,
    colIndex: number,
    table: HTMLTableElement,
    key: TableKey,
    cols: HTMLTableColElement[],
    colCount: number,
    resolvedKeyStr: string,
    containerWidth: number,
    positionHandles: () => void,
    onActiveTable?: (table: HTMLTableElement, key: TableKey) => void
  ): void {
    let startX = 0;
    let leftWidth = 0;
    let rightWidth = 0;
    let active = false;

    const applyColWidths = (widths: number[]) => {
      for (let i = 0; i < cols.length && i < widths.length; i++) {
        const w = Math.max(this.settings.minColumnWidthPx, Math.floor(widths[i]));
        (cols[i] as any).style.width = `${w}px`;
      }
    };

    const onPointerMove = (ev: PointerEvent) => {
      if (!active) return;
      const dx = ev.clientX - startX;
      const total = leftWidth + rightWidth;
      const disableSnap = ev.ctrlKey || (ev as any).metaKey;
      const { newLeft, newRight } = applyDeltaWithSnap(
        leftWidth,
        rightWidth,
        total,
        dx,
        this.settings.minColumnWidthPx,
        this.settings.snapStepPx,
        disableSnap
      );
      const cur = getColWidths(cols);
      cur[colIndex] = newLeft;
      cur[colIndex + 1] = newRight;
      applyColWidths(cur);
      positionHandles();
    };

    const onPointerUp = (_ev: PointerEvent) => {
      if (!active) return;
      active = false;
      handle.releasePointerCapture((_ev as any).pointerId);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      const finalPx = getColWidths(cols);
      const ratios = normalizeRatios(finalPx);
      this.storage.dataStore.tables[resolvedKeyStr] = {
        ratios,
        lastPxWidth: containerWidth,
        updatedAt: Date.now(),
      };
      this.log('persist-drag', { key: resolvedKeyStr, ratios });
      void this.storage.saveDataStore();
    };

    this.plugin.registerDomEvent(handle, 'pointerdown', (ev: PointerEvent) => {
      if (this.settings.requireAltToDrag && !ev.altKey) return;
      ev.preventDefault();
      ev.stopPropagation();
      active = true;
      startX = ev.clientX;
      handle.setPointerCapture((ev as any).pointerId);
      handle.focus();
      if (onActiveTable) onActiveTable(table, key);
      const cur = getColWidths(cols);
      leftWidth = cur[colIndex];
      rightWidth = cur[colIndex + 1];
      this.plugin.registerDomEvent(window, 'pointermove', onPointerMove, { passive: true });
      this.plugin.registerDomEvent(window, 'pointerup', onPointerUp, { passive: true });
    });

    this.plugin.registerDomEvent(handle, 'dblclick', (ev: MouseEvent) => {
      if (onActiveTable) onActiveTable(table, key);
      ev.preventDefault();
      const cur = getColWidths(cols);
      const total = cur[colIndex] + cur[colIndex + 1];
      if (this.settings.doubleClickAction === 'autofit') {
        const targetWidth = measureAutofitWidth(table, colIndex, this.settings.minColumnWidthPx);
        const delta = targetWidth - cur[colIndex];
        const { newLeft, newRight } = applyDeltaWithSnap(
          cur[colIndex],
          cur[colIndex + 1],
          total,
          delta,
          this.settings.minColumnWidthPx,
          this.settings.snapStepPx,
          false
        );
        cur[colIndex] = newLeft;
        cur[colIndex + 1] = newRight;
        applyColWidths(cur);
      } else if (this.settings.doubleClickAction === 'reset') {
        const half = Math.max(this.settings.minColumnWidthPx, Math.floor(total / 2));
        cur[colIndex] = half;
        cur[colIndex + 1] = total - half;
        applyColWidths(cur);
      }
      const ratios = normalizeRatios(cur);
      this.storage.dataStore.tables[resolvedKeyStr] = {
        ratios,
        lastPxWidth: containerWidth,
        updatedAt: Date.now(),
      };
      this.log('persist-dblclick', { key: resolvedKeyStr, ratios });
      void this.storage.saveDataStore();
      positionHandles();
    });

    this.plugin.registerDomEvent(handle, 'keydown', (ev: KeyboardEvent) => {
      if (onActiveTable) onActiveTable(table, key);
      const cur = getColWidths(cols);
      const total = cur[colIndex] + cur[colIndex + 1];
      let used = false;
      const step = ev.ctrlKey || (ev as any).metaKey ? 1 : this.settings.keyboardStepPx;
      if (ev.key === 'ArrowLeft') {
        const { newLeft, newRight } = applyDeltaWithSnap(
          cur[colIndex],
          cur[colIndex + 1],
          total,
          -step,
          this.settings.minColumnWidthPx,
          this.settings.snapStepPx,
          true
        );
        cur[colIndex] = newLeft;
        cur[colIndex + 1] = newRight;
        used = true;
      } else if (ev.key === 'ArrowRight') {
        const { newLeft, newRight } = applyDeltaWithSnap(
          cur[colIndex],
          cur[colIndex + 1],
          total,
          step,
          this.settings.minColumnWidthPx,
          this.settings.snapStepPx,
          true
        );
        cur[colIndex] = newLeft;
        cur[colIndex + 1] = newRight;
        used = true;
      } else if (ev.key === 'Enter' || ev.key === ' ') {
        if (this.settings.doubleClickAction === 'autofit') {
          const targetWidth = measureAutofitWidth(table, colIndex, this.settings.minColumnWidthPx);
          const delta = targetWidth - cur[colIndex];
          const res = applyDeltaWithSnap(
            cur[colIndex],
            cur[colIndex + 1],
            total,
            delta,
            this.settings.minColumnWidthPx,
            this.settings.snapStepPx,
            false
          );
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
        applyColWidths(cur);
        const ratios = normalizeRatios(cur);
        this.storage.dataStore.tables[resolvedKeyStr] = {
          ratios,
          lastPxWidth: containerWidth,
          updatedAt: Date.now(),
        };
        this.log('persist-keyboard', { key: resolvedKeyStr, ratios });
        void this.storage.saveDataStore();
        positionHandles();
      }
    });
  }
}
