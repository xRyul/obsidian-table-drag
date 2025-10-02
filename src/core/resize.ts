export function normalizeRatios(px: number[]): number[] {
  const sum = px.reduce((a, b) => a + Math.max(1, b), 0);
  if (sum <= 0) return px.map(() => 1 / px.length);
  return px.map((w) => Math.max(1, w) / sum);
}

export function applyDelta(left: number, right: number, dx: number, minPx: number): { newLeft: number; newRight: number } {
  let nl = left + dx;
  let nr = right - dx;
  if (nl < minPx) { nr -= (minPx - nl); nl = minPx; }
  if (nr < minPx) { nl -= (minPx - nr); nr = minPx; }
  nl = Math.max(minPx, nl);
  nr = Math.max(minPx, nr);
  return { newLeft: nl, newRight: nr };
}
