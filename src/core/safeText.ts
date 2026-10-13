// Turning untrusted log values into text without throwing, hiding or smuggling anything.

// JSON.parse accepts nesting far deeper than JSON.stringify / String() can print (they overflow the
// stack at a few thousand levels), so a crafted log line must never reach them unguarded.

export const TOO_DEEP = '[value too deeply nested to show]';

/** JSON.stringify that never throws. */
export function safeStringify(value: unknown, space?: number): string {
  try {
    return JSON.stringify(value, null, space) ?? String(value);
  } catch {
    return TOO_DEEP;
  }
}

/** String() that never throws (arrays are joined recursively). */
export function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return TOO_DEEP;
  }
}

// C0 controls except tab / newline / CR, DEL, C1 controls (incl. CSI), and bidi embeddings, overrides and isolates.
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const CONTROL_RE_G = new RegExp(CONTROL_RE.source, 'g');
// ANSI colour / style sequences (ESC [ … m), common in plain-text logs
const SGR_RE_G = /\u001b\[[0-9;]{0,32}m/g;

const codeOf = (c: string) => c.charCodeAt(0).toString(16).padStart(4, '0');

/**
 * For display: drops ANSI colour codes and makes every other control or bidi character visible, so a log
 * line can't hide or visually reorder its text.
 */
export function visibleControls(text: string): string {
  if (!CONTROL_RE.test(text)) return text;
  return text.replace(SGR_RE_G, '').replace(CONTROL_RE_G, (c) => (c === '\u001b' ? '␛' : `⟨U+${codeOf(c).toUpperCase()}⟩`));
}

/** For text leaving the viewer (clipboard, downloads): the same characters as `\u001b` escapes, so a paste into a terminal is inert. */
export function escapeControls(text: string): string {
  return CONTROL_RE.test(text) ? text.replace(CONTROL_RE_G, (c) => `\\u${codeOf(c)}`) : text;
}
