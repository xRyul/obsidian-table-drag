---
title: Phased Implementation Plan
type: note
permalink: docs/phased-implementation-plan
---

# Phased Implementation Plan

Date: 2025-10-02
Project: obsidian-table-drag

Purpose
- Deliver resizable Markdown tables in Obsidian with a robust, theme-safe, and performant implementation.
- Build iteratively with clear success criteria, tests, and rollback safety.

Guiding principles
- Idempotent DOM updates (tagged nodes, update-in-place)
- Ratios as source of truth, px as a render-time derivative
- Single overlay per editor; lazy activation via observers
- Opt-in file mutations only (materialization)
- Accessibility-first handles and keyboard paths

Phase 1 — MVP: Reading View Column Resizing
Scope
- MarkdownPostProcessor attaches to tables in Reading view
- Inject <colgroup> for column widths
- Resizer handles at column boundaries, pointer drag to adjust adjacent columns
- Persistence: ratios + lastPxWidth keyed by {path, lineStart, lineEnd, fingerprint}
- Settings: enable/disable, min column width, snap step, require-modifier option
- Commands: Reset current table widths

Tasks
- core/resize.ts: distributeResize, normalizeRatios, clamp, snap utilities
- Post-processor: find tables, compute TableKey, attach resizers
- DOM: idempotent <colgroup> and handle container injection (data-otd attributes)
- PointerEvents: drag lifecycle with setPointerCapture; throttle pointermove; rAF batching
- Observers: IntersectionObserver for visibility; ResizeObserver for container
- Persistence: saveData/loadData; rename/move rekey logic
- Settings: basic tab with toggles and numeric inputs
- Tests (Vitest): pure math unit tests; JSDOM idempotency tests for <colgroup>

Acceptance criteria
- Can resize columns on rendered tables; widths persist across reopen
- No duplicated <colgroup> or handle containers after multiple reprocesses
- No visible jank on typical tables; CPU stable during drag

Risks
- Theme CSS forcing table-layout or widths; mitigate by preferring <colgroup> and minimal scoped CSS
- Complex colspans; for MVP, show handles only on simple header rows

Estimate
- 1–2 days

Phase 2 — Live Preview (CM6) Integration
Scope
- ViewPlugin attaches to Live Preview’s rendered tables
- Single overlay per editor, handles aligned via table bounding rects
- Map tables to persistence keys (section info or syntax tree range; fallback to fingerprint)
- Multi-pane sync: width changes reflected across panes

Tasks
- CM6 ViewPlugin skeleton and lifecycle (update/destroy)
- Table scan limited to viewport; reuse reading view resizer logic
- Overlay anchored to view.scrollDOM; recycle handle elements
- Sync mechanism: lightweight event or invalidation to re-render other panes
- Tests: smoke tests for lifecycle and multi-pane refresh

Acceptance criteria
- Same UX in Live Preview as Reading view
- No memory leaks after opening/closing panes

Risks
- Live Preview DOM variance across Obsidian versions; feature-gate if needed

Estimate
- 1–2 days

Phase 3 — Autofit, Keyboard, Snapping Polish
Scope
- Double-click to autofit column to content (measure scrollWidth)
- Keyboard-resizable handles with step increments and ARIA labels
- Snap toggle via modifier (Ctrl/Cmd to bypass)

Tasks
- Measure content widths efficiently (defer heavy reads to double-click or drag-end)
- Keyboard focus/aria roles for handles; arrow key handling with step
- Settings: double-click behavior (autofit current/all/reset)
- Tests: math for autofit clamping and distribution

Acceptance criteria
- Autofit works and feels instant on typical tables
- Keyboard-only users can resize columns

Estimate
- ~1 day

Phase 4 — Row Resizing (Optional)
Scope
- Row bottom-edge handles; apply min-height to rows
- Persistence of per-row minHeight

