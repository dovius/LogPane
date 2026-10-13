// Domains on which the viewer opens automatically for OpenShift "Raw" pod log pages.

export const AUTO_ORIGINS_KEY = 'autoOrigins';
export const AUTO_PROMPT_DISMISSED_KEY = 'autoPromptDismissed';
export const AUTO_SCRIPT_ID = 'lv-auto';

/** Raw pod log path as served by the OpenShift console API proxy. */
export const RAW_LOG_PATH = '/api/kubernetes/api/v1/namespaces/*/pods/*/log*';
const RAW_LOG_RE = /^\/api\/kubernetes\/api\/v1\/namespaces\/[^/]+\/pods\/[^/]+\/log\/?$/;

/** True for pages the automatic mode would open (same paths as RAW_LOG_PATH). */
export function isRawLogPath(pathname: string): boolean {
  return RAW_LOG_RE.test(pathname);
}

/**
 * Match patterns and permission origins without a port: Chrome matches them on every port,
 * which also covers local test servers like http://localhost:8080.
 */
export function originPattern(origin: string): string {
  const u = new URL(origin);
  return `${u.protocol}//${u.hostname}/*`;
}

// DNS names and IPv4 addresses (URL() has already lowercased and punycoded them): no `*`, `%`, empty labels.
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
/** Plain http is accepted only on this machine: elsewhere anyone on the network could supply the page. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

/**
 * The origin to enable automatic opening for, or null. One concrete https host (or a local http one):
 * `*`, `*.example.com` and the like would turn into match patterns for many sites.
 */
export function normalizeOrigin(input: string): string | null {
  try {
    const text = input.trim();
    const u = new URL(text.includes('://') ? text : `https://${text}`);
    if (!HOST_RE.test(u.hostname)) return null;
    if (u.protocol === 'https:' || (u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname))) return u.origin;
    return null;
  } catch {
    return null;
  }
}

/** Stored lists are checked again when read: only valid origins in their normalised form. */
function validOrigins(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((o): o is string => typeof o === 'string' && normalizeOrigin(o) === o) : [];
}

export async function getAutoOrigins(): Promise<string[]> {
  return validOrigins((await chrome.storage.local.get(AUTO_ORIGINS_KEY))[AUTO_ORIGINS_KEY]);
}

export async function setAutoOrigins(origins: string[]): Promise<void> {
  await chrome.storage.local.set({ [AUTO_ORIGINS_KEY]: [...new Set(origins)].sort() });
}

/** Origins where the user answered "Not now" to the auto-open suggestion. */
export async function getDismissedOrigins(): Promise<string[]> {
  return validOrigins((await chrome.storage.local.get(AUTO_PROMPT_DISMISSED_KEY))[AUTO_PROMPT_DISMISSED_KEY]);
}

export async function dismissOrigin(input: string): Promise<void> {
  const origin = normalizeOrigin(input);
  if (!origin) return;
  await chrome.storage.local.set({ [AUTO_PROMPT_DISMISSED_KEY]: [...new Set([...(await getDismissedOrigins()), origin])] });
}
