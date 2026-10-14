import { describe, expect, it } from 'vitest';
import { entryToText } from '../../src/core/exportText';
import { LogParser, looksLikeJsonLog, parseLinesChunked, parseText, searchText, splitLines } from '../../src/core/parse';
import { TOO_DEEP } from '../../src/core/safeText';
import { LEVELS, type LogEntry } from '../../src/core/types';

// ---------- deterministic randomness ----------
type Rng = () => number;
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r: Rng, n: number) => Math.floor(r() * n);
const pickOne = <T>(r: Rng, xs: readonly T[]): T => xs[int(r, xs.length)];

/** Random UTF-16 code units: control chars (incl. \u0000), lone surrogates, any BMP char, JSON punctuation. */
function randomUnits(r: Rng, len: number, allowNewlines: boolean): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    const bucket = int(r, 8);
    let c: number;
    if (bucket === 0) c = int(r, 0x20);
    else if (bucket === 1) c = 0xd800 + int(r, 0x800);
    else if (bucket === 2) c = 0x80 + int(r, 0xff80);
    else if (bucket === 3) c = '{}[]":,\\'.charCodeAt(int(r, 8));
    else c = 0x20 + int(r, 0x5f);
    if (!allowNewlines && (c === 10 || c === 13)) c = 0x20;
    s += String.fromCharCode(c);
  }
  return s;
}

const WORDS = ['order', 'payment', 'Route', 'cache', 'user=u7', 'ÄÖÜ', 'naïve', '日本語', 'emoji😀', 'x-y', 'a.b', '"q"', 'tab\there', 'back\\slash', '{brace}', '[br]', 'ERROR', 'info'];
const words = (r: Rng, n: number) => Array.from({ length: n }, () => pickOne(r, WORDS)).join(' ');
const BASE = Date.UTC(2026, 9, 1, 10, 0, 0);
function iso(r: Rng): string {
  const s = new Date(BASE + int(r, 86_400_000)).toISOString();
  return s.replace('Z', `${String(int(r, 1_000_000)).padStart(6, '0').slice(0, int(r, 7))}Z`);
}
const plainTs = (r: Rng) => new Date(BASE + int(r, 86_400_000)).toISOString().replace('T', ' ').replace('.', ',').replace('Z', '');
const LVL = ['INFO', 'WARN', 'ERROR', 'DEBUG', 'TRACE', 'FATAL', 'warning', 'err', 'nonsense'];

/** A mix of everything the parser has to cope with; never contains a line terminator. */
function genLine(r: Rng): string {
  switch (int(r, 15)) {
    case 0: return JSON.stringify({ timestamp: iso(r), level: pickOne(r, LVL), loggerName: `com.acme.${pickOne(r, WORDS)}`, message: words(r, 4), mdc: { traceId: `t${int(r, 5)}` } });
    case 1: return JSON.stringify({ time: BASE + int(r, 1e6), level: int(r, 70), msg: words(r, 3) });
    case 2: return JSON.stringify({ log: `${r() < 0.5 ? JSON.stringify({ level: 'warn', msg: words(r, 2) }) : `plain ${words(r, 2)}`}\n`, stream: 'stdout', time: iso(r) });
    case 3: return `${iso(r)} ${JSON.stringify({ level: 'info', msg: words(r, 3) })}`;
    case 4: return `${plainTs(r)} ${pickOne(r, LVL)} [main] ${words(r, 3)}`;
    case 5: return `\tat com.acme.${pickOne(r, ['A', 'B$1', 'C'])}.run(X.java:${int(r, 500)})`;
    case 6: return `Caused by: java.io.IOException: ${words(r, 2)}`;
    case 7: return '\t... 3 more';
    case 8: return '';
    case 9: return ' '.repeat(int(r, 4)) + (r() < 0.5 ? '\t' : '');
    case 10: return `{"broken": ${words(r, 2)}`;
    case 11: return randomUnits(r, int(r, 60), false);
    case 12: return `  ${words(r, 3)}`;
    case 13: return JSON.stringify({ version: '1.1', host: 'h', short_message: words(r, 2), level: int(r, 8), timestamp: (BASE + int(r, 1e6)) / 1000 });
    default: return JSON.stringify({ '@timestamp': iso(r), 'log.level': pickOne(r, LVL), message: words(r, 2), exception: { exceptionType: 'X', message: 'm', frames: [{ class: 'a.B', method: 'c', line: 1 }] } });
  }
}

