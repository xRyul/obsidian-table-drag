import type { Plugin } from 'obsidian';
import type { TableDragSettings } from '../types';
import type { StorageManager } from '../storage/StorageManager';
import { getColWidths, normalizeRatios } from '../utils/helpers';
import { layoutRowHandleWithRects } from '../utils/layout';

/**
 * RowHandleManager - Manages interactive row height resize handles
 * 
 * @description
 * Handles all row height resizing functionality including:
 * - Creating and positioning row resize handles (`.otd-rhandle`)
 * - Managing drag and keyboard interactions for row height adjustment
 * - Persisting row heights via StorageManager
 * 
 * Extracted from TableManager to improve maintainability and testability.
 * 
 * @class
 */
export class RowHandleManager {
  constructor(
    private plugin: Plugin,
    private settings: TableDragSettings,
    private storage: StorageManager,
    private log: (event: string, details?: any) => void
  ) {}

  /**
   * Attach row resize handles to table rows
   * @param table - The table element
   * @param cols - Array of col elements
   * @param stored - Stored table data (for fallback ratios)
   * @param resolvedKeyStr - Canonical storage key
   */
  attachHandles(
    table: HTMLTableElement,
    cols: HTMLTableColElement[],
    stored: any,
    resolvedKeyStr: string
  ): void {
    const rows = Array.from(table.rows) as HTMLTableRowElement[];
    rows.forEach((row, rIndex) => {
      let rHandle = table.querySelector(`.otd-rhandle[data-otd-row-index="${rIndex}"]`) as HTMLDivElement | null;
      if (!rHandle) {
        rHandle = table.createDiv({
          cls: 'otd-rhandle',
          attr: {
            'tabindex': '0',
            'role': 'separator',
            'aria-label': `Resize row ${rIndex + 1}`,
            'data-otd-row-index': String(rIndex)
          }
        }) as HTMLDivElement;
      }

      // Initial layout
      {
        const tRect = table.getBoundingClientRect();
        const rRect = row.getBoundingClientRect();
        layoutRowHandleWithRects(rHandle, tRect, rRect);
      }

      this.attachListeners(rHandle, row, rIndex, cols, stored, resolvedKeyStr);
    });
  }

  /**
   * Position row handles based on current row positions
   */
  positionHandles(table: HTMLTableElement): void {
    const rows = Array.from(table.rows) as HTMLTableRowElement[];
    const tRect = table.getBoundingClientRect();
    rows.forEach((row, rIndex) => {
      const rHandle = table.querySelector(`.otd-rhandle[data-otd-row-index="${rIndex}"]`) as HTMLElement | null;
      if (!rHandle) return;
      const rRect = row.getBoundingClientRect();
      layoutRowHandleWithRects(rHandle, tRect, rRect);
    });
  }

  private attachListeners(
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
      const keyData = this.storage.dataStore.tables[resolvedKeyStr] ?? {
        ratios: fallbackRatios,
        updatedAt: Date.now(),
      };
      keyData.rowHeights = keyData.rowHeights || {};
      keyData.rowHeights[rIndex] = finalH;
      keyData.updatedAt = Date.now();
      this.storage.dataStore.tables[resolvedKeyStr] = keyData;
      this.log('persist-row-drag', { key: resolvedKeyStr, rIndex, height: finalH });
      void this.storage.saveDataStore();
    };

    this.plugin.registerDomEvent(rHandle, 'pointerdown', (ev: PointerEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      activeR = true;
      startY = ev.clientY;
      startHeight = row.getBoundingClientRect().height;
      rHandle.setPointerCapture((ev as any).pointerId);
      rHandle.focus();
      this.plugin.registerDomEvent(window, 'pointermove', onRMove, { passive: true });
      this.plugin.registerDomEvent(window, 'pointerup', onRUp, { passive: true });
    });

    this.plugin.registerDomEvent(rHandle, 'keydown', (ev: KeyboardEvent) => {
      let used = false;
      let target = row.getBoundingClientRect().height;
      const step = ev.ctrlKey || (ev as any).metaKey ? 1 : this.settings.rowKeyboardStepPx;
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
        const keyData = this.storage.dataStore.tables[resolvedKeyStr] ?? {
          ratios: fallbackRatios,
          updatedAt: Date.now(),
        };
        keyData.rowHeights = keyData.rowHeights || {};
        keyData.rowHeights[rIndex] = target;
        keyData.updatedAt = Date.now();
        this.storage.dataStore.tables[resolvedKeyStr] = keyData;
        this.log('persist-row-keyboard', { key: resolvedKeyStr, rIndex, height: target });
        void this.storage.saveDataStore();
      }
    });
  }
}
