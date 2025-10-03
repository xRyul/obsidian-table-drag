export interface TableKey {
  path: string;
  lineStart: number;
  lineEnd: number;
  fingerprint: string;
}

export interface TableSizes {
  ratios: number[];
  lastPxWidth?: number;
  rowHeights?: Record<number, number>;
  tablePxWidth?: number;
  updatedAt: number;
}

export interface PluginData {
  tables: Record<string, TableSizes>;
  version: number;
}

export interface TableDragSettings {
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

export const DEFAULT_SETTINGS: TableDragSettings = {
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

export interface ContextMeasurement {
  host: 'cm6' | 'reading' | 'unknown';
  paneWidth: number;     // full usable pane width for content (excludes gutters in LP)
  lineWidth: number;     // readable line width
  sideMargin: number;    // kept for backward compat; equals leftOffset
  leftOffset: number;    // exact px from content start to pane left edge
  rightOffset: number;   // exact px from content end to pane right edge
}