/** Physical lines of a text whose terminators are LF or CRLF. */
/** CRLF, LF and a lone CR each end a line; a final terminator does not start another one. */
const physicalLines = (text: string) => {
  const parts = text.split(/\r\n|\n|\r/);
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
};

const view = (e: LogEntry) => ({
  sourceId: e.sourceId, lineNo: e.lineNo, raw: e.raw, json: e.json, tsText: e.tsText, tsMs: e.tsMs, tsNanos: e.tsNanos,
  tsInherited: e.tsInherited, seq: e.seq, level: e.level, logger: e.logger, thread: e.thread, message: e.message,
  traceId: e.traceId, spanId: e.spanId, stackText: e.stackText, haystack: e.haystack,
});

function chunked(lines: readonly string[], r: Rng): LogEntry[] {
  const p = new LogParser(1);
  const out: LogEntry[] = [];
  for (let i = 0; i < lines.length;) {
    const n = int(r, 12); // 0-sized chunks too
    for (const e of p.pushLines(lines.slice(i, i + n))) out.push(e);
    i += n;
  }
  return out;
}

const nested = (depth: number, leaf = '1') => '{"a":'.repeat(depth) + leaf + '}'.repeat(depth);

describe('parser robustness: never throws', () => {
  it('survives random code units (control chars, \\u0000, lone surrogates, braces) with any line endings', () => {
    const r = mulberry32(1);
    for (let i = 0; i < 400; i++) {
      const text = randomUnits(r, int(r, 3000), true);
      let entries: LogEntry[] = [];
      expect(() => { entries = parseText(text, 1); }).not.toThrow();
      expect(() => looksLikeJsonLog(text)).not.toThrow();
      const p = new LogParser(1);
      p.pushLines(splitLines(text));
      expect(p.lineCount).toBe(physicalLines(text));
      for (const e of entries) expect(LEVELS).toContain(e.level);
    }
  });

  it('survives mutated JSON lines (random insert / delete / replace)', () => {
    const r = mulberry32(2);
    const lines: string[] = [];
    for (let i = 0; i < 3000; i++) {
      let s = genLine(r);
      for (let k = int(r, 4); k > 0; k--) {
        const at = int(r, s.length + 1);
        const op = int(r, 3);
        const ch = randomUnits(r, 1, false);
        s = op === 0 ? s.slice(0, at) + ch + s.slice(at) : op === 1 ? s.slice(0, at) + s.slice(at + 1) : s.slice(0, at) + ch + s.slice(at + 1);
      }
      lines.push(s);
    }
    expect(() => parseText(lines.join('\n'), 1)).not.toThrow();
  });

  it('handles \\u0000 and lone surrogates inside JSON strings and plain lines', () => {
    const [a, b, c] = parseText(['{"message":"nul\\u0000here","level":"INFO"}', '{"message":"\\ud800 lone","level":"WARN"}', 'plain \u0000 \udfff ERROR'].join('\n'), 1);
    expect(a.message).toBe('nul\u0000here');
    expect(b.message).toBe('\ud800 lone');
    expect(b.level).toBe('WARN');
    expect(c.json).toBeUndefined();
    expect(c.level).toBe('ERROR');
  });

  it('handles an extremely long (1 MB) JSON line, plain line and broken-JSON line quickly', () => {
    const big = 'x'.repeat(1 << 20);
    const t0 = performance.now();
    const [json, plain, broken] = parseText([JSON.stringify({ level: 'INFO', message: big }), `2026-10-01 10:00:00 ERROR ${big}`, `{"message":"${big}`].join('\n'), 1);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(json.message).toHaveLength(1 << 20);
    expect(json.level).toBe('INFO');
    expect(plain.level).toBe('ERROR');
    expect(plain.raw.length).toBeGreaterThan(1 << 20);
    expect(broken.json).toBeUndefined();
  });

  it('handles 5000-level nested JSON in any field', () => {
    const [other, msg] = parseText([`{"level":"INFO","payload":${nested(5000)}}`, `{"level":"INFO","message":${nested(5000)}}`].join('\n'), 1);
    expect(other.json).toBeDefined();
    expect(other.level).toBe('INFO');
    expect(msg.level).toBe('INFO');
    // 5000 levels is about where JSON.stringify runs out of stack: it prints on arm64 but not on x64 (the CI runner)
    expect(msg.message === TOO_DEEP || msg.message.startsWith('{"a":{"a":')).toBe(true);
  });

  it('handles 100 000-level nested JSON in a non-message field', () => {
    expect(() => parseText(`{"payload":${nested(100_000)}}`, 1)).not.toThrow();
  });

  // BUG: a message/logger/thread object nested deeper than ~8000 levels makes JSON.stringify overflow the stack, so the whole source fails to parse
  it('does not throw when the message is a 50 000-level nested object', () => {
    expect(() => parseText(`{"level":"INFO","message":${nested(50_000)}}\n{"message":"next"}`, 1)).not.toThrow();
  });

  it('treats JSON arrays and primitives as plain lines and keeps the raw text', () => {
    const lines = ['[1,2,3]', '[{"level":"ERROR","message":"in array"}]', '"just a string"', '42', 'null', 'true', '{}', '{ }'];
    const entries = parseText(lines.join('\n'), 1);
    expect(entries.map((e) => e.raw)).toEqual(lines);
    expect(entries.slice(0, 6).every((e) => e.json === undefined)).toBe(true);
    expect(entries[1].level).toBe('ERROR'); // plain-text level detection still sees the word
    expect(entries[6].json).toEqual({});
    expect(entries[7].json).toEqual({});
  });

  it('does not pollute prototypes or read inherited properties via __proto__ / constructor keys', () => {
    const entries = parseText(
      [
        '{"__proto__":{"level":"ERROR","message":"evil","timestamp":"2026-10-01T10:00:00Z"}}',
        '{"constructor":{"prototype":{"level":"ERROR"}},"message":"c"}',
        '{"toString":"x","valueOf":1,"hasOwnProperty":false,"message":"m","level":"warn"}',
        '{"level":"__proto__"}',
        '{"level":"constructor","logger":"toString"}',
      ].join('\n'),
      1,
    );
    expect(({} as Record<string, unknown>).level).toBeUndefined();
    expect(({} as Record<string, unknown>).message).toBeUndefined();
    const [proto, ctor, members, protoLevel, ctorLevel] = entries;
    expect(proto.level).toBe('OTHER');
    expect(proto.message).toBe('');
    expect(Number.isNaN(proto.tsMs)).toBe(true);
    expect(Object.getPrototypeOf(proto.json)).toBe(Object.prototype);
    expect(proto.haystack).toContain('evil'); // still searchable as an ordinary field
    expect(ctor.message).toBe('c');
    expect(members).toMatchObject({ level: 'WARN', message: 'm' });
    expect(protoLevel.level).toBe('OTHER');
    expect(ctorLevel).toMatchObject({ level: 'OTHER', logger: 'toString' });
  });

  it('stringifies non-string message / logger / thread values and ignores null and empty ones', () => {
    const cases: [unknown, string][] = [[42, '42'], [0, '0'], [true, 'true'], [false, 'false'], [{ a: 1 }, '{"a":1}'], [[1, 'b'], '[1,"b"]'], [null, ''], ['', '']];
    for (const [value, expected] of cases) {
      const [e] = parseText(JSON.stringify({ message: value, logger: value, thread: value }), 1);
      expect(e.message, JSON.stringify(value)).toBe(expected);
      expect(e.logger).toBe(expected);
      expect(e.thread).toBe(expected);
    }
    // null / empty fall through to the next alias
    expect(parseText('{"message":null,"msg":"second"}', 1)[0].message).toBe('second');
    expect(parseText('{"message":"","msg":"second"}', 1)[0].message).toBe('second');
  });

  it('maps odd level value types', () => {
    const lv = (v: unknown) => parseText(JSON.stringify({ level: v, message: 'x' }), 1)[0].level;
    expect(lv(true)).toBe('OTHER');
    expect(lv({ name: 'ERROR' })).toBe('OTHER');
    expect(lv(['ERROR'])).toBe('OTHER');
    expect(lv(null)).toBe('OTHER');
    expect(lv(' Error ')).toBe('ERROR');
    expect(lv(-5)).toBe('TRACE');
    expect(lv(1e308)).toBe('FATAL');
    expect(lv('50')).toBe('ERROR'); // numeric strings are read like pino numbers
  });

  it('uses the last value for duplicate keys (JSON.parse semantics)', () => {
    const [e] = parseText('{"level":"INFO","level":"ERROR","message":"a","message":"b"}', 1);
    expect(e.level).toBe('ERROR');
    expect(e.message).toBe('b');
  });

  it('parses non-finite-looking and odd sequence values', () => {
    const seq = (v: string) => parseText(`{"message":"x","sequence":${v}}`, 1)[0].seq;
    expect(seq('12')).toBe(12);
    expect(seq('"12"')).toBe(12);
    expect(Number.isNaN(seq('{}'))).toBe(true);
    expect(Number.isNaN(seq('"abc"'))).toBe(true);
    expect(Number.isNaN(seq('null'))).toBe(true);
  });
});

