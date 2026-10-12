import { describe, expect, it } from 'vitest';
import { parseText } from '../../src/core/parse';
import { exceptionChain, fileNameForClass, formatException, formatFrame, frameCount } from '../../src/core/stacktrace';
import type { JsonObject } from '../../src/core/types';

const FRAME = { class: 'com.acme.Svc', method: 'run', line: 7 };

describe('formatException: missing and odd fields', () => {
  it.each<[unknown, string]>([
    [{}, 'Exception'],
    [{ message: 'm' }, 'Exception: m'],
    [{ exceptionType: 'X' }, 'X'],
    [{ exceptionType: 'X', message: '' }, 'X'],
    [{ exceptionType: 'X', message: null }, 'X'],
    [{ exceptionType: 'X', message: 42 }, 'X: 42'],
    [{ exceptionType: 'X', message: { code: 1 } }, 'X: {"code":1}'],
    [{ exceptionType: 5, type: 'T' }, 'Exception'], // a non-string exceptionType does not fall back to `type`
    [{ exceptionType: null, type: 'T' }, 'T'],
    [{ class: 'C' }, 'C'],
    [{ className: 'CN', message: 'm' }, 'CN: m'],
    [{ exception: { exceptionType: 'Inner' } }, 'Inner'],
    [{ exception: null, exceptionType: 'Outer' }, 'Outer'],
  ])('%j', (input, expected) => {
    expect(formatException(input)).toBe(expected);
  });

  it('non-objects: strings pass through, everything else is empty', () => {
    expect(formatException('java.lang.X: boom\n\tat a.B.c(B.java:1)')).toBe('java.lang.X: boom\n\tat a.B.c(B.java:1)');
    for (const v of [undefined, null, 42, true, [], [{ exceptionType: 'X' }]]) expect(formatException(v)).toBe('');
    for (const v of [undefined, null, 'x', 42, []]) {
      expect(exceptionChain(v)).toEqual([]);
      expect(frameCount(v)).toBe(0);
    }
  });

  it('ignores non-array frames', () => {
    for (const frames of ['at x', 5, { 0: FRAME, length: 1 }, null, true]) {
      const e = { exceptionType: 'X', frames };
      expect(formatException(e)).toBe('X');
      expect(frameCount(e)).toBe(0);
    }
  });

  it('formats frames of odd types without throwing', () => {
    const frames: unknown[] = [
      null, 42, 'str', [], [1, 2], {},
      { class: 'a.B', method: 'm', line: '12' },
      { class: 'a.B', method: 'm', line: -2 },
      { class: 'a.B', method: 'm', line: -1 },
      { class: 'a.B', method: 'm', line: 0 },
      { class: 'a.B', method: 'm', line: 1.5 },
      { className: 'a.C', method: 'm', line: 3, file: 'Gen.kt' },
      { class: 5, method: null, line: 1 },
      { class: 'a.Outer$Inner$1', method: 'lambda$0', line: 9 },
    ];
    expect(formatException({ exceptionType: 'X', frames }).split('\n')).toEqual([
      'X',
      '\tat null',
      '\tat 42',
      '\tat str',
      '\tat ',
      '\tat 1,2',
      '\tat ?.?(Unknown Source)',
      '\tat a.B.m(Unknown Source)',
      '\tat a.B.m(Native Method)',
      '\tat a.B.m(Unknown Source)',
      '\tat a.B.m(B.java:0)',
      '\tat a.B.m(B.java:1.5)',
      '\tat a.C.m(Gen.kt:3)',
      '\tat ?.?(?.java:1)',
      '\tat a.Outer$Inner$1.lambda$0(Outer.java:9)',
    ]);
    expect(frameCount({ exceptionType: 'X', frames })).toBe(frames.length);
    expect(formatFrame(undefined)).toBe('at undefined');
  });

  it('fileNameForClass edge cases', () => {
    expect(fileNameForClass('com.acme.Outer$Inner')).toBe('Outer.java');
    expect(fileNameForClass('Outer')).toBe('Outer.java');
    expect(fileNameForClass('$Proxy12')).toBe('$Proxy12.java');
    expect(fileNameForClass('com.sun.proxy.$Proxy12')).toBe('com.sun.proxy.$Proxy12.java');
    expect(fileNameForClass('')).toBe('.java');
    expect(fileNameForClass('a.b.')).toBe('a.b..java');
  });
});

