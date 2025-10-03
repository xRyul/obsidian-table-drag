import type { Plugin, MarkdownPostProcessorContext } from 'obsidian';
import type { TableKey, TableDragSettings } from '../types';
import type { StorageManager } from '../storage/StorageManager';
import type { BreakoutManager } from '../breakout/BreakoutManager';
import { normalizeRatios } from '../utils/helpers';
import { ColumnHandleManager } from './ColumnHandleManager';
import { OuterWidthHandleManager } from './OuterWidthHandleManager';
import { RowHandleManager } from './RowHandleManager';
import { TableWidthHelper } from './TableWidthHelper';

/**
 * TableManager - Orchestrates interactive table resizing in Obsidian
 * 
 * @description
 * Core coordinator for table resizing functionality. Delegates handle management
 * to specialized managers while handling table detection, fingerprinting, and
 * initial width/height application.
 * 
 * **Responsibilities:**
 * - Table detection and fingerprinting
 * - Initial width/height setup and restoration
 * - Coordination between handle managers
 * - ResizeObserver management for dynamic updates
 * - Integration with BreakoutManager for wide tables
 * 
 * @class
 * @see {@link ColumnHandleManager} For column resize handles
 * @see {@link OuterWidthHandleManager} For outer table width handle
 * @see {@link RowHandleManager} For row height handles
 */
export class TableManager {
  public lastActiveTableEl: HTMLTableElement | null = null;
  public lastActiveKey: TableKey | null = null;

  private columnHandles: ColumnHandleManager;
  private outerHandles: OuterWidthHandleManager;
  private rowHandles: RowHandleManager;
  private widthHelper: TableWidthHelper;

  constructor(
    private plugin: Plugin,
    private settings: TableDragSettings,
    private storage: StorageManager,
    private breakout: BreakoutManager,
    private log: (event: string, details?: any) => void
  ) {
    this.widthHelper = new TableWidthHelper(settings);
    this.columnHandles = new ColumnHandleManager(plugin, settings, storage, log);
    this.outerHandles = new OuterWidthHandleManager(plugin, settings, storage, breakout, log);
    this.rowHandles = new RowHandleManager(plugin, settings, storage, log);
  }

  /**
   * Process all tables in a document section for Reading view
   */
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

  /**
   * Compute stable fingerprint for table identification
   */
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

  /**
   * Main entry point - attach all resize functionality to a table
   */
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

    const cols = this.widthHelper.ensureColgroup(table, colCount);

    // Initialize widths
    const stored = this.storage.dataStore.tables[resolvedKeyStr];
    const tableRect = table.getBoundingClientRect();
    const containerWidth = Math.max(0, tableRect.width);

    // Apply stored or initial widths
    this.initializeTableWidths(table, cols, colCount, stored, resolvedKeyStr, containerWidth);

    // Optional wrapping behavior for long text/URLs
    if (this.settings.wrapLongText) {
      table.classList.add('otd-wrap');
    } else {
      table.classList.remove('otd-wrap');
    }

    // Apply persisted row heights if any
    this.applyStoredRowHeights(table, stored);

    // Setup all resize handles
    this.attachAllHandles(table, key, cols, colCount, resolvedKeyStr, containerWidth, stored);

    // Setup resize observer for handle repositioning
    this.attachResizeObserver(table, cols, colCount);

    // Watch host pane for width changes
    this.watchHostPaneResize(table);

    table.setAttribute('data-otd-bound', '1');