describe('line endings and BOM', () => {
  it('CRLF gives the same entries as LF, without stray \\r in raw', () => {
    const lines = ['{"level":"INFO","message":"a"}', 'plain ERROR line', '\tat a.B.c(B.java:1)', '', '{"level":"WARN","message":"b"}'];
    const lf = parseText(`${lines.join('\n')}\n`, 1);
    const crlf = parseText(`${lines.join('\r\n')}\r\n`, 1);
    expect(crlf.map(view)).toEqual(lf.map(view));
    expect(crlf.some((e) => e.raw.includes('\r'))).toBe(false);
  });

  it('mixed LF / CRLF endings keep line numbers right', () => {
    const entries = parseText('{"message":"1"}\r\n{"message":"2"}\n\r\n{"message":"4"}\n{"message":"5"}', 1);
    expect(entries.map((e) => [e.lineNo, e.message])).toEqual([[1, '1'], [2, '2'], [4, '4'], [5, '5']]);
  });

  it('a lone CR ends a line too (old Mac / some Windows tools)', () => {
    expect(splitLines('a\rb\rc')).toEqual(['a', 'b', 'c']);
    expect(splitLines('a\n\rb')).toEqual(['a', '', 'b']);
    const entries = parseText('{"message":"1"}\r{"message":"2"}\r', 1);
    expect(entries.map((e) => e.message)).toEqual(['1', '2']);
    expect(parseText('{"message":"1"}\r', 1)[0].json).toEqual({ message: '1' });
  });

  it('splitLines edge cases', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('\n')).toEqual(['']);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
    expect(splitLines('a\r\n')).toEqual(['a']);
    expect(splitLines('a')).toEqual(['a']);
  });

  it('looksLikeJsonLog strips a BOM before checking', () => {
    expect(looksLikeJsonLog('﻿{"level":"INFO","message":"x"}\n{"message":"y"}')).toBe(true);
  });

  // BUG: a UTF-8 BOM at the start of a line (pasted file, or `cat` of several files) makes JSON.parse fail, so the line is shown as plain text
  it('parses a JSON line that starts with a BOM', () => {
    const entries = parseText('﻿{"level":"ERROR","message":"boom"}\n{"level":"INFO","message":"ok"}', 1);
    expect(entries[0].json).toBeDefined();
    expect(entries[0].message).toBe('boom');
  });

  it('a BOM line is still counted and not dropped (current behaviour: shown as plain text)', () => {
    const entries = parseText('﻿{"level":"ERROR","message":"boom"}\n{"level":"INFO","message":"ok"}', 1);
    expect(entries).toHaveLength(2);
    expect(entries[1].lineNo).toBe(2);
    expect(entries[0].level).toBe('ERROR');
  });
});

