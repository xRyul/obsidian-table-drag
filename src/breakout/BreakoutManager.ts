import type { TableDragSettings, ContextMeasurement } from '../types';

export class BreakoutManager {
  private breakoutRAF = new WeakMap<HTMLTableElement, number>();
  private breakoutRetryCount = new WeakMap<HTMLTableElement, number>();
  public outerDragActive = new WeakSet<HTMLTableElement>();

  constructor(
    private settings: TableDragSettings,
    private log: (event: string, details?: any) => void
  ) {}

  /** Choose the element we should wrap for breakout.
   * In Live Preview (CM6), wrap the .cm-table-widget to avoid inner clipping/scrollbars.
   * In Reading view, wrap the table itself.
   */
  getBreakoutContainer(table: HTMLTableElement): HTMLElement {
    return (table.closest('.cm-table-widget') as HTMLElement | null) || table;
  }

  /** Remove legacy wrapper from earlier versions (wrapper directly around <table>). */
  cleanupLegacyBreakout(table: HTMLTableElement): void {
    const p = table.parentElement;
    if (p && p.classList.contains('otd-breakout-wrap')) {
      const gp = p.parentElement;
      if (gp) gp.insertBefore(table, p);
      p.remove();
    }
  }

  /** Ensure a breakout wrapper exists for the container and return it. */
  ensureBreakoutWrapper(table: HTMLTableElement): HTMLDivElement {
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
  removeBreakoutWrapper(table: HTMLTableElement): void {
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

  /** Schedule a breakout computation for the next animation frame (coalesces bursts). */
  scheduleBreakoutForTable(table: HTMLTableElement, delayMs = 0): void {
    if (this.breakoutRAF.has(table)) return;
    const schedule = () => {
      const id = requestAnimationFrame(() => {
        this.breakoutRAF.delete(table);
        this.updateBreakoutForTable(table);
      });
      this.breakoutRAF.set(table, id);
    };
    if (delayMs > 0) {
      setTimeout(schedule, delayMs);
    } else {
      schedule();
    }
  }

  // Cached measurements for breakout calculations (updated per-table when needed)
  // NOTE: Return precise left/right offsets so we can align exactly with the host pane edges.
  measureContextForEl(el: HTMLElement): ContextMeasurement {
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
    // Log why reading mode failed if debug enabled
    if (this.settings?.enableDebugLogs) {
      console.debug('[otd] Reading mode measurement failed', {
        hasReading: !!reading,
        hasPreviewSizer: !!previewSizer,
        readingClass: reading?.className,
        sizerClass: previewSizer?.className
      });
    }
    return { host: 'unknown', paneWidth: 0, lineWidth: 0, sideMargin: 0, leftOffset: 0, rightOffset: 0 };
  }

  /**
   * Update or remove breakout for a given table based on its intrinsic width vs readable line width.
   * - If table is wider than the readable line width, we wrap it in a scrollable container that expands to pane width
   *   and offsets the centered sizer margins so the table visually fills the pane.
   * - Otherwise, we remove any wrapper and keep normal flow.
   */
  updateBreakoutForTable(table: HTMLTableElement): void {
    try {
      // Skip breakout for tables that are inactive or not visible (e.g., when view mode switches)
      if (table.offsetParent === null || table.classList.contains('otd-inactive')) {
        this.log('breakout-skip-inactive', { class: table.className });
        return;
      }
      
      const ctx = this.measureContextForEl(table);
      // If the host view is inactive or not yet laid out, its widths can be 0. Do not tear down wrappers in that case.
      if (ctx.paneWidth <= 0 || ctx.lineWidth <= 0) {
        const retries = this.breakoutRetryCount.get(table) || 0;
        this.log('breakout-skip-noctx', { host: ctx.host, paneWidth: ctx.paneWidth, lineWidth: ctx.lineWidth, retries });
        // Try again with exponential backoff, up to 5 attempts
        if (retries < 5) {
          this.breakoutRetryCount.set(table, retries + 1);
          const delay = Math.min(100, 10 * Math.pow(2, retries)); // 10ms, 20ms, 40ms, 80ms, 100ms
          this.scheduleBreakoutForTable(table, delay);
        } else {
          // After 5 retries, clear the counter and give up for now
          this.breakoutRetryCount.delete(table);
        }
        return;
      }
      // Reset retry counter on successful measurement
      this.breakoutRetryCount.delete(table);
      const container = this.getBreakoutContainer(table);
      const intrinsic = Math.max(table.scrollWidth, table.offsetWidth, 0);
      const specified = parseFloat((table.style.width || '').replace('px', '')) || 0;
      const desired = Math.max(intrinsic, specified);

      if (desired > ctx.lineWidth + 1) {
        // Optional bleed padding to avoid hugging pane edges
        const bleed = this.settings.bleedWideTables ? Math.max(0, this.settings.bleedGutterPx || 0) : 0;
        const leftAdj = Math.max(0, ctx.leftOffset - bleed);
        const rightAdj = Math.max(0, ctx.rightOffset - bleed);
        const paneAvail = Math.max(0, ctx.paneWidth - bleed * 2);
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
          // Reading view: apply breakout directly to table without wrapper
          // Clean up any existing wrapper first
          this.removeBreakoutWrapper(table);
          const targetML = `${-Math.floor(leftAdj)}px`;
          const targetMR = `${-Math.floor(rightAdj)}px`;
          // DON'T override table.style.width - it should be set from stored data
          if (table.style.marginLeft !== targetML) table.style.marginLeft = targetML;
          if (table.style.marginRight !== targetMR) table.style.marginRight = targetMR;
          const wantScroll = desired > paneAvail + 1 ? 'auto' : 'visible';
          if (table.style.overflowX !== wantScroll) table.style.overflowX = wantScroll;
          // Use relative positioning with high z-index to render above preview sizer background
          if (table.style.position !== 'relative') table.style.position = 'relative';
          if (table.style.zIndex !== '10') table.style.zIndex = '10';
          // Add background to cover white preview sizer
          if (table.style.background !== 'var(--background-primary)') table.style.background = 'var(--background-primary)';
          // When not overflowing the pane, pad both sides so the table stays centered visually
          const pad = wantScroll === 'visible' ? Math.max(0, Math.floor((paneAvail - desired) / 2)) : 0;
          if (table.style.paddingLeft !== `${pad}px`) table.style.paddingLeft = `${pad}px`;
          if (table.style.paddingRight !== `${pad}px`) table.style.paddingRight = `${pad}px`;
          table.classList.add('otd-breakout');
        }
        this.log('breakout-apply', { paneWidth: ctx.paneWidth, lineWidth: ctx.lineWidth, desired, side: ctx.sideMargin, host: ctx.host, mode: ctx.host === 'cm6' ? 'cm6-inline' : 'reading-wrap' });
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
        (container as HTMLElement).style.background = '';
        container.classList.remove('otd-breakout-cm');
        this.removeBreakoutWrapper(table);
        table.classList.remove('otd-breakout');
        // Also clean table-specific reading mode styles
        table.style.width = '';
        table.style.marginLeft = '';
        table.style.marginRight = '';
        table.style.overflowX = '';
        table.style.position = '';
        table.style.zIndex = '';
        table.style.paddingLeft = '';
        table.style.paddingRight = '';
        table.style.background = '';
      }
    } catch (e) {
      // Non-fatal
    }
  }
}
