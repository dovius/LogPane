export interface PodLogRef {
  namespace: string;
  pod: string;
  container?: string;
}

/** Kubernetes pod log endpoint, as proxied by the OpenShift console (`/api/kubernetes/api/v1/...`) or the API server. */
const RAW_PATH_RE = /\/api\/v1\/namespaces\/([^/]+)\/pods\/([^/]+)\/log\/?$/;
/** Console pages: `/k8s/ns/<ns>/pods/<pod>/logs` or `/k8s/ns/<ns>/core~v1~Pod/<pod>/containers/<c>/logs`. */
const CONSOLE_PATH_RE = /\/k8s\/ns\/([^/]+)\/(?:pods|core~v1~Pod)\/([^/]+)(?:\/containers\/([^/]+))?(?:\/[^/]*)?\/?$/;

export const SOURCE_COLORS = ['#4e79a7', '#f28e2b', '#59a14f', '#b07aa1', '#e15759', '#76b7b2', '#edc948', '#9c755f'];

/** decodeURIComponent that keeps malformed escapes (`100%.log`, `caf%E9`) instead of throwing. */
function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function tryUrl(input: string, base?: string): URL | null {
  try {
    return new URL(input.trim(), base);
  } catch {
    return null;
  }
}

export function parsePodLogUrl(url: string): PodLogRef | null {
  const u = tryUrl(url);
  if (!u) return null;
  const m = RAW_PATH_RE.exec(u.pathname);
  if (!m) return null;
  const container = u.searchParams.get('container') ?? undefined;
  return { namespace: safeDecode(m[1]), pod: safeDecode(m[2]), container };
}

/**
 * Normalises what a user pastes into a fetchable "Raw" log URL. Console page URLs are rewritten to the
 * console's API proxy; anything else http(s) is returned unchanged. Returns null for non-URLs.
 */
export function toRawLogUrl(input: string, base?: string): string | null {
  const u = tryUrl(input, base);
  if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) return null;
  if (RAW_PATH_RE.test(u.pathname)) return u.href;
  const m = CONSOLE_PATH_RE.exec(u.pathname);
  if (!m) return u.href;
  const raw = new URL(`/api/kubernetes/api/v1/namespaces/${m[1]}/pods/${m[2]}/log`, u.origin);
  const container = m[3] ? safeDecode(m[3]) : u.searchParams.get('container');
  if (container) raw.searchParams.set('container', container);
  return raw.href;
}

/** Pod hash suffix, e.g. `x2k4p` in `orders-service-6f7c9d8b4-x2k4p`. */
function podSuffix(pod: string): string {
  const parts = pod.split('-');
  return parts.length > 1 ? parts[parts.length - 1] : pod;
}

/** `container (pod-suffix)`: the container name says which service, the suffix which replica. */
export function labelForUrl(url: string): string {
  const ref = parsePodLogUrl(url);
  if (ref) return ref.container ? `${ref.container} (${podSuffix(ref.pod)})` : ref.pod;
  const u = tryUrl(url);
  if (!u) return url;
  const last = u.pathname.split('/').filter(Boolean).pop();
  if (u.protocol === 'file:' && last) return labelForFileName(safeDecode(last));
  return last ? safeDecode(last) : u.host;
}

export function labelForFileName(name: string): string {
  return name.replace(/\.(log|txt|json|jsonl|ndjson)$/i, '') || name;
}

/** Only the Kubernetes log API understands `sinceTime`. */
export function supportsSinceTime(url: string): boolean {
  return parsePodLogUrl(url) !== null;
}

/**
 * Adds `sinceTime` one second before the last known entry. Kubernetes filters by the kubelet's
 * write time (second precision), which is never earlier than the app's own timestamp, so nothing is missed;
 * the overlap is removed by `newLines()`.
 */
export function withSinceTime(url: string, lastMs: number): string {
  const u = new URL(url);
  const sec = Math.floor(lastMs / 1000) * 1000 - 1000;
  u.searchParams.set('sinceTime', new Date(sec).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  // Kubernetes rejects sinceSeconds together with sinceTime, and applies tailLines first (it would drop lines).
  u.searchParams.delete('sinceSeconds');
  u.searchParams.delete('tailLines');
  return u.href;
}