describe('cause chains and references', () => {
  it('renders back-references and stops the chain there', () => {
    expect(formatException({ refId: 3 })).toBe('[CIRCULAR REFERENCE: refId=3]');
    const e = { exceptionType: 'A', causedBy: { exception: { refId: 1 } } };
    expect(formatException(e)).toBe('A\nCaused by: [CIRCULAR REFERENCE: refId=1]');
    expect(exceptionChain(e)).toEqual([{ type: 'A', message: '' }]);
    // anything more than a bare refId is a real exception
    expect(formatException({ refId: 1, message: null })).toBe('Exception');
    expect(formatException({ refId: 1, exceptionType: 'X' })).toBe('X');
    expect(formatException({ refId: 1, frames: [] })).toBe('Exception');
  });

  it('causedBy wins over cause; unusable causes are ignored', () => {
    expect(formatException({ exceptionType: 'A', causedBy: { exceptionType: 'B' }, cause: { exceptionType: 'C' } })).toBe('A\nCaused by: B');
    expect(formatException({ exceptionType: 'A', cause: { exceptionType: 'C' } })).toBe('A\nCaused by: C');
    expect(formatException({ exceptionType: 'A', causedBy: [] })).toBe('A');
    expect(formatException({ exceptionType: 'A', cause: 'java.io.IOException: string causes are dropped' })).toBe('A');
    expect(formatException({ exceptionType: 'A', causedBy: { exception: null } })).toBe('A\nCaused by: Exception');
  });

  it('exceptionChain reports only string types and messages', () => {
    expect(exceptionChain({ exceptionType: 7, message: { a: 1 }, causedBy: { exceptionType: 'B', message: 'b' } })).toEqual([
      { type: '', message: '' },
      { type: 'B', message: 'b' },
    ]);
  });
});

describe('cyclic object graphs built in JS', () => {
  it('a self-referencing cause terminates with a truncation marker', () => {
    const e: JsonObject = { exceptionType: 'A', message: 'm', frames: [FRAME] };
    e.causedBy = e;
    const lines = formatException(e).split('\n');
    expect(lines.filter((l) => l === 'Caused by: A: m')).toHaveLength(50);
    expect(lines[lines.length - 1]).toBe('Caused by: [... cause chain truncated]');
    expect(exceptionChain(e)).toHaveLength(51);
    expect(frameCount(e)).toBe(51);
  });

  it('a two-node cycle through {exception: ...} wrappers and the `cause` alias terminates', () => {
    const a: JsonObject = { exceptionType: 'A' };
    const b: JsonObject = { exceptionType: 'B' };
    a.causedBy = { exception: b };
    b.cause = a;
    const lines = formatException(a).split('\n');
    expect(lines.slice(0, 4)).toEqual(['A', 'Caused by: B', 'Caused by: A', 'Caused by: B']);
    expect(lines).toHaveLength(52);
    expect(exceptionChain(a).map((l) => l.type).slice(0, 3)).toEqual(['A', 'B', 'A']);
  });

  it('a self-referencing suppressed list terminates', () => {
    const e: JsonObject = { exceptionType: 'S' };
    e.suppressed = [e];
    const lines = formatException(e).split('\n');
    expect(lines).toHaveLength(52);
    expect(lines[1]).toBe('\tSuppressed: S');
    expect(lines[lines.length - 1]).toBe(`${'\t'.repeat(51)}Suppressed: [... cause chain truncated]`);
  });

  it('a 10 000-deep (acyclic) chain is truncated, not walked', () => {
    let e: JsonObject = { exceptionType: 'E10000', frames: [FRAME] };
    for (let i = 9999; i >= 0; i--) e = { exceptionType: `E${i}`, frames: [FRAME], causedBy: { exception: e } };
    const t0 = performance.now();
    const lines = formatException(e).split('\n');
    expect(performance.now() - t0).toBeLessThan(200);
    expect(lines.filter((l) => l.startsWith('Caused by: E'))).toHaveLength(50);
    expect(exceptionChain(e)).toHaveLength(51);
    expect(frameCount(e)).toBe(51);
  });
});

describe('structured exceptions coming from the parser', () => {
  it('a 2000-deep JSON cause chain parses, renders and indexes the first 51 links', () => {
    let json = '{"exceptionType":"E2000","message":"deepest"}';
    for (let i = 1999; i >= 0; i--) json = `{"exceptionType":"E${i}","message":"m${i}","causedBy":{"exception":${json}}}`;
    const [e] = parseText(`{"level":"ERROR","message":"boom","exception":${json}}`, 1);
    expect(e.exception).toBeDefined();
    expect(e.haystack).toContain('\ne0\n');
    expect(e.haystack).toContain('\ne50\n');
    expect(e.haystack).not.toContain('\ne51\n');
    expect(formatException(e.exception).split('\n')).toHaveLength(52);
  });

  it('a string exception becomes the stack text; a non-structured object is ignored (current behaviour)', () => {
    const [str, obj] = parseText(
      [JSON.stringify({ message: 'a', exception: 'java.lang.X: boom\n\tat a.B.c(B.java:1)' }), JSON.stringify({ message: 'b', exception: { class: 'java.io.IOException', message: 'disk' } })].join('\n'),
      1,
    );
    expect(str.exception).toBeUndefined();
    expect(str.stackText).toContain('java.lang.X: boom');
    expect(obj.exception).toBeUndefined();
    expect(obj.stackText).toBeUndefined();
    expect(obj.haystack).not.toContain('ioexception'); // `exception` is an indexed key, so it is not searched either
  });

  it('frames of odd types in parsed JSON do not break parsing or search', () => {
    const [e] = parseText(JSON.stringify({ message: 'x', exception: { exceptionType: 'X', frames: [null, 1, 'a', [], { line: 'x' }], suppressed: 'nope', causedBy: 7 } }), 1);
    expect(frameCount(e.exception)).toBe(5);
    expect(formatException(e.exception).split('\n')).toHaveLength(6);
  });
});
