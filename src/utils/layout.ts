import { roundToStep } from './helpers';

export function layoutRowHandleWithRects(handle: HTMLElement, tableRect: DOMRect, rowRect: DOMRect): void {
  // Position at the row's bottom edge across full table width relative to table
  const h = (handle.getBoundingClientRect().height || 6);
  const top = rowRect.bottom - tableRect.top - h;
  handle.style.top = `${Math.max(0, top)}px`;
  handle.style.left = `0px`;
  handle.style.width = `${Math.max(0, tableRect.width)}px`;
}

export function applyDeltaWithSnap(
  left: number,
  right: number,
  total: number,
  dx: number,
  minPx: number,
  step: number,
  disableSnap: boolean
): { newLeft: number; newRight: number } {
  let nl = left + dx;
  nl = Math.max(minPx, Math.min(total - minPx, nl));
  if (!disableSnap && step > 0) {
    nl = roundToStep(nl, step);
    nl = Math.max(minPx, Math.min(total - minPx, nl));
  }
  const nr = total - nl;
  return { newLeft: nl, newRight: nr };
}