Tasks
- Handle positioning for row boundaries; pointer drag to adjust min-height
- Respect content wrapping; avoid fixed heights
- Settings: show row handles (on/off)
- Tests: persistence and idempotent style updates

Acceptance criteria
- Rows can be made taller without clipping content

Estimate
- 0.5–1 day

Phase 5 — Materialize Widths (Opt-in)
Scope
- Command to write <colgroup> into Markdown for selected table
- Idempotent insertion and removal (revert action)
- Clear confirmation and docs about portability trade-offs

Tasks
- Identify table source range; safely insert/remove HTML block
- Maintain plugin data alongside materialized widths
- Settings: enable/disable feature; advanced warning
- Tests: round-trip idempotency on sanitized input

Acceptance criteria
- Users can persist widths into Markdown explicitly; no silent mutations

Estimate
- ~0.5 day

Phase 6 — Compatibility, Theming, RTL
Scope
- Modifier-required drag mode to avoid conflicts
- Known plugin/table class detection; defer when conflicts found
- CSS scoping and variables for theme friendliness
- RTL correctness in handle positions and resizing math

Tasks
- Implement detection hooks and user overrides
- Document CSS variables and theming tips
- Test in RTL and various community themes

Acceptance criteria
- No conflicts in common setups; clearly documented escape hatches

Estimate
- ~0.5–1 day

Phase 7 — Performance Hardening
Scope
- Profile drag loops; throttle/tune rAF batching
- Stress tests: long tables, many tables per note
- Memory audit for observers and overlays

Tasks
- Add performance marks/timing during dev builds
- Optimize selector queries, reuse nodes, minimize layout reads
- Ensure observers disconnect promptly

Acceptance criteria
- Smooth interaction under stress; no leaks after repeated pane cycles

Estimate
- ~0.5–1 day

Phase 8 — Packaging & Release
Scope
- Manifest, versions, minAppVersion
- README with GIFs, settings docs, compatibility notes
- Changelog, license, CI (lint/test/build)

Tasks
- Build pipeline and size budget checks
- Demo note with sample tables and screenshots

Acceptance criteria
- Installable in Obsidian; docs sufficient for users to succeed

Estimate
- ~0.5 day

Dependencies and sequencing
- Phase 1 is prerequisite for all others
- Phase 2 requires stable persistence and idempotent DOM logic
- Phase 5 depends on accurate source range mapping and robust idempotency

Exit criteria checklist (per phase)
- Scope implemented and manually verified in Windows/macOS themes
- Tests updated and passing; no leaks in quick lifecycle checks
- Docs updated (README section or docs/ note)

Open questions
- Do we need per-header presets in MVP, or post-GA?
- Should we support per-note opt-outs (frontmatter or inline marker)?
- What minimum Obsidian version should we target for Live Preview DOM stability?


---
### Status update (2025-10-02)
- Phase 1 — MVP (Reading View Column Resizing): DONE
  - Idempotent <colgroup> injection with data-otd=1
  - Column handles render and persist ratios per table
  - New: handles now span full table height for better discoverability (layout adjusted via ResizeObserver)
- Phase 2 — Live Preview (CM6): BASIC IMPLEMENTATION DONE
  - ViewPlugin scans editor DOM and attaches same resizers
  - Uses MutationObserver to re-attach on DOM changes
  - Next: refine keying beyond index suffix; add overlay reuse and viewport limiting

Next up
- Phase 3 — Autofit + keyboard + snapping
  - Implement double-click autofit and keyboard resizing
- Phase 4 — Row resizing
  - Not started; will add bottom-edge handles and min-height persistence

Notes
- If you don’t see handles, verify plugin enabled and try toggling Alt-to-drag setting.
- Some themes may make handle hover subtle; we’ve increased z-index and height to improve UX.