describe('parser invariants (property tests)', () => {
  const runs = Array.from({ length: 150 }, (_, i) => i + 100);

  it('line count, strictly increasing lineNo, raw coverage and per-entry consistency', () => {
    for (const seed of runs) {
      const r = mulberry32(seed);
      const lines = Array.from({ length: 1 + int(r, 80) }, () => genLine(r));
      const crlf = r() < 0.3;
      let text = lines.map((l) => l + (crlf && r() < 0.7 ? '\r\n' : '\n')).join('');
      if (r() < 0.5 && lines[lines.length - 1] !== '') text = text.replace(/\r?\n$/, '');
      const p = new LogParser(7);
      const entries = p.pushLines(splitLines(text));

      // line count equals the number of physical lines
      expect(p.lineCount).toBe(lines.length);
      expect(physicalLines(text)).toBe(lines.length);

      // lineNo strictly increasing, within range, first raw line is that physical line
      let prev = 0;
      for (const e of entries) {
        expect(e.lineNo).toBeGreaterThan(prev);
        expect(e.lineNo).toBeLessThanOrEqual(lines.length);
        expect(e.raw.split('\n')[0]).toBe(lines[e.lineNo - 1]);
        prev = e.lineNo;
      }

      // every non-blank line ends up in exactly one entry's raw text, in order
      expect(entries.flatMap((e) => e.raw.split('\n'))).toEqual(lines.filter((l) => l.trim() !== ''));

      for (const e of entries) {
        expect(e.sourceId).toBe(7);
        expect(LEVELS).toContain(e.level);
        expect(Number.isInteger(e.tsNanos) && e.tsNanos >= 0 && e.tsNanos < 1e6).toBe(true);
        if (!e.tsInherited) expect(Number.isFinite(e.tsMs)).toBe(true);
        expect(e.haystack).toBe(searchText(e).toLowerCase());
        if (!e.json) expect(e.message).toBe(e.raw);
      }
    }
  });

  it('pushLines in random chunk sizes gives the same result as parseText', () => {
    for (const seed of runs) {
      const r = mulberry32(seed);
      const lines = Array.from({ length: 1 + int(r, 80) }, () => genLine(r));
      const text = lines.join('\n');
      const whole = parseText(text, 1);
      expect(chunked(splitLines(text), mulberry32(seed * 31)).map(view)).toEqual(whole.map(view));
    }
  });

  it('parseLinesChunked with odd chunk sizes gives the same result as parseText', async () => {
    const r = mulberry32(77);
    const lines = Array.from({ length: 700 }, () => genLine(r));
    const whole = parseText(lines.join('\n'), 1);
    for (const chunk of [1, 2, 7, 64, 699, 700, 701]) {
      const progress: number[] = [];
      const out = await parseLinesChunked(lines, new LogParser(1), (done) => progress.push(done), chunk);
      expect(out.map(view)).toEqual(whole.map(view));
      if (chunk < lines.length) expect(progress[progress.length - 1]).toBe(lines.length);
    }
  });

  it('timestamps are inherited forward from the last entry that had its own', () => {
    for (const seed of runs.slice(0, 40)) {
      const r = mulberry32(seed);
      const entries = parseText(Array.from({ length: 60 }, () => genLine(r)).join('\n'), 1);
      // entries before the first own timestamp (banners) get that first timestamp
      const first = entries.find((e) => !e.tsInherited);
      let last = first ? { ms: first.tsMs, nanos: first.tsNanos } : { ms: Number.NaN, nanos: 0 };
      for (const e of entries) {
        if (e.tsInherited) {
          expect(e.tsMs).toEqual(last.ms);
          expect(e.tsNanos).toBe(last.nanos);
        } else {
          last = { ms: e.tsMs, nanos: e.tsNanos };
        }
      }
    }
  });
});

