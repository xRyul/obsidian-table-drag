import { ViewPlugin, EditorView } from '@codemirror/view';
import type TableDragPlugin from '../main';
import type { TableKey } from '../main';

export function tableResizeExtension(plugin: TableDragPlugin) {
  return ViewPlugin.fromClass(
    class {
      private view: EditorView;
      private mo: MutationObserver;

      constructor(view: EditorView) {
        this.view = view;
        // Initial scan
        this.scan();
        // Observe DOM changes in Live Preview to rescan when tables render/update
        this.mo = new MutationObserver(() => this.scan());
        this.mo.observe(this.view.dom, { childList: true, subtree: true });
      }

      private scan() {
        // Use active file path as key path (line ranges unknown in LP)
        const file = plugin.app.workspace.getActiveFile();
        const path = file?.path || '';
        if (!path) return; // not an active file

        const tables = Array.from(this.view.dom.querySelectorAll('table')) as HTMLTableElement[];
        let index = 0;
        for (const table of tables) {
          const fingerprint = plugin.computeFingerprint(table);
          const key: TableKey = { path, lineStart: -1, lineEnd: -1, fingerprint };
          plugin.attachResizersWithKey(table, key);
          index++;
        }
      }

      destroy() {
        this.mo.disconnect();
      }
    }
  );
}
