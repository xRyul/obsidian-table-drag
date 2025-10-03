import type { TableDragSettings } from '../types';

/**
 * TableWidthHelper - Utility functions for column width management
 * 
 * @description
 * Provides shared utilities for applying column widths and managing colgroups.
 * Used by TableManager and handle managers to avoid code duplication.
 * 
 * @class
 */
export class TableWidthHelper {
  constructor(private settings: TableDragSettings) {}

  /**
   * Ensure table has a namespaced colgroup with correct number of col elements
   * @param table - The table element
   * @param colCount - Number of columns needed
   * @returns Array of col elements
   */
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
    const cols: HTMLTableColElement[] = Array.from(
      (colgroupEl as HTMLTableColElement).querySelectorAll('col')
    ) as HTMLTableColElement[];
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

  /**
   * Apply pixel widths to col elements
   * @param cols - Array of col elements
   * @param px - Array of pixel widths
   */
  applyColWidths(cols: HTMLTableColElement[], px: number[]): void {
    for (let i = 0; i < cols.length && i < px.length; i++) {
      const w = Math.max(this.settings.minColumnWidthPx, Math.floor(px[i]));
      (cols[i] as any).style.width = `${w}px`;
    }
  }

  /**
   * Apply percentage widths to col elements
   * @param cols - Array of col elements
   * @param ratios - Array of ratios (0-1)
   */
  applyRatiosAsPercent(cols: HTMLTableColElement[], ratios: number[]): void {
    for (let i = 0; i < cols.length && i < ratios.length; i++) {
      const pct = Math.max(1, Math.round(ratios[i] * 10000) / 100); // 2 decimals
      (cols[i] as any).style.width = `${pct}%`;
    }
  }
}
