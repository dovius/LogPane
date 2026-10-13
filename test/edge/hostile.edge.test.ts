// Log text is written by whoever can make the application log something (HTTP headers, request bodies,
// user names). None of it may freeze the tab, crash the viewer, hide text or reach a terminal as control codes.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REGEX_NESTED, REGEX_TOO_SLOW, applyFilter, highlightPieces, nestedRepetition, EMPTY_FILTER } from '../../src/core/filter';
import { entryToText } from '../../src/core/exportText';
import { MAX_FOLDED_CHARS, MAX_FOLDED_LINES, parseText } from '../../src/core/parse';
import { TOO_DEEP, escapeControls, safeString, safeStringify, visibleControls } from '../../src/core/safeText';
import { SINCE_TIME_MAX_AHEAD_MS, withSinceTime, withoutFollow } from '../../src/core/sources';
import { formatException } from '../../src/core/stacktrace';
import { groupFields, splitPlainStack } from '../../src/ui/fieldGroups';
import { jsonTokens, parseStackLine, stackParts } from '../../src/ui/format';
import { FETCH_IDLE_MS, LimitError, fetchText } from '../../src/ui/store';

const deep = (n: number): unknown => {
  let v: unknown = 1;
  for (let i = 0; i < n; i++) v = [v];
  return v;
};
const deepJson = (n: number) => `${'['.repeat(n)}1${']'.repeat(n)}`;

/** Runs `fn` and fails if it takes longer than `ms` (catastrophic backtracking takes seconds to minutes). */
function fast<T>(ms: number, fn: () => T): T {
  const t0 = performance.now();
  const out = fn();
  expect(performance.now() - t0).toBeLessThan(ms);
  return out;
}

describe('crafted lines stay linear', () => {
  const n = 200_000;

  it('stack frames full of spaces', () => {
    fast(100, () => parseStackLine(`\tat ${' '.repeat(n)}x`));
    fast(100, () => parseStackLine(`\tat ${' '.repeat(3900)}x(A.java:1)`));
    fast(100, () => stackParts(`\tat ${' '.repeat(n)}x\n`.repeat(5)));
  });

  it('exception lines made of one huge token', () => {
    fast(100, () => parseStackLine(`${'a.'.repeat(n)}: ${'x'.repeat(n)}`));
    fast(100, () => parseStackLine(`Caused by: ${'a'.repeat(3900)}`));
  });

  it('runs of line / paragraph separators (U+2028 / U+2029)', () => {
    fast(100, () => splitPlainStack(`first\n ${' '.repeat(n)}q`));
    fast(100, () => splitPlainStack(`first\n ${'  '.repeat(n / 2)}q`));
  });

  it('a whole plain-text log of such lines parses quickly', () => {
    const log = ['2026-10-01 09:00:00 ERROR boom', `\tat ${' '.repeat(50_000)}x`, ` ${' '.repeat(50_000)}q`].join('\n');
    const [e] = fast(500, () => parseText(log, 1));
    fast(200, () => splitPlainStack(e.raw));
  });
});

describe('deeply nested JSON never throws', () => {
  it('safeStringify / safeString return a marker instead of overflowing the stack', () => {
    expect(safeStringify(deep(20_000))).toBe(TOO_DEEP);
    expect(safeString(deep(20_000))).toBe(TOO_DEEP);
    expect(safeStringify({ a: 1 }, 2)).toBe('{\n  "a": 1\n}');
    expect(safeStringify(undefined)).toBe('undefined');
  });

  it('a 20k-deep field can be parsed, grouped, rendered as JSON and exported', () => {
    const line = `{"timestamp":"2026-10-01T09:00:00Z","level":"INFO","message":"x","data":${deepJson(20_000)}}`;
    const [e] = parseText(line, 1);
    expect(e.message).toBe('x');
    expect(() => groupFields(e)).not.toThrow();
    expect(jsonTokens(e.json).map((t) => t.text).join('')).toBe(TOO_DEEP);
    expect(() => entryToText(e, 'utc')).not.toThrow();
  });

  it('a structured exception with a deep message and deep frames still formats', () => {
    const text = formatException({ exceptionType: 'x.Boom', message: deep(20_000), frames: [deep(20_000), { class: 'a.B', method: 'c', line: 1 }] } as never);
    expect(text.split('\n')).toEqual([`x.Boom: ${TOO_DEEP}`, `\tat ${TOO_DEEP}`, '\tat a.B.c(B.java:1)']);
  });
});