describe('continuations', () => {
  it('folds continuation lines only into plain entries, across blank lines', () => {
    const entries = parseText(['ERROR boom', '', '\tat a.B.c(B.java:1)', '   ', 'Caused by: x', '{"message":"json"}', '\tat after.Json(J.java:1)'].join('\n'), 1);
    expect(entries.map((e) => e.raw)).toEqual(['ERROR boom\n\tat a.B.c(B.java:1)\nCaused by: x', '{"message":"json"}', '\tat after.Json(J.java:1)']);
    expect(entries[2]).toMatchObject({ lineNo: 7, level: 'OTHER', tsInherited: true });
  });

  it('an indented JSON line after a plain line is parsed as JSON, not folded', () => {
    const entries = parseText('plain\n   {"level":"WARN","message":"indented"}', 1);
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({ level: 'WARN', message: 'indented' });
  });

  it('a continuation-looking first line becomes its own entry', () => {
    const [e] = parseText('\tat a.B.c(B.java:1)', 1);
    expect(e).toMatchObject({ lineNo: 1, raw: '\tat a.B.c(B.java:1)' });
  });
});

describe('wrapper timestamps (kubectl --timestamps, docker json-file)', () => {
  it('uses the kubectl prefix when the JSON has no timestamp of its own', () => {
    const [e] = parseText('2026-10-01T10:00:00.123456789Z {"level":"info","msg":"x"}', 1);
    expect(e).toMatchObject({ tsMs: Date.UTC(2026, 9, 1, 10, 0, 0, 123), tsNanos: 456789, tsInherited: false });
  });

  it('accepts the prefix without a space before the JSON', () => {
    expect(parseText('2026-10-01T10:00:00Z{"msg":"x"}', 1)[0].json).toEqual({ msg: 'x' });
  });

  it('a lowercase z ends the kubectl prefix early (current behaviour: plain line)', () => {
    expect(parseText('2026-10-01T10:00:00.5z {"msg":"x"}', 1)[0].json).toBeUndefined();
  });

  // BUG: an unparseable own time field (e.g. "10:00:00.123") wins over the valid kubectl prefix, so the entry gets no / an inherited timestamp
  it('falls back to the kubectl prefix when the JSON time field cannot be parsed', () => {
    const [e] = parseText('2026-10-01T10:00:00.5Z {"time":"10:00:00.123","msg":"x"}', 1);
    expect(e.tsInherited).toBe(false);
    expect(e.tsMs).toBe(Date.UTC(2026, 9, 1, 10, 0, 0, 500));
  });

  // BUG: same for docker json-file: nginx-style "time":"01/Oct/2026:10:00:00 +0000" in the inner JSON hides the docker `time`
  it('falls back to the docker time when the inner JSON time field cannot be parsed', () => {
    const line = JSON.stringify({ log: '{"time":"01/Oct/2026:10:00:00 +0000","status":200,"msg":"GET /"}\n', stream: 'stdout', time: '2026-10-01T10:00:00.25Z' });
    const [e] = parseText(line, 1);
    expect(e.tsInherited).toBe(false);
    expect(e.tsMs).toBe(Date.UTC(2026, 9, 1, 10, 0, 0, 250));
  });

  // BUG: "[<ts>] {json}" - leadingTimestamp accepts the bracket but the slice offset ignores it, so the JSON is never parsed
  it('parses "[<timestamp>] {json}" lines as JSON', () => {
    const [e] = parseText('[2026-10-01T10:00:00Z] {"level":"error","msg":"boom"}', 1);
    expect(e.json).toBeDefined();
    expect(e.level).toBe('ERROR');
    expect(e.message).toBe('boom');
  });

  it('bracketed timestamps on plain lines are parsed', () => {
    const [e] = parseText('[2026-10-01 13:55:19,169] INFO started', 1);
    expect(e).toMatchObject({ tsMs: Date.UTC(2026, 9, 1, 13, 55, 19, 169), level: 'INFO', tsText: '2026-10-01 13:55:19,169' });
  });

  it('docker wrapper edge cases: empty log, CRLF in log, non-string log', () => {
    const [empty, crlf, obj] = parseText(
      [
        JSON.stringify({ log: '', stream: 'stdout', time: '2026-10-01T10:00:00Z' }),
        JSON.stringify({ log: 'WARN disk\r\n', stream: 'stderr', time: '2026-10-01T10:00:01Z' }),
        JSON.stringify({ log: { level: 'ERROR' }, stream: 'stdout', time: '2026-10-01T10:00:02Z' }),
      ].join('\n'),
      1,
    );
    expect(empty).toMatchObject({ message: '', level: 'OTHER', tsMs: Date.UTC(2026, 9, 1, 10, 0, 0) });
    expect(crlf).toMatchObject({ message: 'WARN disk', level: 'WARN' });
    expect(obj.message).toBe('{"level":"ERROR"}'); // not a docker wrapper: `log` is the message alias
  });
});

