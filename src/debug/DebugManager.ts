import { Notice } from 'obsidian';
import type { TableDragSettings } from '../types';
import type { BreakoutManager } from '../breakout/BreakoutManager';
import { getColWidths } from '../utils/helpers';

export class DebugManager {
  private debugBuffer: { ts: number; event: string; details?: any }[] = [];

  constructor(
    private settings: TableDragSettings,
    private breakoutManager: BreakoutManager
  ) {}

  log(event: string, details?: any): void {
    if (!this.settings.enableDebugLogs) return;
    const entry = { ts: Date.now(), event, details: this.settings.debugVerbose ? details : undefined };
    this.debugBuffer.push(entry);
    if (this.debugBuffer.length > Math.max(50, this.settings.debugBufferSize)) {
      this.debugBuffer.shift();
    }
    try {
      console.debug('[otd]', event, details ?? '');
    } catch {}
  }

  /**
   * Build a comprehensive diagnostic snapshot for a given table without mutating layout.
   * Heavy arrays (like per-column widths) are only included when debugVerbose is true.
   */
  snapshotTableDebug(table: HTMLTableElement): any {
    try {
      const ctx = this.breakoutManager.measureContextForEl(table);
      const container = this.breakoutManager.getBreakoutContainer(table);
      const isCM = !!table.closest('.cm-table-widget');
      const isWrapped = !!(table.parentElement && table.parentElement.classList.contains('otd-breakout-wrap'));

      const tStyle = getComputedStyle(table);
      const tRect = table.getBoundingClientRect();
      const cRect = (container as HTMLElement).getBoundingClientRect?.();
      const intrinsic = Math.max(table.scrollWidth || 0, table.offsetWidth || 0, 0);
      const specified = parseFloat((table.style.width || '').replace('px', '')) || 0;

      // Colgroup (our managed one if present)
      const cg = table.querySelector('colgroup[data-otd="1"]');
      const cols = cg ? Array.from(cg.querySelectorAll('col')) as HTMLTableColElement[] : [];
      const colWidths = cols.length ? getColWidths(cols) : [];
      const colSum = colWidths.reduce((a, b) => a + b, 0);

      const desiredBefore = Math.max(intrinsic, specified);
      const desiredWithCols = Math.max(desiredBefore, colSum);

      // Host-specific containers
      const cmScroller = table.closest('.cm-scroller') as HTMLElement | null;
      const cmContent = table.closest('.cm-content') as HTMLElement | null;
      const reading = table.closest('.markdown-reading-view, .markdown-preview-view') as HTMLElement | null;
      const previewSizer = table.closest('.markdown-preview-sizer') as HTMLElement | null;

      const details: any = {
        host: ctx.host,
        paneWidth: ctx.paneWidth,
        lineWidth: ctx.lineWidth,
        leftOffset: ctx.leftOffset,
        rightOffset: ctx.rightOffset,
        wrapped: isWrapped,
        table: {
          class: table.className,
          clientWidth: table.clientWidth,
          offsetWidth: table.offsetWidth,
          scrollWidth: table.scrollWidth,
          rectWidth: Math.round(tRect.width || 0),
          styleWidth: (table.style as any).width || '',
          styleMinWidth: (table.style as any).minWidth || '',
          computedWidth: tStyle.width,
        },
        container: {
          tag: (container as any).tagName || 'div',
          class: (container as HTMLElement).className || '',
          clientWidth: (container as HTMLElement).clientWidth || null,
          offsetWidth: (container as HTMLElement).offsetWidth || null,
          rectWidth: cRect ? Math.round(cRect.width) : null,
          style: {
            width: (container as any).style?.width || '',
            marginLeft: (container as any).style?.marginLeft || '',
            marginRight: (container as any).style?.marginRight || '',
            transform: (container as any).style?.transform || '',
            overflowX: (container as any).style?.overflowX || '',
            paddingLeft: (container as any).style?.paddingLeft || '',
            paddingRight: (container as any).style?.paddingRight || '',
          }
        },
        cm6: isCM ? {
          scrollerClientWidth: cmScroller?.clientWidth ?? null,
          contentClientWidth: cmContent?.clientWidth ?? null,
        } : undefined,
        reading: reading ? {
          readingClientWidth: reading.clientWidth,
          sizerClientWidth: previewSizer?.clientWidth ?? null,
        } : undefined,
        computed: {
          intrinsic,
          specified,
          colSum,
          desiredBefore,
          desiredWithCols,
          willBreakoutIfUsingCols: desiredWithCols > ctx.lineWidth + 1,
          willBreakoutByCurrentLogic: desiredBefore > ctx.lineWidth + 1,
        }
      };
      if (this.settings.debugVerbose) {
        details.columns = { count: cols.length, widths: colWidths };
      }
      return details;
    } catch (e) {
      return { error: String(e) };
    }
  }

  /** Copy a one-shot metrics snapshot of all visible tables in the active leaf to the clipboard. */
  copyVisibleTableMetrics(computeFingerprint: (table: HTMLTableElement) => string): void {
    const activeRoot = document.querySelector('.workspace-leaf.mod-active .markdown-source-view.mod-cm6, .workspace-leaf.mod-active .markdown-reading-view, .workspace-leaf.mod-active .markdown-preview-view') as HTMLElement | null;
    const tables = activeRoot ? Array.from(activeRoot.querySelectorAll('table')) as HTMLTableElement[] : [];
    const payload = {
      ts: new Date().toISOString(),
      settings: this.settings,
      tables: tables.map((t, i) => ({ index: i, fingerprint: computeFingerprint(t), metrics: this.snapshotTableDebug(t) }))
    };
    const text = JSON.stringify(payload, null, 2);
    try {
      if ((navigator as any)?.clipboard?.writeText) {
        (navigator as any).clipboard.writeText(text).then(() => new Notice(`Table Drag: Copied metrics for ${tables.length} table(s).`));
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        new Notice(`Table Drag: Copied metrics for ${tables.length} table(s).`);
      }
    } catch (e) {
      console.error('[otd] Failed to copy metrics', e);
      new Notice('Table Drag: Failed to copy metrics (see console).');
    }
  }

  copyDebugLog(computeFingerprint: (table: HTMLTableElement) => string, dataStoreVersion: number): void {
    const lines = this.debugBuffer.map(e => ({ ts: new Date(e.ts).toISOString(), event: e.event, details: e.details }));
    // Also include a live snapshot of all visible tables in the active leaf so you don't need a separate command/button
    const activeRoot = document.querySelector('.workspace-leaf.mod-active .markdown-source-view.mod-cm6, .workspace-leaf.mod-active .markdown-reading-view, .workspace-leaf.mod-active .markdown-preview-view') as HTMLElement | null;
    const tables = activeRoot ? Array.from(activeRoot.querySelectorAll('table')) as HTMLTableElement[] : [];
    const metrics = tables.map((t, i) => ({ index: i, fingerprint: computeFingerprint(t), metrics: this.snapshotTableDebug(t) }));
    const text = JSON.stringify({ version: dataStoreVersion, settings: this.settings, logs: lines, visibleTables: metrics }, null, 2);
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => new Notice(`Table Drag: Debug log copied (with ${tables.length} table metric snapshot${tables.length === 1 ? '' : 's'}).`));
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      new Notice(`Table Drag: Debug log copied (with ${tables.length} table metric snapshot${tables.length === 1 ? '' : 's'}).`);
    }
  }

  clearDebugLog(): void {
    this.debugBuffer = [];
    new Notice('Table Drag: Debug log cleared.');
  }
}
