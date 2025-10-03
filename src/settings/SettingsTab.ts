import { App, PluginSettingTab, Setting } from 'obsidian';
import type TableDragPlugin from '../main';

export class TableDragSettingTab extends PluginSettingTab {
  plugin: TableDragPlugin;

  constructor(app: App, plugin: TableDragPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Obsidian Table Drag' });

    new Setting(containerEl)
      .setName('Minimum column width (px)')
      .setDesc('Columns will not shrink below this width')
      .addText((t) => t.setPlaceholder('60').setValue(String(this.plugin.storage.settings.minColumnWidthPx)).onChange(async (v) => {
        const n = parseInt(v, 10);
        if (!Number.isNaN(n) && n > 0) {
          this.plugin.storage.settings.minColumnWidthPx = n;
          await this.plugin.storage.saveSettings();
        }
      }));

    new Setting(containerEl)
      .setName('Snap step (px)')
      .setDesc('Widths snap to this increment during drag. Hold Ctrl/Cmd to bypass.')
      .addText((t) => t.setPlaceholder('8').setValue(String(this.plugin.storage.settings.snapStepPx)).onChange(async (v) => {
        const n = parseInt(v, 10);
        if (!Number.isNaN(n) && n > 0) {
          this.plugin.storage.settings.snapStepPx = n;
          await this.plugin.storage.saveSettings();
        }
      }));

    new Setting(containerEl)
      .setName('Keyboard step (px)')
      .setDesc('Arrow keys resize by this many pixels (Ctrl/Cmd = 1px).')
      .addText((t) => t.setPlaceholder('8').setValue(String(this.plugin.storage.settings.keyboardStepPx)).onChange(async (v) => {
        const n = parseInt(v, 10);
        if (!Number.isNaN(n) && n > 0) {
          this.plugin.storage.settings.keyboardStepPx = n;
          await this.plugin.storage.saveSettings();
        }
      }));

    // Row resizing
    containerEl.createEl('h3', { text: 'Row resizing' });
    new Setting(containerEl)
      .setName('Enable row resizing')
      .setDesc('Show horizontal handles to adjust row heights')
      .addToggle((t) => t.setValue(this.plugin.storage.settings.enableRowResize).onChange(async (v) => {
        this.plugin.storage.settings.enableRowResize = v;
        await this.plugin.storage.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Row minimum height (px)')
      .setDesc('Rows will not be resized below this height')
      .addText((t) => t.setPlaceholder('24').setValue(String(this.plugin.storage.settings.rowMinHeightPx)).onChange(async (v) => {
        const n = parseInt(v, 10);
        if (!Number.isNaN(n) && n > 0) {
          this.plugin.storage.settings.rowMinHeightPx = n;
          await this.plugin.storage.saveSettings();
        }
      }));

    new Setting(containerEl)
      .setName('Row keyboard step (px)')
      .setDesc('ArrowUp/ArrowDown resize rows by this many pixels (Ctrl/Cmd = 1px).')
      .addText((t) => t.setPlaceholder('4').setValue(String(this.plugin.storage.settings.rowKeyboardStepPx)).onChange(async (v) => {
        const n = parseInt(v, 10);
        if (!Number.isNaN(n) && n > 0) {
          this.plugin.storage.settings.rowKeyboardStepPx = n;
          await this.plugin.storage.saveSettings();
        }
      }));

    // Outer width handle
    containerEl.createEl('h3', { text: 'Outer width handle' });
    new Setting(containerEl)
      .setName('Show outer width handle')
      .setDesc('Displays a grab handle outside the right edge to grow/shrink table width beyond readable line length')
      .addToggle((t) => t.setValue(this.plugin.storage.settings.showOuterWidthHandle).onChange(async (v) => {
        this.plugin.storage.settings.showOuterWidthHandle = v;
        await this.plugin.storage.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Outer handle mode')
      .setDesc('edge = split growth between first and last columns; scale = scale all columns')
      .addDropdown((d) => d.addOptions({ edge: 'Edge columns', scale: 'Scale all' }).setValue(this.plugin.storage.settings.outerHandleMode).onChange(async (v) => {
        this.plugin.storage.settings.outerHandleMode = v as any;
        await this.plugin.storage.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Outer max width (px, 0 = unlimited)')
      .setDesc('Caps how wide a table can grow when dragging the outer handle')
      .addText((t) => t.setPlaceholder('0').setValue(String(this.plugin.storage.settings.outerMaxWidthPx)).onChange(async (v) => {
        const n = parseInt(v, 10);
        if (!Number.isNaN(n) && n >= 0) {
          this.plugin.storage.settings.outerMaxWidthPx = n;
          await this.plugin.storage.saveSettings();
        }
      }));

    new Setting(containerEl)
      .setName('Double-click action')
      .setDesc('Action when double-clicking a handle (or pressing Enter/Space)')
      .addDropdown((d) => {
        d.addOptions({ 'autofit': 'Autofit', 'reset': 'Reset', 'none': 'None' })
          .setValue(this.plugin.storage.settings.doubleClickAction)
          .onChange(async (v) => {
            this.plugin.storage.settings.doubleClickAction = v as any;
            await this.plugin.storage.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('Wrap long text in cells')
      .setDesc('Allows long URLs and text to wrap when columns are narrow; increases row height as needed.')
      .addToggle((t) => t.setValue(this.plugin.storage.settings.wrapLongText).onChange(async (v) => {
        this.plugin.storage.settings.wrapLongText = v;
        await this.plugin.storage.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Require Alt key to drag')
      .setDesc('If enabled, hold Alt while dragging to resize (reduces conflicts)')
      .addToggle((t) => t.setValue(this.plugin.storage.settings.requireAltToDrag).onChange(async (v) => {
        this.plugin.storage.settings.requireAltToDrag = v;
        await this.plugin.storage.saveSettings();
      }));

    // Diagnostics
    containerEl.createEl('h3', { text: 'Diagnostics' });
    new Setting(containerEl)
      .setName('Enable debug logs')
      .setDesc('When enabled, the plugin collects a detailed log to help troubleshoot issues.')
      .addToggle((t) => t.setValue(this.plugin.storage.settings.enableDebugLogs).onChange(async (v) => {
        this.plugin.storage.settings.enableDebugLogs = v;
        await this.plugin.storage.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Verbose details')
      .setDesc('Include detailed arrays (ratios/widths) in the log')
      .addToggle((t) => t.setValue(this.plugin.storage.settings.debugVerbose).onChange(async (v) => {
        this.plugin.storage.settings.debugVerbose = v;
        await this.plugin.storage.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Debug buffer size')
      .setDesc('Maximum number of log entries to keep in memory')
      .addText((t) => t.setPlaceholder('500').setValue(String(this.plugin.storage.settings.debugBufferSize)).onChange(async (v) => {
        const n = parseInt(v, 10);
        if (!Number.isNaN(n) && n > 50) {
          this.plugin.storage.settings.debugBufferSize = n;
          await this.plugin.storage.saveSettings();
        }
      }));

    new Setting(containerEl)
      .addButton((b) => b.setButtonText('Copy debug log').onClick(() => 
        this.plugin.debug.copyDebugLog(
          (t) => this.plugin.table.computeFingerprint(t),
          this.plugin.storage.dataStore.version
        )
      ))
      .addButton((b) => b.setButtonText('Clear debug log').setWarning().onClick(() => this.plugin.debug.clearDebugLog()));
  }
}