    // Schedule initial breakout computation after DOM layout completes
    this.breakout.scheduleBreakoutForTable(table, 50);
  }

  /**
   * Initialize table widths from stored ratios or compute defaults
   */
  private initializeTableWidths(
    table: HTMLTableElement,
    cols: HTMLTableColElement[],
    colCount: number,
    stored: any,
    resolvedKeyStr: string,
    containerWidth: number
  ): void {
    // If we have stored ratios, apply robustly (px if container > 0; else % and reapply on resize)
    if (stored && stored.ratios.length === colCount) {
      if (stored.tablePxWidth && stored.tablePxWidth > 0) {
        (table.style as any).width = `${Math.floor(stored.tablePxWidth)}px`;
      }
      if (containerWidth > 0) {
        const px = stored.ratios.map((r: number) =>
          Math.max(this.settings.minColumnWidthPx, Math.round(r * containerWidth))
        );
        this.widthHelper.applyColWidths(cols, px);
        table.classList.add('otd-managed');
        this.log('rv-apply-px', { key: resolvedKeyStr, container: containerWidth, px });
      } else {
        this.widthHelper.applyRatiosAsPercent(cols, stored.ratios);
        table.classList.add('otd-managed');
        this.log('rv-apply-%', { key: resolvedKeyStr, ratios: stored.ratios });
        const ro = new ResizeObserver(() => {
          const w = table.getBoundingClientRect().width;
          if (w && w > 0) {
            const px = stored.ratios.map((r: number) =>
              Math.max(this.settings.minColumnWidthPx, Math.round(r * w))
            );
            this.widthHelper.applyColWidths(cols, px);
            this.log('rv-apply-px-late', { key: resolvedKeyStr, container: w, px });
            ro.disconnect();
          }
        });
        ro.observe(table);
        this.plugin.register(() => ro.disconnect());
      }
    } else {
      // derive from header widths or equal split
      let px: number[];
      const headerCells = Array.from(table.querySelectorAll('thead th')) as HTMLTableCellElement[];
      if (headerCells.length === colCount) {
        px = headerCells.map((th) =>
          Math.max(this.settings.minColumnWidthPx, Math.round(th.getBoundingClientRect().width))
        );
      } else {
        const base = Math.max(this.settings.minColumnWidthPx, Math.floor(Math.max(1, containerWidth) / colCount));
        px = new Array(colCount).fill(base);
      }
      // Normalize into ratios for future renders
      const ratios = normalizeRatios(px.map((w) => Math.max(1, w)));
      this.storage.dataStore.tables[resolvedKeyStr] = {
        ratios,
        lastPxWidth: Math.max(1, containerWidth),
        updatedAt: Date.now(),
      };
      this.log('init-ratios', { key: resolvedKeyStr, ratios });
      void this.storage.saveDataStore();
      this.widthHelper.applyColWidths(cols, px);
      table.classList.add('otd-managed');
    }
  }

  /**
   * Apply stored row heights to table rows
   */
  private applyStoredRowHeights(table: HTMLTableElement, stored: any): void {
    const storedRowHeights = stored?.rowHeights ?? {};
    if (storedRowHeights && Object.keys(storedRowHeights).length > 0) {
      Array.from(table.rows).forEach((r, idx) => {
        const h = storedRowHeights[idx];
        if (typeof h === 'number' && h > 0) {
          (r as HTMLTableRowElement).style.height = `${Math.max(this.settings.rowMinHeightPx, Math.floor(h))}px`;
        }
      });
    }
  }

  /**
   * Attach all handle types (column, outer, row) to table
   */
  private attachAllHandles(
    table: HTMLTableElement,
    key: TableKey,
    cols: HTMLTableColElement[],
    colCount: number,
    resolvedKeyStr: string,
    containerWidth: number,
    stored: any
  ): void {
    const onActiveTable = (t: HTMLTableElement, k: TableKey) => {
      this.lastActiveTableEl = t;
      this.lastActiveKey = k;
    };

    // Setup column handles
    this.columnHandles.attachHandles(table, key, cols, colCount, resolvedKeyStr, containerWidth, onActiveTable);

    // Position column handles initially
    this.columnHandles.positionHandles(table, cols, colCount);

    // Apply breakout layout if needed initially
    this.breakout.scheduleBreakoutForTable(table);

    // Setup outer width handle
    if (this.settings.showOuterWidthHandle) {
      const positionColumnHandles = () => this.columnHandles.positionHandles(table, cols, colCount);
      this.outerHandles.attachHandle(table, cols, colCount, resolvedKeyStr, positionColumnHandles);
    }

    // Setup row resize handles
    if (this.settings.enableRowResize) {
      this.rowHandles.attachHandles(table, cols, stored, resolvedKeyStr);
    }
  }

  /**
   * Setup ResizeObserver to track table dimension changes and reposition handles
   */
  private attachResizeObserver(table: HTMLTableElement, cols: HTMLTableColElement[], colCount: number): void {
    let layoutPending = false;
    const ro = new ResizeObserver(() => {
      // Skip RO repositioning while outer drag is active; drag loop already repositions
      if (this.breakout.outerDragActive.has(table)) return;
      if (layoutPending) return;
      layoutPending = true;
      requestAnimationFrame(() => {
        layoutPending = false;

        // Reposition column handles
        this.columnHandles.positionHandles(table, cols, colCount);

        // Reposition outer width handle
        if (this.settings.showOuterWidthHandle) {
          this.outerHandles.positionHandle(table);
        }

        // Reposition row handles
        if (this.settings.enableRowResize) {
          this.rowHandles.positionHandles(table);
        }

        // Re-evaluate breakout when table size changes
        this.breakout.scheduleBreakoutForTable(table);
      });
    });
    ro.observe(table);
    this.plugin.register(() => ro.disconnect());
  }

  /**
   * Watch host pane for width changes to update breakout
   */
  private watchHostPaneResize(table: HTMLTableElement): void {
    const hostToObserve =
      (table.closest('.cm-scroller') as HTMLElement | null) ||
      (table.closest('.markdown-reading-view, .markdown-preview-view') as HTMLElement | null);
    if (hostToObserve) {
      const roPane = new ResizeObserver(() => {
        // Only recompute breakout; table's own RO will reposition handles if size changed
        this.breakout.updateBreakoutForTable(table);
      });
      roPane.observe(hostToObserve);
      this.plugin.register(() => roPane.disconnect());
    }
  }

  /**
   * Apply stored column ratios as percentages
   */
  applyStoredRatiosPercent(table: HTMLTableElement, key: TableKey): void {
    const colCount = Math.max(0, ...Array.from(table.rows).map((r) => r.cells.length));
    if (colCount < 2) return;
    const cols = this.widthHelper.ensureColgroup(table, colCount);
    const kstr = this.storage.findOrMigrateToCanonicalKey(key);
    const stored = this.storage.dataStore.tables[kstr];
    if (!stored || !stored.ratios || stored.ratios.length !== colCount) return;
    this.widthHelper.applyRatiosAsPercent(cols, stored.ratios);
  }

  /**
   * Apply stored column ratios as pixels
   */
  applyStoredRatiosPx(table: HTMLTableElement, key: TableKey): void {
    const colCount = Math.max(0, ...Array.from(table.rows).map((r) => r.cells.length));
    if (colCount < 2) return;
    const cols = this.widthHelper.ensureColgroup(table, colCount);
    const kstr = this.storage.findOrMigrateToCanonicalKey(key);
    const stored = this.storage.dataStore.tables[kstr];
    if (!stored || !stored.ratios || stored.ratios.length !== colCount) return;
    if (stored.tablePxWidth && stored.tablePxWidth > 0) {
      (table.style as any).width = `${Math.floor(stored.tablePxWidth)}px`;
    }
    let w = table.getBoundingClientRect().width;
    if (!w || w <= 0) w = stored.lastPxWidth || stored.tablePxWidth || 0;
    if (!w || w <= 0) return;
    const px = stored.ratios.map((r: number) => Math.max(this.settings.minColumnWidthPx, Math.round(r * w)));
    this.widthHelper.applyColWidths(cols, px);
    table.classList.add('otd-managed');
    this.log('lp-apply-px', { key: kstr, container: w, px });
  }
}