describe('regex search can not hang the tab', () => {
  it('rejects groups repeated without bound whose body repeats or alternates', () => {
    for (const p of ['(a+)+', '(a+)+$', '(a|aa)+$', '(\\w|\\d)+$', '(\\w+\\s?)+:', '((ab)+c)*', '(a*)*', '(?:x+y?)+', '(\\d+\\.)+\\d+', '(a|b){2,}', '([a-z]+)*x']) {
      expect(nestedRepetition(p), p).toBe(true);
    }
  });

  it('accepts ordinary patterns, bounded repetition and escaped or bracketed lookalikes', () => {
    for (const p of ['ERROR', 'ORD-\\d+', '(\\d+\\.){3}\\d+', '.*timeout.*', 'a.*b.*c', '(GET|POST) /api', '[(a+)+]', '\\(a+\\)+', 'user=(\\w+)', '(ab)+', '(?<id>[0-9a-f]{32})', 'x{2,5}', '(abc){1,3}d', '[+*]+', '[\\]+]+']) {
      expect(nestedRepetition(p), p).toBe(false);
    }
  });

  it('the filter reports a rejected pattern without running it', () => {
    const entries = parseText(`{"message":"${'a'.repeat(40)}!"}`, 1);
    const res = fast(100, () => applyFilter(entries, { ...EMPTY_FILTER, text: '(a+)+$', regex: true }));
    expect(res).toMatchObject({ indices: [], error: REGEX_NESTED, highlight: null });
    expect(REGEX_NESTED).not.toBe(REGEX_TOO_SLOW);
  });

  it('patterns with several unbounded quantifiers highlight one match per row', () => {
    const entries = parseText('{"message":"a1 a2 a3"}', 1);
    const multi = applyFilter(entries, { ...EMPTY_FILTER, text: 'a.*\\d.*', regex: true });
    expect(multi.highlightMax).toBe(1);
    expect(applyFilter(entries, { ...EMPTY_FILTER, text: 'a\\d', regex: true }).highlightMax).toBeUndefined();
    // the cap stops searching, not just showing
    const re = /a\d/g;
    const exec = vi.spyOn(re, 'exec');
    expect(highlightPieces('a1 a2 a3', re, 1).filter((p) => p.hit)).toHaveLength(1);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});

describe('size limits', () => {
  it('an indented file does not fold into one giant entry', () => {
    const lines = ['2026-10-01 09:00:00 INFO start', ...Array.from({ length: MAX_FOLDED_LINES + 10 }, (_, i) => `  "k${i}": ${i},`)];
    const entries = parseText(lines.join('\n'), 1);
    expect(entries.length).toBeGreaterThan(1);
    expect(entries[0].raw.split('\n')).toHaveLength(MAX_FOLDED_LINES + 1);
    const wide = parseText(['2026-10-01 09:00:00 INFO start', ...Array.from({ length: 30 }, () => `  ${'x'.repeat(MAX_FOLDED_CHARS / 20)}`)].join('\n'), 1);
    expect(wide.every((e) => e.raw.length < MAX_FOLDED_CHARS)).toBe(true);
  });
});

describe('control and bidi characters', () => {
  it('are shown visibly, ANSI colours are dropped', () => {
    expect(visibleControls('\u001b[31mERROR\u001b[0m done')).toBe('ERROR done');
    expect(visibleControls('safe‮txt.exe')).toBe('safe⟨U+202E⟩txt.exe');
    expect(visibleControls('a\u001b]0;title\u0007b')).toBe('a␛]0;title⟨U+0007⟩b');
    expect(visibleControls('tab\tand\nnewline and ąčę 日本 💥')).toBe('tab\tand\nnewline and ąčę 日本 💥');
  });

  it('are escaped in text that leaves the viewer, so a paste into a terminal is inert', () => {
    expect(escapeControls('\u001b[201~rm -rf ~\u009b')).toBe('\\u001b[201~rm -rf ~\\u009b');
    expect(escapeControls('x⁦y⁩')).toBe('x\\u2066y\\u2069');
    expect(escapeControls('plain\ttext\r\n')).toBe('plain\ttext\r\n');
  });
});

describe('Tail and fetching', () => {
  const raw = 'https://console.example.com/api/kubernetes/api/v1/namespaces/demo/pods/app-1/log?container=app&follow=true';
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a line dated in the future can not push sinceTime past now + a few minutes', () => {
    const now = Date.UTC(2026, 9, 1, 12, 0, 0);
    const u = new URL(withSinceTime(raw, Date.UTC(9999, 11, 31), now));
    expect(Date.parse(u.searchParams.get('sinceTime')!)).toBeLessThanOrEqual(now + SINCE_TIME_MAX_AHEAD_MS);
    expect(u.searchParams.has('follow')).toBe(false);
  });

  it('never asks Kubernetes to follow (stream forever)', () => {
    expect(new URL(withoutFollow(raw)).searchParams.has('follow')).toBe(false);
    expect(withoutFollow('https://example.com/x?follow=true')).toBe('https://example.com/x?follow=true'); // not a pod log
  });

  it('fetches with same-origin credentials and refuses redirects to another site', async () => {
    const fetch = vi.fn(async () => Object.defineProperty(new Response('x'), 'url', { value: 'https://evil.example.net/log' }));
    vi.stubGlobal('fetch', fetch);
    await expect(fetchText('https://console.example.com/log')).rejects.toThrow(/redirected .*evil\.example\.net/);
    expect((fetch.mock.calls[0] as unknown[])[1]).toMatchObject({ credentials: 'same-origin' });
  });

  it('refuses logs over the size limit, by header or while reading', async () => {
    vi.stubGlobal('fetch', async () => new Response('x', { headers: { 'content-length': '999999999999' } }));
    await expect(fetchText('https://console.example.com/log')).rejects.toBeInstanceOf(LimitError);
    vi.stubGlobal('fetch', async () => new Response('0123456789'.repeat(100)));
    await expect(fetchText('https://console.example.com/log', 500)).rejects.toThrow(/larger than/);
    expect(await fetchText('https://console.example.com/log', 5000)).toHaveLength(1000);
  });

  it('gives up on a response that stops sending data', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) =>
      new Response(new ReadableStream({ start: (c) => init.signal!.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError'))) })),
    );
    const done = fetchText('https://console.example.com/log');
    const check = expect(done).rejects.toThrow(/No data from the server/);
    await vi.advanceTimersByTimeAsync(FETCH_IDLE_MS + 10);
    await check;
  });
});
