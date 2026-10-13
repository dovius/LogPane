# LogPane privacy policy

_Last updated: 13 October 2026_

LogPane is a log viewer that runs entirely in your browser. It has no backend, no accounts and no analytics.

## What LogPane reads

LogPane reads log text only in these cases:

- **The page you open it on.** This happens when you click the LogPane toolbar button, or when the page is on a domain you enabled for automatic opening in the options.
- **Files you choose or drop** into LogPane.
- **Text you paste** into LogPane.

That text is parsed and displayed in memory inside the current tab. When you close or reload the tab, it is gone.

## What LogPane sends

**Nothing.** LogPane does not send log content or anything else to its authors or to any third party.

The only network requests LogPane makes are ones you trigger yourself, to fetch logs again from the same website the log came from:

- **Reload**
- **Tail**
- **Add log** with a URL

These requests go to that same server with your existing browser session, exactly as if you had reloaded the page. Cookies are sent only to that server, and a response that redirects to another site is refused.

Network access is also blocked technically:

- **Extension pages** (the file viewer and the options page) run under a Content Security Policy with `connect-src 'none'`. They cannot make network requests at all.
- **The standalone `logpane.html` file** runs under `default-src 'none'`. It cannot make network requests either.

## What LogPane stores

`chrome.storage.local` on your device keeps three things:

- **Display settings:** time zone (UTC or local), font size, visible columns, details panel width, and the number of context lines for copying.
- **Auto-open domains:** the list of domains you enabled for automatic opening.
- **Domains you answered "Not now"** to the automatic-opening suggestion, so it isn't shown there again.

Log content is **never** stored, and neither are search terms, filters or log URLs, with one short-lived exception.

When **Reload** or **Tail** has to reload the tab like F5 (on consoles that reject LogPane's own requests), the current view is handed over the reload: the page's URL, the search, the filters and the selected line. This view is kept in Chrome's in-memory session storage for that tab only. It is deleted as soon as the page has reopened, when the reload lands on a different page, after two minutes, or when the tab is closed. It is never written to disk.

## Chrome Web Store User Data Policy

LogPane's use of the data it handles complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use) requirements.

- Log text ("website content") is used only to display it to you. That is LogPane's single purpose.
- It is never transferred, sold, used for advertising or creditworthiness, or read by humans.

## What LogPane does not do

- No analytics, telemetry, crash reporting or tracking SDKs.
- No advertising.
- No accounts or sign-in.
- No remote code. All code ships inside the extension package.
- No selling or sharing of data. There is no data to share.

## Permissions

| Permission | Why it is needed |
| --- | --- |
| `activeTab` | Lets LogPane read the current tab's log text when you click the toolbar button. It does not give access to any other tab or site. |
| `scripting` | Shows the viewer inside that tab. |
| `storage` | Saves the display settings and domain lists described above, and briefly keeps the view across a reload (in memory). |
| Optional host access | Requested only for the specific domains you add for automatic opening, one `https://` domain at a time (plain `http://` only for `localhost`). Wildcards are not accepted. You can remove them in the options at any time. |

## Contact

Questions or concerns: open an issue at <https://github.com/dovius/LogPane/issues>.
Security problems: see [SECURITY.md](SECURITY.md).
