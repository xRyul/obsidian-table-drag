# Table Drag Plugin Refactoring Plan

## Overview
The main.ts file has been refactored from **1414 lines** into a modular, maintainable architecture.

## New Structure

```
src/
├── main.ts                          # Plugin entry point (~200 lines)
├── types.ts                         # ✅ Type definitions and interfaces
├── breakout/
│   └── BreakoutManager.ts          # Breakout/overflow logic
├── cm6/
│   └── tableResizeExtension.ts     # ✅ CodeMirror 6 extension
├── core/
│   └── resize.ts                   # ✅ Core resize logic
├── debug/
│   └── DebugManager.ts             # Debug logging and diagnostics
├── settings/
│   └── SettingsTab.ts              # ✅ Settings UI
├── storage/
│   └── StorageManager.ts           # ✅ Data persistence
├── table/
│   └── TableManager.ts             # Table operations and handle management
└── utils/
    ├── helpers.ts                  # ✅ Helper functions
    ├── layout.ts                   # ✅ Layout utilities
    └── materialize.ts              # HTML materialization
```

## Completed Modules

### ✅ types.ts (71 lines)
- TableKey, TableSizes, PluginData interfaces
- TableDragSettings, DEFAULT_SETTINGS
- Context Measurement

### ✅ utils/helpers.ts (45 lines)
- normalizeFingerprint()
- canonicalKeyString()
- normalizeRatios()
- getColWidths()
- roundToStep()
- measureAutofitWidth()

### ✅ utils/layout.ts (29 lines)
- layoutRowHandleWithRects()
- applyDeltaWithSnap()

### ✅ storage/StorageManager.ts (73 lines)
- loadDataStore(), saveDataStore()
- loadSettings(), saveSettings()
- findOrMigrateToCanonicalKey()
- onFileRename()

### ✅ settings/SettingsTab.ts (173 lines)
- Complete settings UI
- All plugin configuration options

## Remaining Modules to Create

### 1. breakout/BreakoutManager.ts (~350 lines)
**Responsibilities:**
- Measure context (CM6 vs Reading view)
- Manage breakout wrappers
- Schedule and update breakout layout
- Handle wide tables that exceed line width

**Key Methods:**
- `measureContextForEl()`
- `getBreakoutContainer()`
- `ensureBreakoutWrapper()`
- `removeBreakoutWrapper()`
- `cleanupLegacyBreakout()`
- `scheduleBreakoutForTable()`
- `updateBreakoutForTable()`

**State:**
- `breakoutRAF: WeakMap<HTMLTableElement, number>`
- `breakoutRetryCount: WeakMap<HTMLTableElement, number>`
- `outerDragActive: WeakSet<HTMLTableElement>`

### 2. debug/DebugManager.ts (~150 lines)
**Responsibilities:**
- Debug logging with buffer management
- Table diagnostic snapshots
- Copy/clear debug logs
- Visible table metrics

**Key Methods:**
- `log(event, details)`
- `snapshotTableDebug(table)`
- `copyDebugLog()`
- `clearDebugLog()`
- `copyVisibleTableMetrics()`

**State:**
- `debugBuffer: Array<{ts, event, details}>`

### 3. table/TableManager.ts (~600 lines)
**Responsibilities:**
- Attach resizers and handles
- Column and row resize logic
- Apply stored widths
- Colgroup management
- Handle positioning and interactions

**Key Methods:**
- `attachResizersWithKey()`
- `ensureColgroup()`
- `applyColWidths()`
- `applyRatiosAsPercent()`
- `applyStoredRatiosPercent()`
- `applyStoredRatiosPx()`
- `computeFingerprint()`
- `processReadingTables()`

### 4. utils/materialize.ts (~50 lines)
**Responsibilities:**
- Build materialized HTML with embedded widths
- Insert/copy table HTML

**Key Methods:**
- `buildMaterializedHtml()`
- `materializeInsertHtmlCopy()`
- `materializeCopyToClipboard()`

### 5. main.ts (Refactored, ~200 lines)
**Responsibilities:**
- Plugin initialization
- Manager orchestration
- Command registration
- Event handling

**Dependencies:**
- StorageManager
- BreakoutManager  
- DebugManager
- TableManager
- SettingsTab

## Benefits of Refactoring

1. **Maintainability**: Each module has a single, clear responsibility
2. **Testability**: Modules can be tested in isolation
3. **Readability**: Smaller, focused files are easier to understand
4. **Reusability**: Utilities can be imported where needed
5. **Collaboration**: Multiple developers can work on different modules
6. **Debugging**: Issues are easier to isolate and fix

## Migration Notes

- All existing functionality is preserved
- No breaking changes to public API
- Data storage format remains unchanged
- Settings are backward compatible

## Next Steps

1. Create remaining manager classes
2. Update main.ts to use managers
3. Update cm6/tableResizeExtension.ts imports
4. Test all functionality
5. Remove old code from main.ts
