#!/usr/bin/env node
// Builds the extension into dist/ (load it with chrome://extensions → Load unpacked)
// plus dist/standalone/logpane.html, a single file with everything inlined.
//   node build.mjs           build once
//   node build.mjs --watch   rebuild on change
//   node build.mjs --zip     build and pack dist/ into logpane-extension.zip
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const args = new Set(process.argv.slice(2));

const common = {
  bundle: true,
  target: 'chrome116',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  legalComments: 'none',
  logLevel: 'info',
  // Unminified on purpose: easy to review before installing on a work machine.
  minify: false,
};

const builds = [
  { entryPoints: [join(root, 'src/entries/content.ts')], outfile: join(dist, 'content.js'), format: 'iife' },
  { entryPoints: [join(root, 'src/entries/standalone.ts')], outfile: join(dist, 'viewer.js'), format: 'iife' },
  { entryPoints: [join(root, 'src/entries/options.ts')], outfile: join(dist, 'options.js'), format: 'iife' },
  { entryPoints: [join(root, 'src/entries/background.ts')], outfile: join(dist, 'background.js'), format: 'esm' },
];

function copyStatic() {
  cpSync(join(root, 'static'), dist, { recursive: true });
  cpSync(join(root, 'src/ui/viewer.css'), join(dist, 'viewer.css'));
}

/** viewer.html with CSS and JS inlined, for sharing or when extensions are blocked. */
function writeStandalone() {
  const css = readFileSync(join(dist, 'viewer.css'), 'utf8');
  const js = readFileSync(join(dist, 'viewer.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
  const html = readFileSync(join(root, 'static/viewer.html'), 'utf8')
    .replace('<link rel="stylesheet" href="viewer.css" />', () => `<style>\n${css}\n</style>`)
    .replace('<script src="viewer.js"></script>', () => `<script>\n${js}\n</script>`);
  mkdirSync(join(dist, 'standalone'), { recursive: true });
  writeFileSync(join(dist, 'standalone', 'logpane.html'), html);
}

const afterBuild = {
  name: 'after-build',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return;
      copyStatic();
      if (build.initialOptions.outfile?.endsWith('viewer.js')) writeStandalone();
    });
  },
};

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
copyStatic();

if (args.has('--watch')) {
  for (const b of builds) await (await esbuild.context({ ...common, ...b, plugins: [afterBuild] })).watch();
  console.log('watching for changes…');
} else {
  await Promise.all(builds.map((b) => esbuild.build({ ...common, ...b, plugins: [afterBuild] })));
  if (args.has('--zip')) {
    const zip = join(root, 'logpane-extension.zip');
    rmSync(zip, { force: true });
    execFileSync('zip', ['-qr', zip, '.', '-x', 'standalone/*'], { cwd: dist });
    console.log(`packed ${zip}`);
  }
}
