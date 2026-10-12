#!/usr/bin/env node
// Local stand-in for the OpenShift console "Raw" log endpoint, for trying the extension without a cluster.
//
//   node scripts/dev-server.mjs <file.log> [more.log ...] [--port 8080] [--grow]
//
// Each file is served as text/plain at
//   http://localhost:<port>/api/kubernetes/api/v1/namespaces/demo/pods/<file-name>/log?container=app
// `sinceTime` is honoured like the Kubernetes API (by each line's timestamp). With --grow a new line is
// appended to every log every 2 seconds, to try Tail.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename } from 'node:path';

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]) || 8080;
const grow = args.includes('--grow');
const files = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--port');
if (!files.length) {
  console.error('usage: node scripts/dev-server.mjs <file.log> [...] [--port 8080] [--grow]');
  process.exit(1);
}

const lineTime = (line) => {
  try {
    const t = Date.parse(JSON.parse(line).timestamp);
    return Number.isNaN(t) ? null : t;
  } catch {
    return null;
  }
};

/** pod name → { lines, times } where times[i] approximates the kubelet write time of lines[i]. */
const logs = new Map();
for (const file of files) {
  const pod = basename(file).replace(/\.(log|txt|json)$/, '');
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const times = [];
  let last = 0;
  for (const l of lines) times.push((last = lineTime(l) ?? last));
  logs.set(pod, { lines, times });
}

if (grow) {
  let n = 0;
  setInterval(() => {
    for (const [pod, log] of logs) {
      n++;
      const now = new Date();
      const level = n % 9 === 0 ? 'ERROR' : n % 4 === 0 ? 'WARN' : 'INFO';
      log.lines.push(JSON.stringify({
        timestamp: now.toISOString().replace('Z', '123456Z'), sequence: 100000 + n, loggerName: 'dev-server.tail', level,
        message: `Tail line ${n} for ${pod}`, threadName: 'tail', mdc: { traceId: 'feedc0ffee0000000000000000000000' },
      }));
      log.times.push(now.getTime());
    }
  }, 2000);
}

const LOG_RE = /^\/api\/kubernetes\/api\/v1\/namespaces\/([^/]+)\/pods\/([^/]+)\/log$/;

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const m = LOG_RE.exec(url.pathname);
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
        return `<li><a href="${href}">${pod}</a> (${logs.get(pod).lines.length} lines)</li>`;
      })
      .join('');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>Raw log dev server</title><h1>Raw logs</h1><ul>${links}</ul>`);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}).listen(port, () => {
  console.log(`Raw log dev server on http://localhost:${port}/${grow ? ' (growing)' : ''}`);
  for (const pod of logs.keys()) console.log(`  http://localhost:${port}/api/kubernetes/api/v1/namespaces/demo/pods/${encodeURIComponent(pod)}/log?container=app`);
});
