# Obsidian Table Drag — Initial Idea

Date: 2025-10-02

## Summary
Enable intuitive, persistent resizing of Markdown table columns (and optionally rows) in both Reading view and Live Preview, with widths stored outside the note by default and an opt-in mechanism to materialize widths into the Markdown for portability.

## Goals
- Drag-to-resize table columns in Reading view and Live Preview (WYSIWYG).
- Optional row min-height resizing.
- Persistence that survives pane resizes and theme changes.
- Minimal impact on note content (no file modifications by default).
- Low overhead, theme-safe, compatible with other table plugins.

## Non-goals (initial release)
- Source Mode text-based table editing/resizing.
- Complex spreadsheet features (sorting, formulas, cell merging logic beyond standard Markdown rendering).
- Cross-note sync of per-table presets (can be future work).

## User stories
- As a writer, I want to drag a column boundary to widen it, and have that width persist the next time I open the note.
- As a researcher, I want double-click to auto-fit a column to its content.
- As a power user, I want my column widths to scale when I resize the pane, not overflow or collapse.
- As an accessibility-focused user, I want keyboard-accessible handles and clear affordances.

## Tech stack mapping (why it fits)
- TypeScript: typed logic across Obsidian API, CM6, DOM, and storage; easier maintenance.
- Obsidian API: markdown post-processing for Reading view; editor extensions for Live Preview; saveData/loadData for persistence; vault events for refactors.
- CodeMirror 6: ViewPlugin to anchor and update resizer UI in Live Preview; precise DOM alignment on rendered tables.
- React + shadcn/ui + TailwindCSS: rich Settings UI (compiled CSS/JS only; no runtime UI in content panes).
- lucide icons: cohesive iconography for ribbon/commands/handles.
- Electron (Pointer Events): robust cross-platform dragging with pointer capture.
- Vitest (+ JSDOM): test core resizing math and DOM injection behavior.

## Architecture overview
1) Data/persistence layer
- Key tables by: file path, lineStart/lineEnd (section info), and a fingerprint (header text + column count) for resilience.
- Store column sizes as ratios (sum ~ 1.0) and track last measured container pixel width. Recompute exact px on render using current container width.
- Optional per-row min-heights.

2) Reading view integration
- MarkdownPostProcessor locates tables and attaches resizers.
- Inject a <colgroup> into the table DOM to control column widths without heavy CSS.
- Resizer handles are absolutely positioned with pointer events; update <col> widths live.

3) Live Preview integration (CM6)
- ViewPlugin scans the editor’s DOM for rendered tables and applies the same resizer logic.
- Alignment computed relative to the editor scroller; re-attach on updates/viewport changes.

4) Settings/UX
- Settings tab (React/shadcn/Tailwind) for defaults: min width, snap step, px vs %, double-click behavior, row handles, compatibility toggles.
- Ribbon icon, palette commands (toggle, reset, autofit, materialize widths).

## Data model
- TableKey: { path, lineStart, lineEnd, fingerprint }
- TableSizes: {
  ratios: number[];        // normalized widths
  lastPxWidth?: number;    // last layout width used to derive px
  rowHeights?: Record<rowIndex, number>;
  updatedAt: number;
}
- Store as plugin data (saveData). Migration handles changed line ranges and column count adjustments.

### Fingerprinting strategy
- fingerprint = `${maxCols}:${theadTexts.join('|')}`
- Use fingerprint-first matching when line ranges shift; reconcile when columns added/removed.

## Rendering and resizing logic
- On render: compute px widths = ratios[i] * containerWidth (respect min/max). Apply via <colgroup><col style="width: Xpx">.
- On drag: adjust adjacent columns (or distribute with modifiers), enforce minPx and optional snap step, renormalize to ratios on save.
- Double-click: auto-fit by measuring max content width in a column (temporarily remove constraints to read scrollWidth), clamp to min/max, optionally distribute leftover.
- Row resize (optional): apply min-height to <tr>/<td> via style; avoid fixed heights to preserve wrapping.