describe('non-string timestamp fields', () => {
  // BUG: an object timestamp (e.g. Google Cloud's {"seconds","nanos"}) becomes tsText "[object Object]", shown in tooltips and text exports
  it('does not render an object timestamp as "[object Object]"', () => {
    const [e] = parseText('{"timestamp":{"seconds":1759312800,"nanos":5000},"message":"m"}', 1);
    expect(e.tsText).not.toBe('[object Object]');
    expect(entryToText(e, 'utc')).not.toContain('[object Object]');
  });

  it('unparseable string timestamps are kept as text and the time is inherited', () => {
    const [a, b] = parseText('{"timestamp":"2026-10-01T10:00:00Z","message":"a"}\n{"timestamp":"garbage","message":"b"}', 1);
    expect(b).toMatchObject({ tsText: 'garbage', tsInherited: true, tsMs: a.tsMs });
    expect(entryToText(b, 'utc')).toBe('garbage OTHER b');
  });

  it('numeric epoch timestamps keep a textual tsText', () => {
    expect(parseText('{"time":1759312800123,"msg":"x"}', 1)[0].tsText).toBe('1759312800123');
  });
});

describe('looksLikeJsonLog', () => {
  it('handles CRLF, blank lines, sample size and the 50% threshold', () => {
    expect(looksLikeJsonLog('{"a":1}\r\n\r\nplain\r\n')).toBe(true); // 1 of 2
    expect(looksLikeJsonLog('plain\nplain\n{"a":1}')).toBe(false);
    expect(looksLikeJsonLog('   \n\t\n')).toBe(false);
    expect(looksLikeJsonLog(`${'plain\n'.repeat(20)}${'{"a":1}\n'.repeat(100)}`)).toBe(false); // only the first 20 count
    expect(looksLikeJsonLog('[1,2]\n"x"\n42')).toBe(false);
  });
});

