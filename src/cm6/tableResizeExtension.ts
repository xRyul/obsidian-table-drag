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
        this.mo = new MutationObserver((muts) => {
          const file = plugin.app.workspace.getActiveFile();
          const path = file?.path || '';
          let touched = false;
          const applied = new Set<HTMLTableElement>();
          for (const m of muts) {
            const nodes = [...Array.from(m.addedNodes), m.target as any] as Element[];
            for (const n of nodes) {
              if (!n || !(n instanceof Element)) continue;
              const tables = n.matches('table') ? [n as HTMLTableElement] : Array.from(n.querySelectorAll?.('table') || []) as HTMLTableElement[];
              if (tables.length) {
                touched = true;
                for (const t of tables) {
                  if (applied.has(t)) continue; applied.add(t);
                  const fp = plugin.computeFingerprint(t);
                  const key = { path, lineStart: -1, lineEnd: -1, fingerprint: fp } as TableKey;
                  // Immediate apply using pixel widths based on current container
                  t.classList.add('otd-managed');
                  plugin.applyStoredRatiosPx(t, key);
                  if (plugin.settings.enableDebugLogs) plugin['log']?.('lp-mutation-apply', { path, fp });
                }
              }
            }
          }
          if (touched) requestAnimationFrame(() => this.scan());
        });
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
