---
title: Implementation Guidelines & Antipatterns
type: note
permalink: docs/implementation-guidelines-antipatterns
---

# Implementation Guidelines & Antipatterns

Date: 2025-10-02

## Approach Validation
Our planned approach (MarkdownPostProcessor + CM6 ViewPlugin + <colgroup> + ratio persistence) is **correct and idiomatic** for Obsidian plugins.

## Key Validation Points (Early Testing)
- **Live Preview DOM stability**: Verify Obsidian's table markup consistency across versions
- **Theme interaction**: Ensure <colgroup> widths aren't overridden by theme CSS (max-width, overflow-x, table-layout)
- **Colspans**: MVP stance - only show handles for simple header rows, degrade gracefully
- **Multi-pane behavior**: Width changes in one pane should propagate to other panes quickly

## Critical Antipatterns to Avoid

### Data Model & Persistence
❌ **Storing only absolute px** - Makes layouts brittle
✅ Keep ratios as source of truth; px are derived and ephemeral

❌ **Overfitting the key** - lineStart/lineEnd breaks with edits
✅ Use fingerprint-first (header text + col count), then reconcile

❌ **Silent Markdown mutation** - Writing <colgroup> on every drag surprises users
✅ Keep file changes opt-in and explicit

### DOM Integration
❌ **Non-idempotent injection** - Re-inserting multiple <colgroup> or handle containers
✅ Always check for existing, namespaced elements and update in place

❌ **Global CSS leakage** - Unscoped styles affecting all tables
✅ Namespace everything (e.g., .otd-resize) and favor <colgroup> over CSS widths

❌ **Heavy MutationObservers** - Observing whole document subtree
✅ Observe per-table containers and disconnect promptly on unmount

### Performance & Layout
❌ **Layout thrash on drag** - Measuring and writing in same tick
✅ Separate reads/writes, batch writes in requestAnimationFrame, throttle pointermove

❌ **Measuring on every move** - Auto-fit calculations during drag
✅ Auto-fit on double-click or drag-end only

❌ **Per-table overlays for large docs** - Too many positioned layers
✅ Single overlay per editor with handle elements for all visible tables

### CM6 Specifics
❌ **Scanning entire editor DOM on every update**
✅ Use viewport signals (visible ranges/IntersectionObserver) to limit work

❌ **Not cleaning up on view destroy** - Leaking observers/handlers
✅ Ensure deterministic teardown in plugin unload and CM6 plugin destroy

❌ **Fighting selection** - Pointer drags that also select text
✅ Use PointerEvents with setPointerCapture and preventDefault on handles

### UX & Accessibility
❌ **Tiny hit targets** - Hard to grab, especially high DPI/touch
✅ Use ≥6–10px targets and visible focus states

❌ **Hidden keyboard path** - No keyboard access
✅ Focusable resizers with arrow keys + step increments, ARIA labels

❌ **Surprise behavior** - Modifier-less drags conflicting with other plugins
✅ Provide option to require Alt/Shift for resize

### Testing & Tooling
❌ **Over-reliance on JSDOM for layout** - JSDOM can't give true layout metrics
✅ Keep "math" pure and unit-tested; DOM measurement as integration smoke tests

❌ **Bundling bloat** - Shipping Tailwind runtime or all of React to content
✅ Compile settings UI and tree-shake; keep runtime code small

## Recommended Patterns

### Data Handling
- **Ratios as integers**: Store as fixed-point (thousandths) to avoid floating drift
- **Idempotent DOM updates**: Tag injected nodes with data-otd and reuse
- **Single overlay per editor**: One positioned container on view.scrollDOM

### Performance
- **Observers that scale**: IntersectionObserver for visible tables; ResizeObserver per table
- **Min-content guard**: Accept content's min width, adjust neighbors accordingly
- **Multi-pane sync**: Schedule "refresh" for other visible instances after persisting

### Conflict Mitigation
- **Modifier requirements**: Option for Alt-required drags
- **Plugin detection**: Bail if known conflicting plugin/table class detected

## Obsidian-Specific Gotchas

### Section Info
- `ctx.getSectionInfo()` may return null for nested nodes
- Use block container when necessary, fall back to fingerprint

### Duplicate Processing
- Markdown post-processors can re-run
- Code must be idempotent and cheap to re-enter

### Table Layout Interference
- Some themes force `table-layout: fixed` or width constraints
- Test with/without fixed layout
- Prefer <colgroup> widths over hard-coded CSS

## Implementation Priority
1. **Idempotent <colgroup> injection**
2. **Single overlay per editor**
3. **Pure ratio math module**
4. **Proper observer lifecycle**
5. **Basic settings with conflict mitigation**

## Status
✅ Approach validated as correct and idiomatic
⚠️ Focus on antipatterns during implementation
🎯 Ready to scaffold MVP with guardrails


---
Update (2025-10-02)
- Implemented full-height column handles (stretched to table height) to avoid the "first row only" affordance confusion.
- Added ResizeObserver to keep handle layout in sync when table size changes.
- Live Preview support added (CM6 ViewPlugin + MutationObserver).
- Known limitations kept: no row resizing yet; LP keying uses index suffix — improve in Phase 2 hardening.
