import { describe, expect, it } from 'vitest';
import { extractEmbeddedJson, mayContainJson } from '../../src/core/embedded';

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

const NASTY = ['}', '{', ']', '[', '"', '\\', '\\"', '}"', '\n', 'ü', '😀', '\u2028', '${x}', 'plain'];
function randomString(r: Rng): string {
  return Array.from({ length: int(r, 5) }, () => pickOne(r, NASTY)).join('');
}
function randomValue(r: Rng, depth: number): unknown {
  const k = depth > 3 ? int(r, 4) : int(r, 6);
  if (k === 0) return randomString(r);
  if (k === 1) return int(r, 1e6) - 5e5;
  if (k === 2) return pickOne(r, [true, false, null, 1.5e-7]);
  if (k === 3) return int(r, 2) ? randomString(r) : -0.25;
  if (k === 4) return Array.from({ length: int(r, 4) }, () => randomValue(r, depth + 1));
  return randomObject(r, depth + 1);
}
function randomObject(r: Rng, depth: number): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (let i = 0, n = 1 + int(r, 4); i < n; i++) o[`${randomString(r)}k${i}`] = randomValue(r, depth);
  return o;
}
const SAFE = 'abc XYZ 0123 :=,.-_/!?#@';
const safeText = (r: Rng) => Array.from({ length: int(r, 20) }, () => SAFE[int(r, SAFE.length)]).join('');

describe('extractEmbeddedJson: strings, escapes and brackets', () => {
  it.each<[string, unknown, string, string]>([
    ['{"a":"}}]]"}', { a: '}}]]' }, '', ''],
    ['x {"a":"he said \\"}\\" ok"} y', { a: 'he said "}" ok' }, 'x ', ' y'],
    ['{"path":"c:\\\\"} tail', { path: 'c:\\' }, '', ' tail'],
    ['{"a":"\\u007d\\u005b"}', { a: '}[' }, '', ''],
    ['{"a":1}}', { a: 1 }, '', '}'],
    [']{"a":1}', { a: 1 }, ']', ''],
    ['[{"a":1}', { a: 1 }, '[', ''],
    ['{} {"a":1}', { a: 1 }, '{} ', ''],
    ['[1,2] then [{"a":1}]', [{ a: 1 }], '[1,2] then ', ''],
    ['${a} ${b} {"k":1}', { k: 1 }, '${a} ${b} ', ''],
    ['say "hi {"a":1}', { a: 1 }, 'say "hi ', ''],
    ['{ "spaced" : [ 1 , { "x" : null } ] }', { spaced: [1, { x: null }] }, '', ''],
  ])('%s', (message, value, prefix, suffix) => {
    expect(extractEmbeddedJson(message)).toEqual({ prefix, value, suffix });
  });

  it.each(['{"a":1', '[{]}', '{"a":"unterminated}', '{\\}', '', 'no brackets', '}{', '{}', '[]', '[1,2]', '[null]', '{"a":1,}', "{'a':1}"])(
    'returns null for %j',
    (message) => {
      expect(extractEmbeddedJson(message)).toBeNull();
    },
  );

  it('current behaviour: arrays of arrays and arrays of empty objects are "worth showing"', () => {
    expect(extractEmbeddedJson('[[1]]')?.value).toEqual([[1]]);
    expect(extractEmbeddedJson('[{}]')?.value).toEqual([{}]);
  });

  it('current behaviour: only the first 8 bracket candidates are tried', () => {
    const seven = '[a] [b] [c] [d] [e] [f] [g] payload={"k":1}';
    const eight = '[a] [b] [c] [d] [e] [f] [g] [h] payload={"k":1}';
    expect(extractEmbeddedJson(seven)?.value).toEqual({ k: 1 });
    expect(extractEmbeddedJson(eight)).toBeNull();
  });
});

describe('extractEmbeddedJson properties', () => {
  it('finds a JSON object embedded between plain text, exactly', () => {
    const r = mulberry32(1);
    for (let i = 0; i < 3000; i++) {
      const value = randomObject(r, 0);
      const json = r() < 0.3 ? JSON.stringify(value, null, 2) : JSON.stringify(value);
      const prefix = safeText(r);
      const suffix = safeText(r);
      expect(extractEmbeddedJson(prefix + json + suffix)).toEqual({ prefix, value, suffix });
    }
  });

  it('never throws on bracket-heavy noise, and any result splits the message exactly', () => {
    const r = mulberry32(2);
    const alphabet = ['{', '}', '[', ']', '"', '\\', ':', ',', '1', 'a', ' ', '{"a":', '"x"', '[{', '}]'];
    for (let i = 0; i < 5000; i++) {
      const message = Array.from({ length: int(r, 40) }, () => pickOne(r, alphabet)).join('');
      const res = extractEmbeddedJson(message);
      if (!res) continue;
      const middle = message.slice(res.prefix.length, message.length - res.suffix.length);
      expect(res.prefix + middle + res.suffix).toBe(message);
      expect(JSON.parse(middle)).toEqual(res.value);
    }
  });
});

describe('extractEmbeddedJson performance on 100 KB messages', () => {
  const cases: [string, string][] = [
    ['many unbalanced braces', '{'.repeat(100_000)],
    ['interleaved braces', 'x{'.repeat(50_000)],
    ['an unterminated string', `{"a":"${'x'.repeat(100_000)}`],
    ['balanced but invalid candidates', `${'{'.repeat(50_000)}${'}'.repeat(50_000)}`],
    ['many small balanced non-JSON groups', `${'{ab} '.repeat(20_000)}{"found":true}`],
    ['eight huge balanced non-JSON candidates', Array.from({ length: 8 }, () => `{${'a'.repeat(12_000)}}`).join(' ')],
  ];
  it.each(cases)('%s', (_name, message) => {
    const t0 = performance.now();
    extractEmbeddedJson(message);
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it('finds a 100 KB JSON payload after a prefix', () => {
    const payload = { items: Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `item-${i}-}{` })) };
    const t0 = performance.now();
    const res = extractEmbeddedJson(`Response body: ${JSON.stringify(payload)} (truncated? no)`);
    expect(performance.now() - t0).toBeLessThan(200);
    expect(res?.value).toEqual(payload);
    expect(res?.suffix).toBe(' (truncated? no)');
  });

  it('handles 50 000-deep nested arrays', () => {
    const msg = `${'['.repeat(50_000)}${']'.repeat(50_000)}`;
    expect(() => extractEmbeddedJson(msg)).not.toThrow();
  });
});

describe('mayContainJson', () => {
  it.each<[string, boolean]>([
    ['{"a":1}', true],
    ['[{"a":1}]', true],
    ['{ "a": 1 }', true],
    ['[ { "a": 1 } ]', true],
    ['[\n  {\n    "a": 1\n  }\n]', false], // current behaviour: pretty-printed JSON is not badged
    ['{\n  "a": 1\n}', false],
    ['{}', false],
    ['plain', false],
    ['', false],
  ])('%j -> %s', (message, expected) => {
    expect(mayContainJson(message)).toBe(expected);
  });
});