---
### Phase 3 — Autofit + Keyboard + Snapping (2025-10-02)
Implemented:
- Double-click handle to autofit current column to content (fallback using scrollWidth + padding).
- Keyboard support on focused handle: Left/Right arrows resize by step; Ctrl/Cmd = 1px precision; Enter/Space triggers autofit.
- Snapping during drag to configurable step (default 8px); hold Ctrl/Cmd to bypass.
- A11y: handles are focusable separators with aria-labels.

Settings added:
- Snap step (px)
- Keyboard step (px)
- Double-click action (Autofit/Reset/None)

Next hardening:
- Improve autofit measurement for mixed content/inline elements (consider offscreen measurement sandbox).
- Viewport-limited scanning in Live Preview and overlay reuse.


---
### Cross-view and cross-device persistence (2025-10-02)
- Persistence key canonicalization: { path, fingerprint } with normalized fingerprint (thead th, else first row; no LP index suffix).
- Auto-migration: legacy keys copied to canonical on first access.
- Ratios as source of truth: widths scale across themes, DPI, and OS.
- Sync guidance: enable 'Sync plugin data' (Obsidian Sync) or include .obsidian/plugins/obsidian-table-drag/data.json in your VCS/cloud sync.
- Debugging: toggle with `localStorage.setItem('otd-debug','1')` to see resolved keys and stored status.
- Caveats: if headers/column count change, fingerprint changes; prior widths won't apply by design (treated as a different table).


---
### Phase 4 — Row Resizing (2025-10-02)
Implemented:
- Horizontal row handles (bottom edge) to adjust row heights by drag or keyboard.
- Persistence: per-row height stored under the table’s canonical key (rowHeights[rowIndex]).
- Settings: Enable row resizing, Row minimum height (px), Row keyboard step (px).
- A11y: handles are focusable separators with keyboard support.

Notes:
- We set row.style.height; content larger than this will expand the row naturally.
- Wrapping and content changes may increase effective row height beyond the stored value.
- Known limits: min-height on table-cell is inconsistently respected across engines; this approach avoids clipping.


---
### Phase 5 — Materialize Widths (2025-10-02)
Implemented (opt-in):
- Command: "Materialize widths: insert HTML copy of last active table" — inserts an HTML <table> with <colgroup> (percent widths) at the cursor.
- Command: "Materialize widths: copy HTML of last active table" — copies HTML to clipboard.
- Uses canonical table key (path + fingerprint) and stored ratios to create <colgroup> widths.
- Idempotent: builds fresh HTML regardless of runtime DOM; does not modify the original Markdown table.

Usage:
1) Interact with a table (click/drag/keyboard) so it becomes the "last active" table.
2) Run one of the commands to insert or copy the materialized HTML.

Notes:
- This avoids surprising in-place mutations to Markdown, preserving the original content; users can replace the Markdown table manually if desired.
- Percent widths are used so the materialized table remains responsive.
- Reversion is trivial (delete the HTML block) since the source Markdown table is left intact.


---
### Performance Hardening Plan — Viewport-limited scanning & handle reuse (to implement)
Rationale
- Reduce DOM work and CPU usage for large notes with many tables
- Avoid re-creating handles during frequent Live Preview re-renders

Plan
1) Viewport-limited scanning (Live Preview)
   - Use IntersectionObserver on editor scrollDOM to detect visible tables
   - Bind resizers only for tables intersecting viewport (+margin)
   - Unbind/park resizers for offscreen tables
   - Add perf debug logs: activeTables, parkedTables, observer callbacks

2) Handle reuse / pooling
   - Maintain per-editor pools for vertical (column) and horizontal (row) handles
   - On table activation: borrow N handles and position them
   - On deactivation: return handles to pool (hidden) instead of removing
   - Add perf counters: allocatedHandles, pooledHandles, reuseHits

Success criteria
- Scrolling long documents remains smooth (no jank)
- Typing incurs minimal observer/DOM updates
- Diagnostics show handle reuse > 80% after warm-up

Notes
- Behavior remains identical to current UX; this is a pure perf improvement.
