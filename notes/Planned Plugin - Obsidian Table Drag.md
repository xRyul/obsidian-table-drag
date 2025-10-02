---
title: Planned Plugin - Obsidian Table Drag
type: note
permalink: notes/planned-plugin-obsidian-table-drag
---

# Planned Plugin: Obsidian Table Drag

Date: 2025-10-02

## Executive summary
Create a plugin that adds smooth, persistent drag-to-resize for Markdown table columns (and optionally rows) in both Reading view and Live Preview. Store widths as ratios (responsive) in plugin data by default, with an opt-in to materialize widths into Markdown via <colgroup> when desired.

## Why this approach
- <colgroup> controls table layout natively, minimizing CSS hacks and theme conflicts.
- Ratio-based persistence scales cleanly with pane resizes and different themes.
- PostProcessor + CM6 ViewPlugin cover Reading view and Live Preview without duplicating heavy logic.
- Plugin data keeps Markdown pristine; optional materialization provides portability outside Obsidian.

## Stack usage
- TypeScript: Typed core and integrations (Obsidian API + CM6 + DOM).
- Obsidian API: markdown post-processing, editor extension, persistence (saveData/loadData), vault events.
- CodeMirror 6: ViewPlugin overlays + DOM measurement in Live Preview.
- React + shadcn/ui + TailwindCSS: Settings UI only (no content-pane UI).
- lucide icons: Ribbon/commands/handle iconography.
- Electron Pointer Events: Robust drag with setPointerCapture.
- Vitest (+ JSDOM): Core math and DOM injection tests.

## Architecture
1) Persistence
- Key: { path, lineStart, lineEnd, fingerprint } where fingerprint = `${maxCols}:${theadTexts.join('|')}`.
- Store: { ratios: number[], lastPxWidth?: number, rowHeights?: Record<number, number>, updatedAt }.
- Migrate gracefully when line ranges or columns change (fingerprint-first match).

2) Reading view integration
- MarkdownPostProcessor locates <table> elements.
- Inject <colgroup><col style="width: Xpx"> from ratios × current container width.
- Overlay resizer handles at column boundaries; drag updates adjacent columns, enforces min/max, optional snap.
- Double-click handle: autofit by measuring column content widths (scrollWidth).
- IntersectionObserver + ResizeObserver for visibility and container changes.

3) Live Preview (CM6)
- ViewPlugin scans editor DOM for rendered tables; reuse the same resizer logic.
- Handles positioned relative to editor scroller.
- Map table to persistence key using section info or syntax tree range; fallback to fingerprint.

## Resizing behavior
- Ratios -> px each render: px[i] = clamp(ratios[i] * containerWidth).
- On drag: adjust target and neighbor (or distribute with modifiers), enforce minPx/maxPx, optional snap step; renormalize to ratios when persisting.
- Modifiers: Shift = distribute to all right columns; Alt = symmetric left/right; Ctrl/Cmd = bypass snap.

## Settings (initial)
- Enable/disable plugin.
- Min column width (px) and optional max.
- Snap step (px), px vs % display.
- Double-click behavior (autofit current/all/reset).
- Show row handles (on/off).
- Compatibility mode (require modifier; defer to known plugins).
- Materialize widths to Markdown (on-demand).

## Accessibility & i18n
- 6–10px hit targets, focus outlines, ARIA labels.
- Keyboard resizing via arrow keys + step.
- RTL-safe via rect-based positioning.

## Edge cases
- Colspans: compute boundaries from effective columns; prefer max-cells row.
- Very narrow columns: enforce minPx; no negative widths.
- Long tables: activate lazily; throttle pointermove; batch DOM writes.
- Vault refactors: rekey on rename/move.

## Testing plan (Vitest)
- Pure math: distribution, normalization, min/max, snapping.
- Autofit measurement: simulate with JSDOM.
- DOM insertion idempotency for <colgroup>.
- Smoke lifecycle tests for post-processor and CM6 plugin.

## Roadmap
1. MVP: Reading view column resizing, persistence, basic settings.
2. Live Preview: CM6 overlay with same interactions.
3. Autofit + keyboard + snapping.
4. Optional row resizing.
5. Materialize widths to Markdown (opt-in).

## Reference
- Detailed write-up in repo: docs/01-initial-idea.md