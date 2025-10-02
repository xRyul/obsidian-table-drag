/* eslint-disable no-console */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'src', 'main.ts');
const OUTFILE = path.join(ROOT, 'main.js');
const MANIFEST = path.join(ROOT, 'manifest.json');
const STYLES = path.join(ROOT, 'styles.css');

// Destination in testing vault (Windows path)
const PLUGIN_DEST = "C:\\Users\\daniel\\Developer\\Obsidian Plugins\\Plugin-Testing-Vault\\.obsidian\\plugins\\obsidian-table-drag";

const args = process.argv.slice(2);
const watch = args.includes('--watch');

async function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyToVault() {
  ensureDir(PLUGIN_DEST);
  // Overwrite core plugin files; keep data.json intact if present
  for (const file of [MANIFEST, STYLES, OUTFILE]) {
    const dest = path.join(PLUGIN_DEST, path.basename(file));
    try {
      fs.copyFileSync(file, dest);
      console.log(`Copied ${path.basename(file)} -> ${dest}`);
    } catch (e) {
      console.error(`Failed to copy ${file}:`, e);
      process.exitCode = 1;
    }
  }
}

async function buildOnce() {
  console.log('Building with esbuild...');
  await esbuild.build({
    entryPoints: [ENTRY],
    bundle: true,
    minify: true,
    sourcemap: false,
    outfile: OUTFILE,
    platform: 'browser',
    format: 'cjs',
    target: ['es2018'],
    external: [
      'obsidian',
      'electron',
      'fs',
      'path',
      'os',
      'stream',
      'util',
      '@codemirror/*'
    ]
  });
  console.log('Build complete.');
  copyToVault();
}

if (watch) {
  (async () => {
    const ctx = await esbuild.context({
      entryPoints: [ENTRY],
      bundle: true,
      minify: false,
      sourcemap: true,
      outfile: OUTFILE,
      platform: 'browser',
      format: 'cjs',
      target: ['es2018'],
      external: [
        'obsidian', 'electron', 'fs', 'path', 'os', 'stream', 'util', '@codemirror/*'
      ]
    });
    await ctx.watch();
    console.log('Watching for changes...');
    // Initial copy to vault on start
    copyToVault();
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  buildOnce().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
