# Obsidian Table Drag

Drag-to-resize Markdown table columns (and optional rows) in Obsidian.

Status: MVP (Reading view column resizing + persistence)

## Development

1. Install deps
   - npm install

2. Build once
   - npm run build
   - Output: main.js at project root
   - Also copies manifest.json, styles.css, and main.js to your testing vault plugin folder:
     C:\\Users\\daniel\\Developer\\Obsidian Plugins\\Plugin-Testing-Vault\\.obsidian\\plugins\\obsidian-table-drag

3. Watch mode
   - npm run dev

4. Enable in Obsidian
   - Open your testing vault and enable the plugin "Obsidian Table Drag" in Settings → Community Plugins.

## Keyboard usage
- Focus a handle by clicking it, or press Tab until the handle highlights.
- ArrowLeft/ArrowRight: resize by the configured Keyboard step (default 8px). Hold Ctrl/Cmd for 1px precision.
- Enter/Space: triggers the Double-click action (default: Autofit). If set to Reset, splits the two adjacent columns evenly.

## Notes
- This MVP focuses on Reading view; Live Preview support will follow.
- Widths persist per table using plugin data (ratios + last container width).
