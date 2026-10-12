#!/usr/bin/env node
// Local stand-in for the OpenShift console "Raw" log endpoint, for trying the extension without a cluster.
//
//   node scripts/dev-server.mjs <file.log> [more.log ...] [--port 8080] [--grow] [--navigation-only]
//
// Each file is served (on 127.0.0.1 only) as text/plain at
//   http://127.0.0.1:<port>/api/kubernetes/api/v1/namespaces/demo/pods/<file-name>/log?container=app
// `sinceTime` is honoured like the Kubernetes API (by each line's timestamp). With --grow a new line is
// appended to every log every 2 seconds, to try Tail. --navigation-only answers everything except real
// page loads (Sec-Fetch-Mode: navigate) with 401, like OpenShift consoles that reject the viewer's fetch().
//
// The end-to-end tests use startDevServer() from this module directly.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOG_RE = /^\/api\/kubernetes\/api\/v1\/namespaces\/([^/]+)\/pods\/([^/]+)\/log$/;

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function lineTime(line, fallback) {
  try {
    const t = Date.parse(JSON.parse(line).timestamp);
    return Number.isNaN(t) ? fallback : t;
  } catch {
    return fallback;
  }
}

function splitLines(text) {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * @param {object} options
 * @param {Record<string, string>} options.logs   pod name → log text
 * @param {number} [options.port]                 0 picks a free port
 * @param {number} [options.growEveryMs]          append a generated line to every log on this interval
 * @param {boolean} [options.navigationOnly]      401 for everything except real page loads
 * @param {'network' | 'login-page'} [options.rejectFetch]  how requests other than page loads fail:
 *        'network' drops the connection (like a CORS / network error), 'login-page' answers with an HTML login page
 * @param {Record<string, {status?: number, headers?: Record<string, string>, body?: string}>} [options.routes]
 *        extra fixed responses by pathname (error pages, HTML instead of a log, …)
 */
export function startDevServer({ logs: input, port = 0, growEveryMs = 0, navigationOnly = false, rejectFetch, routes = {} }) {
  /** pod name → { lines, times } where times[i] approximates the kubelet write time of lines[i]. */
  const logs = new Map();
  const append = (pod, newLines) => {
    if (!logs.has(pod)) logs.set(pod, { lines: [], times: [] });
    const log = logs.get(pod);
    for (const line of newLines) {
      log.lines.push(line);
      log.times.push(lineTime(line, log.times.at(-1) ?? 0));
    }
  };
  for (const [pod, text] of Object.entries(input)) append(pod, splitLines(text));

  let n = 0;
  const timer = growEveryMs
    ? setInterval(() => {
        for (const pod of logs.keys()) {
          n++;
          const level = n % 9 === 0 ? 'ERROR' : n % 4 === 0 ? 'WARN' : 'INFO';
          append(pod, [JSON.stringify({
            timestamp: new Date().toISOString().replace('Z', '123456Z'), sequence: 100000 + n, loggerName: 'dev-server.tail', level,
            message: `Tail line ${n} for ${pod}`, threadName: 'tail', mdc: { traceId: 'feedc0ffee0000000000000000000000' },
          })]);
        }
      }, growEveryMs)
    : undefined;

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const fixed = routes[url.pathname];
    if (fixed) {
      res.writeHead(fixed.status ?? 200, { 'content-type': 'text/plain; charset=utf-8', ...fixed.headers });
      res.end(fixed.body ?? '');
      return;
    }
    const m = LOG_RE.exec(url.pathname);
    const navigation = req.headers['sec-fetch-mode'] === 'navigate';
    if (m && navigationOnly && !navigation) {
      res.writeHead(401, { 'content-length': '0' });
      res.end();
      return;
    }
    if (m && rejectFetch === 'network' && !navigation) {
      req.socket.destroy();
      return;
    }
    if (m && rejectFetch === 'login-page' && !navigation) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Log in</title><form>Log in to continue</form>');
      return;
    }
    if (m && logs.has(decodeURIComponent(m[2]))) {
      const { lines, times } = logs.get(decodeURIComponent(m[2]));
      const since = url.searchParams.get('sinceTime');
      const from = since ? Date.parse(since) : Number.NEGATIVE_INFINITY;
      const body = lines.filter((_, i) => times[i] >= from).join('\n');
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body ? `${body}\n` : '');
      return;
    }
    if (url.pathname === '/') {
      const links = [...logs.keys()]
        .map((pod) => {
          const href = `/api/kubernetes/api/v1/namespaces/demo/pods/${encodeURIComponent(pod)}/log?container=app`;
          return `<li><a href="${escapeHtml(href)}">${escapeHtml(pod)}</a> (${logs.get(pod).lines.length} lines)</li>`;
        })
        .join('');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>Raw log dev server</title><h1>Raw logs</h1><ul>${links}</ul>`);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  return new Promise((resolve) => {
    // Loopback only: the served logs are not reachable from other machines.
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        port: actual,
        /** Raw log URL of a pod. `localhost` (not 127.0.0.1) so it matches the extension's test host permission. */
        url: (pod, container = 'app') => `http://localhost:${actual}/api/kubernetes/api/v1/namespaces/demo/pods/${encodeURIComponent(pod)}/log?container=${encodeURIComponent(container)}`,
        append,
        lineCount: (pod) => logs.get(pod)?.lines.length ?? 0,
        close: () => {
          clearInterval(timer);
          server.closeAllConnections?.();
          return new Promise((done) => server.close(() => done()));
        },
      });
    });
  });
}

// CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const port = Number(args[args.indexOf('--port') + 1]) || 8080;
  const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--port');
  if (!files.length) {
    console.error('usage: node scripts/dev-server.mjs <file.log> [...] [--port 8080] [--grow] [--navigation-only]');
    process.exit(1);
  }
  const logs = Object.fromEntries(files.map((f) => [basename(f).replace(/\.(log|txt|json)$/, ''), readFileSync(f, 'utf8')]));
  const navigationOnly = args.includes('--navigation-only');
  const grow = args.includes('--grow');
  const srv = await startDevServer({ logs, port, growEveryMs: grow ? 2000 : 0, navigationOnly });
  console.log(`Raw log dev server on http://127.0.0.1:${srv.port}/${grow ? ' (growing)' : ''}${navigationOnly ? ' (navigation only)' : ''}`);
  for (const pod of Object.keys(logs)) console.log(`  ${srv.url(pod).replace('localhost', '127.0.0.1')}`);
}
