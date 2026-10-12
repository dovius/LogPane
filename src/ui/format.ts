/** `com.example.orders.processors.ErrorProcessor` → `c.e.o.p.ErrorProcessor`. */
export function abbreviateLogger(name: string, max = 28): string {
  if (name.length <= max || !name.includes('.')) return name;
  const parts = name.split('.');
  const last = parts.pop()!;
  return `${parts.map((p) => p[0] ?? '').join('.')}.${last}`;
}

/** First line of a message, capped so huge payloads don't bloat list rows. */
export function listText(message: string, max = 400): string {
  const nl = message.indexOf('\n');
  const first = nl >= 0 ? `${message.slice(0, nl)} ⏎ …` : message;
  return first.length > max ? `${first.slice(0, max)}…` : first;
}

export type JsonTokenKind = 'key' | 'string' | 'number' | 'literal' | 'punct';

export interface JsonToken {
  text: string;
  kind: JsonTokenKind;
}

const JSON_TOKEN_RE = /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

/** Pretty-prints a value and splits it into tokens for syntax colouring. */
export function jsonTokens(value: unknown): JsonToken[] {
  const text = JSON.stringify(value, null, 2) ?? String(value);
  const out: JsonToken[] = [];
  let last = 0;
  for (const m of text.matchAll(JSON_TOKEN_RE)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ text: text.slice(last, i), kind: 'punct' });
    if (m[1] !== undefined) {
      out.push({ text: m[1], kind: m[2] ? 'key' : 'string' });
      if (m[2]) out.push({ text: m[2], kind: 'punct' });
    } else {
      out.push({ text: m[0], kind: /^[tfn]/.test(m[0]) ? 'literal' : 'number' });
    }
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), kind: 'punct' });
  return out;
}

const FRAMEWORK_FRAME_RE = /^\s*at (?:java\.|javax\.|jdk\.|sun\.|com\.sun\.|kotlin\.|org\.apache\.|io\.quarkus\.|io\.vertx\.|io\.netty\.|io\.opentelemetry\.|io\.smallrye\.|org\.jboss\.|org\.springframework\.|reactor\.|org\.hibernate\.)/;

/** Framework frames are dimmed so application frames stand out. */
export function isFrameworkFrame(line: string): boolean {
  return FRAMEWORK_FRAME_RE.test(line);
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}
