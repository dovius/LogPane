import { describe, expect, it } from 'vitest';
import { SOURCE_COLORS, labelForFileName, labelForUrl, parsePodLogUrl, supportsSinceTime, toRawLogUrl, withSinceTime } from '../../src/core/sources';

function withTZ<T>(tz: string, fn: () => T): T {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

const CONSOLE = 'https://console-openshift-console.apps.c1.example.com';
const RAW_BASE = `${CONSOLE}/api/kubernetes/api/v1/namespaces`;
const API = 'https://api.c1.example.com:6443/api/v1/namespaces';

describe('parsePodLogUrl', () => {
  it.each<[string, ReturnType<typeof parsePodLogUrl>]>([
    [`${API}/shop/pods/my-pod/log`, { namespace: 'shop', pod: 'my-pod', container: undefined }],
    [`${API}/shop/pods/my-pod/log/`, { namespace: 'shop', pod: 'my-pod', container: undefined }],
    [`${API}/shop/pods/my-pod/log?container=app&previous=true&tailLines=50`, { namespace: 'shop', pod: 'my-pod', container: 'app' }],
    [`${API}/shop/pods/my-pod/log?container=`, { namespace: 'shop', pod: 'my-pod', container: '' }],
    [`${API}/my%2Dns/pods/p%40x/log`, { namespace: 'my-ns', pod: 'p@x', container: undefined }],
    [`${API}/shop/pods/my-pod/log#frag`, { namespace: 'shop', pod: 'my-pod', container: undefined }],
    [`http://localhost:8001/api/v1/namespaces/a/pods/b/log?container=c%20d`, { namespace: 'a', pod: 'b', container: 'c d' }],
  ])('%s', (url, expected) => {
    expect(parsePodLogUrl(url)).toEqual(expected);
  });

  it.each([`${API}/shop/pods/my-pod/log/extra`, `${API}/shop/pods/my-pod/logs`, `${API}/shop/pods//log`, `${API}/shop/pods/my-pod`, '/api/v1/namespaces/a/pods/b/log', 'not a url', ''])(
    'returns null for %j',
    (url) => {
      expect(parsePodLogUrl(url)).toBeNull();
    },
  );

  it('supportsSinceTime only for the pod log API', () => {
    expect(supportsSinceTime(`${RAW_BASE}/shop/pods/p/log`)).toBe(true);
    expect(supportsSinceTime(`${CONSOLE}/k8s/ns/shop/pods/p/logs`)).toBe(false);
    expect(supportsSinceTime('https://example.com/app.log')).toBe(false);
    expect(supportsSinceTime('garbage')).toBe(false);
  });
});

describe('toRawLogUrl', () => {
  const raw = (ns: string, pod: string, container?: string) => `${RAW_BASE}/${ns}/pods/${pod}/log${container ? `?container=${container}` : ''}`;

  it.each<[string, string]>([
    [`${CONSOLE}/k8s/ns/shop/pods/p/logs/`, raw('shop', 'p')],
    [`${CONSOLE}/k8s/ns/shop/pods/p/logs?container=app&previous=true`, raw('shop', 'p', 'app')], // only `container` is carried over
    [`${CONSOLE}/k8s/ns/shop/pods/p/containers/app/logs?container=other`, raw('shop', 'p', 'app')], // the path wins
    [`${CONSOLE}/k8s/ns/shop/core~v1~Pod/p/containers/app`, raw('shop', 'p', 'app')],
    [`${CONSOLE}/k8s/ns/shop/pods/p/containers/my%2Dapp/logs`, raw('shop', 'p', 'my-app')],
    [`${CONSOLE}/k8s/ns/my%20ns/pods/p/logs`, raw('my%20ns', 'p')],
    [`${CONSOLE}/k8s/ns/shop/pods/p/logs#top`, raw('shop', 'p')],
    // current behaviour: any pod sub-page (details, yaml, events) is rewritten to the log
    [`${CONSOLE}/k8s/ns/shop/pods/p`, raw('shop', 'p')],
    [`${CONSOLE}/k8s/ns/shop/pods/p/yaml`, raw('shop', 'p')],
  ])('%s', (input, expected) => {
    expect(toRawLogUrl(input)).toBe(expected);
  });

  it('leaves raw URLs (with their extra parameters and hash) and other http(s) URLs unchanged', () => {
    const withParams = `${RAW_BASE}/shop/pods/p/log?container=app&previous=true&tailLines=100#x`;
    expect(toRawLogUrl(withParams)).toBe(withParams);
    expect(toRawLogUrl('https://example.com/logs/app.log?x=1')).toBe('https://example.com/logs/app.log?x=1');
    for (const odd of [`${CONSOLE}/k8s/ns/shop/pods/`, `${CONSOLE}/k8s/ns/shop/pods/p/containers//logs`, `${CONSOLE}/k8s/ns/shop/pods/p/containers/app/logs/extra`, `${CONSOLE}/k8s/cluster/c1/ns/shop/pods/p/logs`]) {
      expect(toRawLogUrl(odd), odd).toBe(odd);
    }
  });

  it('resolves relative and protocol-relative input against the base, trims whitespace, normalises the scheme', () => {
    expect(toRawLogUrl('/k8s/ns/shop/pods/p/logs', CONSOLE)).toBe(raw('shop', 'p'));
    expect(toRawLogUrl('logs.txt', 'https://h.example.com/dir/page')).toBe('https://h.example.com/dir/logs.txt');
    expect(toRawLogUrl('//other.example.com/a.log', 'https://h.example.com/')).toBe('https://other.example.com/a.log');
    expect(toRawLogUrl('  https://h.example.com/a.log\n')).toBe('https://h.example.com/a.log');
    expect(toRawLogUrl('HTTPS://H.EXAMPLE.COM/A.log')).toBe('https://h.example.com/A.log');
    expect(toRawLogUrl('/k8s/ns/shop/pods/p/logs')).toBeNull(); // relative without a base
  });

  it.each(['file:///Users/me/app.log', 'ftp://h/x.log', 'javascript:alert(1)', 'data:text/plain,hello', 'chrome-extension://abc/x.log', 'ws://h/x', 'mailto:a@b.c', '', 'not a url'])(
    'rejects %j',
    (input) => {
      expect(toRawLogUrl(input)).toBeNull();
    },
  );
});

describe('malformed percent-escapes', () => {
  // BUG: decodeURIComponent throws URIError on a stray "%" or a non-UTF-8 escape; content.ts calls labelForUrl(location.href)
  // after hiding the page text, so such a URL leaves the user with a blank page
  it('labelForUrl does not throw', () => {
    expect(() => labelForUrl('https://logs.example.com/files/100%.log')).not.toThrow();
    expect(() => labelForUrl('https://logs.example.com/files/caf%E9.log')).not.toThrow();
  });

  // BUG: same URIError from parsePodLogUrl / toRawLogUrl (supportsSinceTime and the "add URL" box throw instead of answering)
  it('pod URL helpers do not throw', () => {
    expect(() => supportsSinceTime(`${API}/shop/pods/p%ZZ/log`)).not.toThrow();
    expect(() => toRawLogUrl(`${CONSOLE}/k8s/ns/shop/pods/p/containers/a%ZZ/logs`)).not.toThrow();
  });

  it('well-formed escapes are decoded', () => {
    expect(labelForUrl('https://h.example.com/files/my%20log%C3%A9.txt')).toBe('my logé.txt');
  });
});

describe('labelForUrl / labelForFileName', () => {
  it.each<[string, string]>([
    [`${RAW_BASE}/shop/pods/orders-6f7c9d8b4-x2k4p/log?container=app`, 'app (x2k4p)'],
    [`${RAW_BASE}/shop/pods/singleton/log?container=app`, 'app (singleton)'],
    [`${RAW_BASE}/shop/pods/trailing-/log?container=app`, 'app ()'], // current behaviour
    [`${RAW_BASE}/shop/pods/orders-6f7c9d8b4-x2k4p/log`, 'orders-6f7c9d8b4-x2k4p'],
    [`${RAW_BASE}/shop/pods/p/log?container=`, 'p'],
    ['https://h.example.com/logs/', 'logs'],
    ['https://h.example.com/', 'h.example.com'],
    ['https://h.example.com:8080', 'h.example.com:8080'],
    ['https://h.example.com/?file=x.log', 'h.example.com'],
    ['file:///Users/me/app.log', 'app.log'],
    ['not a url', 'not a url'],
  ])('%s -> %s', (url, label) => {
    expect(labelForUrl(url)).toBe(label);
  });

  it.each<[string, string]>([
    ['a.log', 'a'], ['a.LOG', 'a'], ['a.txt', 'a'], ['a.json', 'a'], ['a.jsonl', 'a'], ['a.ndjson', 'a'],
    ['a.log.gz', 'a.log.gz'], ['a.log.1', 'a.log.1'], ['.log', '.log'], ['a', 'a'], ['', ''], ['a.b.log', 'a.b'],
  ])('labelForFileName(%j) = %j', (name, label) => {
    expect(labelForFileName(name)).toBe(label);
  });
});

describe('withSinceTime', () => {
  const url = `${RAW_BASE}/shop/pods/p/log?container=app`;
  const since = (u: string) => new URL(u).searchParams.get('sinceTime');

  it('goes one whole second back, also around the epoch', () => {
    expect(since(withSinceTime(url, 0))).toBe('1969-12-31T23:59:59Z');
    expect(since(withSinceTime(url, 999))).toBe('1969-12-31T23:59:59Z');
    expect(since(withSinceTime(url, 1000))).toBe('1970-01-01T00:00:00Z');
    expect(since(withSinceTime(url, 1999))).toBe('1970-01-01T00:00:00Z');
    expect(since(withSinceTime(url, -1))).toBe('1969-12-31T23:59:58Z');
    expect(since(withSinceTime(url, Date.UTC(2026, 9, 1, 13, 55, 50)))).toBe('2026-10-01T13:55:49Z');
    expect(since(withSinceTime(url, Date.UTC(2026, 9, 1, 13, 55, 50, 999)))).toBe('2026-10-01T13:55:49Z');
  });

  it('replaces an existing sinceTime and keeps the other parameters', () => {
    const u = new URL(withSinceTime(`${url}&sinceTime=2020-01-01T00:00:00Z&previous=true`, Date.UTC(2026, 0, 1)));
    expect(u.searchParams.getAll('sinceTime')).toEqual(['2025-12-31T23:59:59Z']);
    expect(u.searchParams.get('container')).toBe('app');
    expect(u.searchParams.get('previous')).toBe('true');
  });

  it('does not depend on the local time zone or DST', () => {
    const ms = Date.UTC(2026, 2, 29, 1, 30, 0, 500); // inside the EU spring-forward hour
    const expected = withTZ('UTC', () => withSinceTime(url, ms));
    for (const tz of ['Europe/Vilnius', 'America/St_Johns', 'Australia/Lord_Howe', 'Pacific/Kiritimati']) {
      expect(withTZ(tz, () => withSinceTime(url, ms))).toBe(expected);
    }
  });

  it('throws for NaN (callers must check, as store.tail does)', () => {
    expect(() => withSinceTime(url, Number.NaN)).toThrow(RangeError);
  });

  // BUG: the pod log API rejects requests that carry both sinceSeconds and sinceTime ("at most one of sinceTime or sinceSeconds"), so Tail fails on such URLs
  it('drops sinceSeconds when adding sinceTime', () => {
    const u = new URL(withSinceTime(`${url}&sinceSeconds=600`, Date.UTC(2026, 0, 1)));
    expect(u.searchParams.has('sinceSeconds')).toBe(false);
  });

  // BUG: tailLines is applied before sinceTime by the kubelet, so a burst of more than N new lines between two tails is silently lost
  it('drops tailLines when adding sinceTime', () => {
    const u = new URL(withSinceTime(`${url}&tailLines=100`, Date.UTC(2026, 0, 1)));
    expect(u.searchParams.has('tailLines')).toBe(false);
  });
});

describe('SOURCE_COLORS', () => {
  it('has distinct hex colours', () => {
    expect(new Set(SOURCE_COLORS).size).toBe(SOURCE_COLORS.length);
    for (const c of SOURCE_COLORS) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });
});