### Keyboard and modifiers
- Shift: distribute delta across all columns to the right of the handle.
- Alt: symmetric resize between left and right columns only.
- Ctrl/Cmd: temporarily bypass snap.

## Live Preview details (CM6)
- Prefer operating on the actual rendered <table> DOM within the editor (Live Preview renders Markdown tables into HTML).
- Use EditorView.dom to query tables in the current viewport; maintain an overlay layer for handles.
- Map back to TableKey by deriving section info (if exposed) or by syntax tree range; fall back to fingerprint.

## Reading view details
- Use ctx.getSectionInfo(el) to derive (lineStart, lineEnd) and sourcePath.
- Attach IntersectionObserver to activate resizers only when visible; use ResizeObserver to recompute widths on container size changes.

## Persistence modes
- Default: Plugin data only (non-invasive, vault-scoped, fast).
- Optional: “Materialize widths” to insert <colgroup> into the Markdown (user-invoked or on save) for portability outside Obsidian.

## Settings (initial)
- Enable/disable globally.
- Min column width (px), optional max width.
- Snap step (px), px vs % mode for UI display.
- Double-click action (autofit current/all/reset).
- Show row handles (on/off).
- Compatibility mode (modifier required for drag; known plugin defer lists).
- Import/export table presets.

## Performance considerations
- Only attach observers/handlers for visible tables (IntersectionObserver).
- Batch DOM writes (requestAnimationFrame); throttle pointermove handlers.
- Keep CSS footprint tiny and scoped to a root class (e.g., .otd-resize).

## Accessibility and i18n
- Large hit areas (6–10px) and visible focus states.
- ARIA labels and keyboard adjustments (arrow keys resize by step).
- RTL support by basing positions on bounding rects, not LTR assumptions.

## Edge cases
- Variable colspans: compute boundaries from actual columns per row; prefer max cells count row for boundaries.
- Very narrow columns: enforce minPx, prevent negative widths; respect content constraints.
- Long tables: avoid layout thrash; detach resizers when off-screen.
- Vault refactors: listen to rename/move to rekey stored entries.

## Testing plan (Vitest)
- Core math (resize distribution, normalization, snapping, min/max) in a pure module.
- Auto-fit measurement logic under JSDOM (mock layout where needed).
- DOM insertion tests: <colgroup> application idempotency, update paths.
- Smoke tests for PostProcessor and CM6 plugin lifecycle.

## Roadmap (phased)
1. MVP
   - Reading view column resizing (no row handles), persistence (ratios + lastPxWidth), basic settings.
2. Live Preview
   - CM6 integration with same interactions; viewport-aware attachment.
3. Autofit + keyboard
   - Double-click autofit; keyboard controls; snapping.
4. Row resizing (optional)
   - Min-height handles; persistence and settings toggle.
5. Materialization
   - Opt-in to write <colgroup> into Markdown; command palette action.

## Risks & mitigations
- Obsidian/CM6 DOM changes: keep selectors tolerant; feature-detect; gate by app version if needed.
- Theme interference: use <colgroup> over CSS width where possible; scope styles under a unique class.
- Conflicts with other table plugins: provide a modifier-required drag mode and allow users to defer.

## Open questions
- Should we support per-header presets (e.g., a column named “Notes” always starts at 40%)? Likely post-MVP.
- How to handle tables with mixed colspans gracefully for resizing affordances? MVP can limit handles to simple header rows.
- Do we need a per-note toggle to exclude certain tables from persistence? Possibly add an inline marker or settings override.

## Initial file layout (planned)
- main.ts — plugin entry; post-processor; settings wiring; persistence.
- cm6/tableResizeExtension.ts — Live Preview integration.
- core/resize.ts — pure math for width distribution and normalization.
- ui/SettingsRoot.tsx — settings tab (React/shadcn/Tailwind).
- styles.css — minimal, scoped styles for handles.
- tests/** — Vitest suites for core and integration smoke.

## Rationale recap
- <colgroup> keeps layout stable and efficient; ratios ensure responsive behavior as panes resize; plugin data avoids touching notes by default; CM6 + post-processor cover both primary views without duplicating heavy logic.
