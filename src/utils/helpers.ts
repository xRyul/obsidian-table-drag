import type { TableKey } from '../types';

export function normalizeFingerprint(fp: string): string {
  // Strip any '#index' suffix that LP may append
  const hash = fp.indexOf('#');
  return hash >= 0 ? fp.slice(0, hash) : fp;
}

export function canonicalKeyString(key: TableKey): string {
  return JSON.stringify({ path: key.path, fingerprint: normalizeFingerprint(key.fingerprint) });
}

export function normalizeRatios(px: number[]): number[] {
  const sum = px.reduce((a, b) => a + Math.max(1, b), 0);
  if (sum <= 0) return px.map(() => 1 / px.length);
  return px.map((w) => Math.max(1, w) / sum);
}

export function getColWidths(cols: HTMLTableColElement[]): number[] {
  return cols.map((c) => {
    const v = (c.style.width || '').trim();
    const n = parseFloat(v.replace('px', ''));
    return Number.isFinite(n) ? n : 0;
  }) as number[];
}

export function roundToStep(v: number, step: number): number {
  return step > 0 ? Math.round(v / step) * step : v;
}

export function measureAutofitWidth(table: HTMLTableElement, colIndex: number, minColumnWidthPx: number): number {
  let max = 0;
  const rows = Array.from(table.rows) as HTMLTableRowElement[];
  for (const r of rows) {
    if (colIndex >= r.cells.length) continue;
    const cell = r.cells[colIndex] as HTMLTableCellElement;
    if (!cell) continue;
    const style = getComputedStyle(cell);
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    const contentWidth = cell.scrollWidth || cell.clientWidth;
    const w = Math.ceil(contentWidth + padding + 2); // small buffer
    if (w > max) max = w;
  }
  return Math.max(minColumnWidthPx, max);
}
