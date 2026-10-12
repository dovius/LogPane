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

—
Kubernetes is a registered trademark of The Linux Foundation. Red Hat and OpenShift are trademarks of Red Hat, Inc. Docker is a trademark of Docker, Inc. Java is a registered trademark of Oracle and/or its affiliates. Spring Boot is a trademark of Broadcom Inc. Quarkus is a trademark of Red Hat, Inc. Node.js is a trademark of the OpenJS Foundation. Chrome is a trademark of Google LLC. Other names may be trademarks of their respective owners. LogPane is an independent open-source project and is not affiliated with, endorsed by, or sponsored by any of them.
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
| `../static/icons/icon128.png` | Store icon (96×96 artwork, 16 px transparent padding) | 128×128 |
| `screenshot-1-stack-trace.png` | Error with a readable stack trace | 1280×800 |
| `screenshot-2-trace-across-services.png` | One trace across two services, JSON payload (dark) | 1280×800 |
| `screenshot-3-search-filter.png` | Search + ERROR/WARN filter across two logs | 1280×800 |
| `screenshot-4-add-log.png` | Adding another log (file / URL / paste) | 1280×800 |
| `screenshot-5-file-viewer.png` | Local file viewer | 1280×800 |
| `promo-small-440x280.png` | Small promo tile (required for good placement) | 440×280 |
| `promo-marquee-1400x560.png` | Marquee promo tile (optional, needed for marquee features) | 1400×560 |

Screenshots are rendered at 1.25× from a 1024×640 layout, so text stays readable when the store shows them at 640×400.

## Privacy practices tab

**Single purpose:**

> LogPane displays structured (JSON / NDJSON) log text as a searchable, filterable viewer, either on the page the user opens it on or from files the user selects.

**Permission justifications:**

- **activeTab:** When the user clicks the toolbar button, LogPane reads the log text of the current tab to display it in the viewer. No other tabs are accessed.
- **scripting:** Injects the viewer into the current tab after the user clicks the toolbar button, or on domains the user explicitly enabled.
- **storage:** Stores display settings (time zone, font size, columns) and the list of domains the user enabled for automatic opening. Log content is never stored.
- **Host permissions (optional):** Requested at runtime only for the specific domains the user adds in the options page. On those domains, Kubernetes / OpenShift "Raw" pod log pages open in the viewer automatically. Nothing is requested at install time.

**Remote code:** No, I am not using remote code. All JavaScript is bundled in the package.

**Data usage:** the User Data FAQ requires disclosing user data even when it is processed only locally ("Extensions are required to disclose how they handle user data, even when data is processed or stored locally"). Page and file text count as user data, so:
- Tick **Website content** only. That is the log text LogPane reads from the current page or from files you open.
- Leave everything else unticked: personally identifiable info, health, financial, authentication, personal communications, location, web history, user activity.
- Tick all three certifications:
  - I do not sell or transfer user data to third parties, outside of the approved use cases.
  - I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
  - I do not use or transfer user data to determine creditworthiness or for lending purposes.
- Reviewer note, if asked: "Log text is read only to display it. It is processed in memory in the tab and never transmitted or stored. Extension pages enforce `connect-src 'none'`."

**Privacy policy URL:** `https://github.com/dovius/LogPane/blob/main/PRIVACY.md`

## Before submitting

**Name**
- [ ] Check that you can use the name. A hosted product called **Logpane** already exists (logpane.dev, analytics / error tracking, pub.dev package `logpane`).
  - Search EUIPO / TMview and USPTO for "LOGPANE" in classes 9 and 42.
  - If the name is taken or contested, rename before the first submission. The listing name is hard to change once users know it.

**Repository and links**
- [ ] Repository is public. Privacy policy URL: `https://github.com/dovius/LogPane/blob/main/PRIVACY.md`.
- [ ] Enable **Settings → Security → Private vulnerability reporting** on GitHub (SECURITY.md points to it).
- [ ] Homepage / support URL: `https://github.com/dovius/LogPane` (also in `manifest.json` → `homepage_url`).

**Developer account** (Chrome Web Store dashboard)
- [ ] Register with a personal Google account. Use a personal contact email; it is shown to users.
- [ ] Turn on 2-Step Verification (mandatory for publishing), ideally with a security key.
- [ ] Verify the contact email. Enforcement notices go there.
- [ ] Pay the one-time registration fee.
- [ ] Trader declaration (EU Digital Services Act): a free, non-commercial open-source hobby project is normally **non-trader**. Declare "trader" only if you sell it or use it professionally to make money. A trader's name, address and contact are published.

**Package**
- [ ] `npm ci && npm test && npm run zip` → upload `logpane-extension.zip`. It includes `LICENSE` and `THIRD_PARTY_LICENSES.txt` (Preact, MIT).
- [ ] Fill in the privacy practices tab as above. Use the description with the trademark notice at the end.
- [ ] Optionally replace `LogPane contributors` in `LICENSE` with your name.

**Review**
- Expect a longer, in-depth review: `optional_host_permissions` covers all sites (`https://*/*`, `http://*/*`). They are only requested per domain at runtime; say so in the host permission justification.
- Before uploading, test the zip in a clean Chrome profile: Load unpacked → Raw page → toolbar button → options → add a domain → auto-open.
- Distribution: keep "Public" and all regions. Visibility can start as "Unlisted" for a soft launch.

**After publishing**
- The same zip can be submitted to Microsoft Edge Add-ons (partner.microsoft.com). No code changes are needed.
- Every update needs a higher version: run `npm version patch|minor|major` (it bumps `package.json`, which the build copies into the manifest, and tags `vX.Y.Z`), then `npm run zip` and upload.
