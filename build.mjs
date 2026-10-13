#!/usr/bin/env node
// Builds the extension into dist/ (load it with chrome://extensions → Load unpacked)
// plus dist/standalone/logpane.html, a single file with everything inlined.
//   node build.mjs           build once
//   node build.mjs --watch   rebuild on change
//   node build.mjs --zip     build and pack dist/ into logpane-extension.zip
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const args = new Set(process.argv.slice(2));

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

/** Licenses of the runtime dependencies bundled into the extension (MIT requires shipping their notices). */
function thirdPartyNotices() {
  const parts = Object.keys(pkg.dependencies ?? {}).map((name) => {
    const dir = join(root, 'node_modules', name);
    const { version, license } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return `${name} ${version} (${license})\n${'-'.repeat(60)}\n${readFileSync(join(dir, 'LICENSE'), 'utf8').trim()}`;
  });
  return `LogPane bundles the following third-party software.\n\n${parts.join('\n\n')}\n`;
}

const banner = `/*! LogPane ${pkg.version} | MIT License | Includes Preact (MIT, Copyright (c) 2015-present Jason Miller). Full texts: LICENSE, THIRD_PARTY_LICENSES.txt */`;

const common = {
  bundle: true,
  banner: { js: banner },
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
  // skip OS clutter such as Finder's .DS_Store
  cpSync(join(root, 'static'), dist, { recursive: true, filter: (src) => !/(^|[\\/])(\.DS_Store|Thumbs\.db)$/.test(src) });
  // package.json is the single source of the version (bump it with `npm version`).
  const manifest = JSON.parse(readFileSync(join(root, 'static/manifest.json'), 'utf8'));
  writeFileSync(join(dist, 'manifest.json'), `${JSON.stringify({ ...manifest, version: pkg.version }, null, 2)}\n`);
  cpSync(join(root, 'src/ui/viewer.css'), join(dist, 'viewer.css'));
  cpSync(join(root, 'LICENSE'), join(dist, 'LICENSE'));
  writeFileSync(join(dist, 'THIRD_PARTY_LICENSES.txt'), thirdPartyNotices());
}

/** viewer.html with CSS and JS inlined, for sharing or when extensions are blocked. */
function writeStandalone() {
  const css = readFileSync(join(dist, 'viewer.css'), 'utf8').replace(/<\/style/gi, '<\\/style');
  const js = readFileSync(join(dist, 'viewer.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
  const notices = `LogPane ${pkg.version}\n\n${readFileSync(join(root, 'LICENSE'), 'utf8').trim()}\n\n${thirdPartyNotices()}`.replace(/--/g, '- -');
  const style = `\n${css}\n`;
  const script = `\n${js}\n`;
  // Only exactly this script and style may run: no 'unsafe-inline', so injected markup could never execute.
  const sha = (text) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
  const csp = `default-src 'none'; script-src ${sha(script)}; style-src ${sha(style)}; img-src 'self'; base-uri 'none'; form-action 'none'`;
  const template = readFileSync(join(root, 'static/viewer.html'), 'utf8');
  const metaCsp = /(<meta http-equiv="Content-Security-Policy" content=")[^"]*(")/;
  if (!metaCsp.test(template)) throw new Error('static/viewer.html: Content-Security-Policy meta tag not found');
  const html = template
    .replace('<!doctype html>', () => `<!doctype html>\n<!--\n${notices}-->`)
    .replace(metaCsp, (_, open, close) => `${open}${csp}${close}`)
    .replace('<link rel="stylesheet" href="viewer.css" />', () => `<style>${style}</style>`)
    .replace('<script src="viewer.js"></script>', () => `<script>${script}</script>`);
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
    execFileSync('zip', ['-qr', zip, '.', '-x', 'standalone/*', '*.DS_Store'], { cwd: dist });
    console.log(`packed ${zip}`);
  }
}
