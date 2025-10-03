import { ViewPlugin, EditorView } from '@codemirror/view';
import type TableDragPlugin from '../main';
import type { TableKey } from '../main';

export function tableResizeExtension(plugin: TableDragPlugin) {
  return ViewPlugin.fromClass(
    class {
      private view: EditorView;
      private mo: MutationObserver;
      private io: IntersectionObserver;
      private roPane: ResizeObserver;
      private observed = new Set<HTMLTableElement>();
      private active = new Set<HTMLTableElement>();

      constructor(view: EditorView) {
        this.view = view;
        // Initial scan + observer setup
        this.io = new IntersectionObserver((entries) => this.onIntersect(entries), {
          root: this.view.scrollDOM as any,
          rootMargin: '200px 0px 200px 0px',
          threshold: 0
        });
        this.scan();
        // Observe pane resize (sidebars, window resize, readable width toggle)
        this.roPane = new ResizeObserver(() => {
          this.active.forEach(t => plugin.scheduleBreakoutForTable(t));
        });
        this.roPane.observe(this.view.scrollDOM);
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
                  // Ensure it is observed for viewport control
                  if (!this.observed.has(t)) { this.observed.add(t); this.io.observe(t); }
                  const fp = plugin.computeFingerprint(t);
                  const key = { path, lineStart: -1, lineEnd: -1, fingerprint: fp } as TableKey;
                  // Immediate apply using pixel widths based on current container
                  t.classList.add('otd-managed');
                  plugin.applyStoredRatiosPx(t, key);
                  plugin.scheduleBreakoutForTable(t);
                  if (plugin.settings.enableDebugLogs) plugin['log']?.('lp-mutation-apply', { path, fp });
                }
              }
            }
          }
          if (touched) requestAnimationFrame(() => this.scan());
        });
        this.mo.observe(this.view.dom, { childList: true, subtree: true });
      }

      private onIntersect(entries: IntersectionObserverEntry[]) {
        const file = plugin.app.workspace.getActiveFile();
        const path = file?.path || '';
        if (!path) return;
        for (const entry of entries) {
          const table = entry.target as HTMLTableElement;
          if (entry.isIntersecting) {
            // Activate
            this.active.add(table);
            table.classList.remove('otd-inactive');
            const fp = plugin.computeFingerprint(table);
            const key: TableKey = { path, lineStart: -1, lineEnd: -1, fingerprint: fp };
            plugin.applyStoredRatiosPx(table, key);
            plugin.attachResizersWithKey(table, key);
            plugin.scheduleBreakoutForTable(table);
          } else {
            // Park (disable pointer events but keep DOM)
            this.active.delete(table);
            table.classList.add('otd-inactive');
          }
        }
        if (plugin.settings.enableDebugLogs) plugin['log']?.('lp-viewport', { active: this.active.size, observed: this.observed.size });
      }

      private scan() {
        const file = plugin.app.workspace.getActiveFile();
        const path = file?.path || '';
        if (!path) return; // not an active file

        const tables = Array.from(this.view.dom.querySelectorAll('table')) as HTMLTableElement[];
        const current = new Set<HTMLTableElement>(tables);
        // Observe new
        for (const t of current) {
          if (!this.observed.has(t)) { this.observed.add(t); this.io.observe(t); }
        }
        // Unobserve removed
        for (const t of Array.from(this.observed)) {
          if (!current.has(t)) { this.io.unobserve(t); this.observed.delete(t); this.active.delete(t); }
        }
      }

      destroy() {
        this.mo.disconnect();
        this.io.disconnect();
        this.roPane.disconnect();
        this.observed.clear();
        this.active.clear();
      }
    }
  );
}
