# Security policy

LogPane processes log data that may be sensitive. Security reports are taken seriously.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead, use GitHub's private
vulnerability reporting: **Security → Report a vulnerability** on
<https://github.com/dovius/LogPane>.

Include the LogPane version, browser version, and steps to reproduce. You can expect an
acknowledgement within a few days.

## Scope

Examples of what counts:
- any way LogPane could send log content off the device;
- script injection through crafted log lines;
- a crafted log line that freezes or crashes the viewer, hides or reorders text, or reaches the clipboard as terminal control codes;
- the page around the viewer making LogPane act (open windows, request permissions, reload) without the user;
- access beyond the permissions described in [PRIVACY.md](PRIVACY.md).

## How LogPane protects you

The threat model: log text is written by whoever can make an application log something (an HTTP header,
a request body, a user name), and the page LogPane runs in may have its own scripts. Neither is trusted.

- **Log text is only ever text.** The viewer never builds HTML from log data (no `innerHTML`, no links or
  styles from values), so a log line can't run script in the console page. Control and bidirectional
  characters are shown visibly, ANSI colour codes are dropped, and everything copied or downloaded has them
  escaped (`\u001b`), so a paste into a terminal is inert.
- **Bounded work.** No regular expression that can backtrack catastrophically runs over log text; regex
  searches that could (like `(a+)+`) are refused, the others have a length limit and a time budget. Logs over
  256 MB are refused; very long entries, field lists and stack traces are cut until "Show all". Deeply nested
  JSON is shown as its raw line. If an entry still can't be rendered, only that entry shows an error.
- **No network beyond the log's own server.** Extension pages run with `connect-src 'none'`, the standalone
  file with `default-src 'none'` and hashes for its only script and style. Reload and Tail fetch only from the
  page's own origin, send cookies only there, refuse redirects to other sites, read at most 256 MB and give up
  after 30 s without data.
- **The page can't drive LogPane.** Web pages can't message the extension (no `externally_connectable`, no
  web-accessible resources). Messages from LogPane's own content script are accepted only from a tab's top
  frame, and the tab, URL and origin are taken from the sender. Buttons that open windows, request
  permissions or reload the tab ignore synthetic clicks. After a reload, the viewer comes back only on the
  same URL and only if it is still a plain-text log.
- **Least privilege.** No host access at install time. Automatic opening asks for one concrete `https://`
  domain at a time (plain `http://` only for `localhost`); wildcards are refused. Stored settings and domain
  lists are checked again whenever they are read.
- **Small supply chain.** One runtime dependency (Preact), exact versions with a committed lockfile, no remote
  code, no minification of LogPane's own code, so the package can be reviewed as shipped.
