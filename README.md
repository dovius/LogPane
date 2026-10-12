# LogPane – JSON & NDJSON Log Viewer

**Structured logs, without the noise.**

LogPane is a Chrome / Edge extension that turns raw JSON and NDJSON logs into a clean, searchable,
easy-to-read interface, directly in your browser. Open it on a log page (for example the Kubernetes /
OpenShift console's **Raw** pod log), drop in a downloaded `.log` file, or paste log text.

![LogPane showing an error with its stack trace](store/screenshot-1-stack-trace.png)

## Privacy first

- **100% local processing.** Logs are parsed in the browser tab and never sent anywhere. There is no backend.
- **Minimal permissions.** LogPane uses `activeTab`: it only sees a page when you click its button. Access to a domain is requested only if you enable automatic opening there.
- **No persistent log storage.** Logs live in memory while the tab is open. Only UI settings are saved.
- **No tracking.** No analytics, no telemetry SDKs, no accounts.
- **Enforced by the browser, not just promised.** Extension pages run with `connect-src 'none'`, and the standalone file with `default-src 'none'`, so they cannot make network requests at all.

Details: [PRIVACY.md](PRIVACY.md).

## Features

- **Readable list**: time, level, logger, message, plus optional thread and source columns. Level-coloured rows. Virtualised, so 50,000+ lines scroll smoothly.
- **Search**: terms are ANDed, `"exact phrase"`, `-exclude`. Regex and case-sensitive toggles are available. Search covers messages, MDC / structured fields, and exception types and messages.
- **Filters**: severity chips (click shows only that level, Ctrl/⌘/Shift-click toggles), logger picker, and from/to time.
- **Related events**: click a trace ID, correlation ID or request ID to see every entry of that request.
- **Details panel**: all fields, JSON inside messages pretty-printed, and the raw JSON.
- **Stack traces**: structured exceptions (Quarkus `frames` / `causedBy` / `suppressed`) are shown as normal Java stack traces you can paste into the IDE. Framework frames are dimmed.
- **Several logs at once**: add files or Raw URLs, merged by timestamp, so you can follow one trace across services.
- **Reload and live tail** for Kubernetes / OpenShift pod logs (uses `sinceTime`, pauses in background tabs).
- **Copy / export**: an entry, its JSON, its stack trace, ±N lines of context, or everything currently shown.
- **Display options**: dark and light themes (follow the system), UTC or local time, adjustable font size.
- **Keyboard**:

  | Key | Action |
  | --- | --- |
  | `/` | search |
  | `↑` `↓` or `j` `k` | move |
  | `n` / `N` | next / previous error |
  | `w` / `W` | next / previous warning |
  | `g` / `G` | top / bottom |
  | `c` | copy entry |
  | `Esc` | close / clear |

### Supported formats

| Format | Notes |
| --- | --- |
| Quarkus / JBoss JSON logging | Structured exceptions, MDC |
| logstash-logback-encoder | Common for Spring Boot / Logback |
| Elastic ECS | |
| GELF | Spring Boot structured logging |
| pino, bunyan, winston | Node.js |
| Docker `json-file` | The inner JSON line is unwrapped |
| `<timestamp> {json}` | e.g. `kubectl logs --timestamps` |

Plain-text and broken lines are kept as-is, and Java stack-trace continuation lines are grouped with
their entry. Timestamps keep full nanosecond precision for ordering.

## Using it

- **On a log page**: click the LogPane toolbar button on any plain-text log page. Click again, or use **Raw**, to switch back to the original text.
- **Open automatically**: View ▾ → “Open automatically on this domain…”, or the extension options. Add e.g. `https://console-openshift-console.apps.<cluster>`. From then on, Raw pod-log pages on that domain open in LogPane automatically.
- **Local files**: click the toolbar button on any other page, then drop `.log` / `.json` / `.ndjson` files or paste text.
- **Without installing anything**: `dist/standalone/logpane.html` is one self-contained HTML file. Open it from disk and drop a log on it. This works where extensions are blocked by policy.

## Install from source

Requires Node 20+.

```sh
npm ci
npm run build      # → dist/  (unpacked extension) and dist/standalone/logpane.html
```

Then go to `chrome://extensions` (Edge: `edge://extensions`), enable **Developer mode**, click
**Load unpacked**, and select `dist/`.

## Development

```sh
npm run watch                  # rebuild on change
npm test                       # unit tests (vitest)
npm run typecheck
npm run zip                    # → logpane-extension.zip for the Chrome Web Store
node scripts/dev-server.mjs some.log [more.log] [--port 8080] [--grow]
```

The dev server serves files like the Kubernetes Raw log endpoint, at
`http://localhost:8080/api/kubernetes/api/v1/namespaces/demo/pods/<file-name>/log`. It supports
`sinceTime`, and `--grow` keeps appending lines so you can try Tail.

Test and demo data are fictional:
- `node scripts/make-fixtures.mjs` regenerates the test fixtures, and `--big 50000 <out>` creates a large file.
- `node scripts/make-demo.mjs <dir>` creates two services sharing trace IDs.
- To check a real log without committing it: `LV_REAL_LOG=/path/to/pod.log npm test`.

The bundles are intentionally not minified, so they are easy to review.

```
src/core/     parsing, field aliases, time, filters, merge, stack traces, tail (pure TS, unit-tested)
src/ui/       Preact UI, store, CSS
src/entries/  content script, background service worker, options page, standalone page
static/       manifest, HTML pages, icons
store/        Chrome Web Store texts and graphics
scripts/      dev server, fixture / demo / icon generators
```

## License

[MIT](LICENSE). Bundled third-party code: Preact (MIT), see `THIRD_PARTY_LICENSES.txt` in the build.

## Trademarks

Kubernetes is a registered trademark of The Linux Foundation. Red Hat and OpenShift are trademarks of Red Hat, Inc. Docker is a trademark of Docker, Inc. Java is a registered trademark of Oracle and/or its affiliates. Spring Boot is a trademark of Broadcom Inc. Quarkus is a trademark of Red Hat, Inc. Node.js is a trademark of the OpenJS Foundation. Chrome is a trademark of Google LLC. Other names may be trademarks of their respective owners. LogPane is an independent open-source project and is not affiliated with, endorsed by, or sponsored by any of them.
