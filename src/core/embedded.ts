export interface EmbeddedJson {
  prefix: string;
  value: unknown;
  suffix: string;
}

const MAX_CANDIDATES = 8;

/** Index just past the bracket matching the one at `start`, honouring JSON strings; -1 when unbalanced. */
function matchingEnd(s: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}

function worthShowing(v: unknown): boolean {
  if (Array.isArray(v)) return v.some((x) => x !== null && typeof x === 'object');
  return v !== null && typeof v === 'object' && Object.keys(v).length > 0;
}

/**
 * Finds a JSON object/array inside a log message, e.g. `Create New Order: {"orderId":"X"}`.
 * Placeholders like `${file:name}` or `[MicroProfilePropertiesSource]` are skipped because they don't parse.
 */
export function extractEmbeddedJson(message: string): EmbeddedJson | null {
  let from = 0;
  for (let n = 0; n < MAX_CANDIDATES; n++) {
    const brace = message.indexOf('{', from);
    const bracket = message.indexOf('[', from);
    const start = brace < 0 ? bracket : bracket < 0 ? brace : Math.min(brace, bracket);
    if (start < 0) return null;
    const end = matchingEnd(message, start);
    if (end > start) {
      try {
        const value: unknown = JSON.parse(message.slice(start, end));
        if (worthShowing(value)) {
          return { prefix: message.slice(0, start), value, suffix: message.slice(end) };
        }
      } catch {
        // not JSON, try the next bracket
      }
    }
    from = start + 1;
  }
  return null;
}

/** Cheap check used to badge list rows without parsing. */
export function mayContainJson(message: string): boolean {
  return message.includes('{"') || message.includes('[{') || message.includes('{ "');
}
