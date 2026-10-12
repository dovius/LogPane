# Chrome Web Store listing: LogPane

Copy these into the Chrome Web Store developer dashboard.

## Store listing

**Name** (from manifest): `LogPane – JSON & NDJSON Log Viewer`

**Summary** (manifest `description`, max 132 characters):

> A fast, private JSON and NDJSON log viewer. Search, filter and inspect structured logs directly in your browser.

**Category:** Developer Tools
**Language:** English

**Description:**

```
Structured logs, without the noise.

LogPane turns raw JSON and NDJSON logs into a clean, searchable, and easy-to-read interface — directly in your browser.

Built for developers, DevOps engineers, and anyone working with structured application logs.

FEATURES
• Beautiful, readable JSON and NDJSON log viewer
• Filter logs by severity: ERROR, WARN, INFO, and DEBUG
• Instantly search messages and structured fields
• Expand and inspect individual log entries
• Find related events using trace IDs and correlation IDs
• Readable Java stack traces from structured exception fields
• Pretty-printed JSON payloads inside log messages
• Merge several logs by time and follow one request across services
• Reload and live tail for Kubernetes / OpenShift pod logs
• Copy or export exactly the entries you filtered
• Dark and light themes
• Open local log files or inspect supported browser pages
• Fast navigation through large log files

PRIVACY FIRST
Your logs stay on your device. LogPane processes data locally in your browser, with no account, external processing servers, or tracking.

WORKS WITH LOGS FROM
Kubernetes, OpenShift, Docker, Java, Quarkus, Spring Boot, Node.js, and any other application producing compatible structured logs.

No complicated setup. No subscriptions. Just readable logs.

Open source. Free to use.

Make sense of your logs with LogPane.
```

Supported formats, for reference:
- Quarkus / JBoss JSON
- logstash-logback-encoder
- Elastic ECS
- GELF (Spring Boot structured logging)
- pino, bunyan, winston
- Docker json-file
- `<timestamp> {json}` lines
- Plain-text lines (shown as-is)

**Graphics** (in this folder; all made from fictional demo data, `node scripts/make-demo.mjs`):

| File | Use | Size |
| --- | --- | --- |
| `../static/icons/icon128.png` | Store icon | 128×128 |
| `screenshot-1-stack-trace.png` | Screenshot: error with readable stack trace | 1280×800 |
| `screenshot-2-trace-across-services.png` | Screenshot: one trace across two services, JSON payload (dark) | 1280×800 |
| `screenshot-3-search-filter.png` | Screenshot: search + ERROR/WARN filter across two logs | 1280×800 |
| `screenshot-4-file-viewer.png` | Screenshot: local file viewer | 1280×800 |
| `promo-small-440x280.png` | Small promo tile | 440×280 |

## Privacy practices tab

**Single purpose:**

> LogPane displays structured (JSON / NDJSON) log text as a searchable, filterable viewer, either on the page the user opens it on or from files the user selects.

**Permission justifications:**

- **activeTab:** When the user clicks the toolbar button, LogPane reads the log text of the current tab to display it in the viewer. No other tabs are accessed.
- **scripting:** Injects the viewer into the current tab after the user clicks the toolbar button, or on domains the user explicitly enabled.
- **storage:** Stores display settings (time zone, font size, columns) and the list of domains the user enabled for automatic opening. Log content is never stored.
- **Host permissions (optional):** Requested at runtime only for the specific domains the user adds in the options page. On those domains, Kubernetes / OpenShift "Raw" pod log pages open in the viewer automatically. Nothing is requested at install time.

**Remote code:** No, I am not using remote code. All JavaScript is bundled in the package.

**Data usage:** LogPane does not collect or transmit user data. Log text is processed in memory, on the device only, and is never sent anywhere. In the data-type checklist, tick nothing. If a reviewer asks, explain that "website content" is read locally only and never leaves the browser. Then tick all three certifications:
- not sold to third parties;
- not used for unrelated purposes;
- not used for creditworthiness.

**Privacy policy URL:** host `PRIVACY.md`, for example the GitHub file URL of the public repository, and paste the link here.

## Before submitting

- [ ] Replace `LogPane contributors` in `LICENSE` with your name, if you want.
- [ ] Publish the repository and put its URL in the listing (homepage / support URL).
- [ ] `npm run zip` → upload `logpane-extension.zip`.