describe('performance', () => {
  it('parses 50k synthetic JSON lines in well under 2 s', () => {
    const lines: string[] = [];
    for (let i = 0; i < 50_000; i++) {
      lines.push(JSON.stringify({
        timestamp: new Date(BASE + i * 7).toISOString(), level: LVL[i % 4], loggerName: `com.acme.svc${i % 13}`, threadName: `worker-${i % 8}`,
        message: `request ${i} handled in ${i % 1000}ms user=u${i % 97}`, mdc: { traceId: `t${i % 500}` }, sequence: i,
      }));
    }
    const text = lines.join('\n');
    const t0 = performance.now();
    const entries = parseText(text, 1);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(entries).toHaveLength(50_000);
  });

  it('parses 50k plain-text lines with stack traces in well under 2 s', () => {
    const lines: string[] = [];
    for (let i = 0; i < 50_000; i++) lines.push(i % 5 === 0 ? `2026-10-01 10:00:${String(i % 60).padStart(2, '0')},${String(i % 1000).padStart(3, '0')} ERROR [main] failed ${i}` : `\tat com.acme.C${i % 9}.m(C.java:${i % 300})`);
    const t0 = performance.now();
    const entries = parseText(lines.join('\n'), 1);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(entries).toHaveLength(10_000);
  });
});
