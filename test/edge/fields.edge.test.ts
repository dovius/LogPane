import { describe, expect, it } from 'vitest';
import { FIELD_ALIASES, collectValues, detectPlainLevel, getPath, isGelf, normalizeLevel, pick, pickString, syslogLevel } from '../../src/core/fields';
import { parseText } from '../../src/core/parse';

describe('getPath / pick / pickString', () => {
  it('prefers a literal dotted key over a nested path and walks nested objects', () => {
    expect(getPath({ 'log.level': 'lit', log: { level: 'nested' } }, 'log.level')).toBe('lit');
    expect(getPath({ log: { level: 'nested' } }, 'log.level')).toBe('nested');
    expect(getPath({ a: { b: { c: 1 } } }, 'a.b.c')).toBe(1);
    expect(getPath({ a: 'str' }, 'a.length')).toBeUndefined();
    expect(getPath({ a: null }, 'a.b')).toBeUndefined();
    expect(getPath({ a: [{ b: 1 }] }, 'a.b')).toBeUndefined();
    expect(getPath({ a: [10, 20] }, 'a.1')).toBe(20); // arrays are walked by index (harmless)
    expect(getPath({}, 'missing')).toBeUndefined();
  });

  it('no alias (or alias segment) names an Object.prototype member, so lookups never hit inherited properties', () => {
    const inherited = Object.getOwnPropertyNames(Object.prototype);
    for (const list of Object.values(FIELD_ALIASES)) {
      for (const alias of list) {
        expect(inherited).not.toContain(alias);
        for (const seg of alias.split('.')) expect(inherited, alias).not.toContain(seg);
      }
    }
  });

  it('pick skips undefined, null and empty strings but keeps other falsy values', () => {
    expect(pick({ a: undefined, b: null, c: '', d: 0 }, ['a', 'b', 'c', 'd'])).toBe(0);
    expect(pick({ a: false }, ['a'])).toBe(false);
    expect(pick({ a: [] }, ['a'])).toEqual([]);
    expect(pick({ a: ' ' }, ['a'])).toBe(' ');
    expect(pick({}, ['a'])).toBeUndefined();
  });

  it('pickString stringifies non-strings', () => {
    expect(pickString({ a: { x: [1] } }, ['a'])).toBe('{"x":[1]}');
    expect(pickString({ a: 0 }, ['a'])).toBe('0');
    expect(pickString({ a: false }, ['a'])).toBe('false');
    expect(pickString({ a: null }, ['a'])).toBe('');
  });
});

describe('normalizeLevel', () => {
  it.each<[unknown, string]>([
    [60, 'FATAL'], [59, 'ERROR'], [50, 'ERROR'], [40, 'WARN'], [30, 'INFO'], [20, 'DEBUG'], [19.9, 'TRACE'], [10, 'TRACE'], [0, 'TRACE'], [-1, 'TRACE'], [1e9, 'FATAL'],
    ['warning', 'WARN'], [' Err ', 'ERROR'], ['information', 'INFO'], ['NOTICE', 'INFO'], ['config', 'INFO'], ['fine', 'DEBUG'], ['FINEST', 'TRACE'], ['verbose', 'TRACE'],
    ['emerg', 'FATAL'], ['panic', 'FATAL'], ['SEVERE', 'ERROR'], ['', 'OTHER'], ['nope', 'OTHER'], ['50', 'ERROR'], [null, 'OTHER'], [undefined, 'OTHER'], [true, 'OTHER'], [{}, 'OTHER'],
  ])('%j -> %s', (value, level) => {
    expect(normalizeLevel(value)).toBe(level);
  });
});

describe('syslogLevel (GELF)', () => {
  it.each<[unknown, string]>([
    [0, 'FATAL'], [1, 'FATAL'], [2, 'FATAL'], [3, 'ERROR'], [4, 'WARN'], [5, 'INFO'], [6, 'INFO'], [7, 'DEBUG'], [8, 'DEBUG'], [-1, 'FATAL'],
    ['3', 'ERROR'], [' 4 ', 'WARN'], ['error', 'ERROR'], ['warn', 'WARN'], [undefined, 'OTHER'],
  ])('%j -> %s', (value, level) => {
    expect(syslogLevel(value)).toBe(level);
  });

  // BUG: Number(null) / Number('') / Number([]) are 0, so a GELF line with "level": null or "" is shown as FATAL
  it('treats null and empty levels as unknown, not FATAL', () => {
    expect(syslogLevel(null)).toBe('OTHER');
    expect(syslogLevel('')).toBe('OTHER');
    expect(parseText(JSON.stringify({ version: '1.1', host: 'h', short_message: 'x', level: null }), 1)[0].level).toBe('OTHER');
  });

  it('isGelf needs a string short_message plus version 1.1 or a host', () => {
    expect(isGelf({ short_message: 'x', version: '1.1' })).toBe(true);
    expect(isGelf({ short_message: 'x', host: undefined })).toBe(true); // `in` check
    expect(isGelf({ short_message: 'x', version: '1.0' })).toBe(false);
    expect(isGelf({ short_message: 1, host: 'h' })).toBe(false);
  });

  it('_level_name wins over the numeric level', () => {
    expect(parseText(JSON.stringify({ version: '1.1', short_message: 'x', level: 3, _level_name: 'WARN' }), 1)[0].level).toBe('WARN');
  });
});

describe('detectPlainLevel', () => {
  it.each<[string, string]>([
    ['2026-10-01 10:00:00 [main] ERROR c.a.B - boom', 'ERROR'],
    ['[WARNING] x', 'WARN'],
    ['INFO: started', 'INFO'],
    ['INFO retrying after ERROR', 'INFO'], // the first level word wins
    ['ERRORS happened', 'OTHER'],
    ['xINFO', 'OTHER'],
    ['error lowercase', 'OTHER'], // current behaviour: only upper-case words
    ['CRITICAL:root:disk', 'FATAL'], // Python's CRITICAL
    ['SEVERE: x', 'ERROR'],
    ['', 'OTHER'],
  ])('%j -> %s', (line, level) => {
    expect(detectPlainLevel(line)).toBe(level);
  });

  it('only looks at the first 200 characters', () => {
    expect(detectPlainLevel(`${'x '.repeat(100)}ERROR`)).toBe('OTHER');
    expect(detectPlainLevel(`${'x '.repeat(97)}ERROR`)).toBe('ERROR');
  });
});

describe('collectValues', () => {
  it('collects strings, numbers and booleans, skips empty / null, does not enter containers at depth 3', () => {
    const out: string[] = [];
    collectValues({ s: 'a', e: '', n: 0, b: false, z: null, arr: ['x', ['y', ['z']]], o: { p: { leaf: 'ok', q: { r: 'too deep' } } } }, out);
    expect(out).toEqual(['a', '0', 'false', 'x', 'y', 'ok']);
  });

  it('through searchText, a JSON field is searchable down to 4 levels (json.a.b.c.d) but not deeper', () => {
    const [e] = parseText(JSON.stringify({ message: 'm', a: { b: { c: { d: 'fourlevels', e: { f: 'fivelevels' } } } } }), 1);
    expect(e.haystack).toContain('fourlevels');
    expect(e.haystack).not.toContain('fivelevels');
  });

  it('ignores functions and symbols', () => {
    const out: string[] = [];
    collectValues({ f: () => 1, s: Symbol('x') }, out);
    expect(out).toEqual([]);
  });
});
