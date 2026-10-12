// Domains on which the viewer opens automatically for OpenShift "Raw" pod log pages.

export const AUTO_ORIGINS_KEY = 'autoOrigins';
export const AUTO_SCRIPT_ID = 'lv-auto';

/** Raw pod log path as served by the OpenShift console API proxy. */
export const RAW_LOG_PATH = '/api/kubernetes/api/v1/namespaces/*/pods/*/log*';

/**
 * Match patterns and permission origins without a port: Chrome matches them on every port,
 * which also covers local test servers like http://localhost:8080.
 */
export function originPattern(origin: string): string {
  const u = new URL(origin);
  return `${u.protocol}//${u.hostname}/*`;
}

export function normalizeOrigin(input: string): string | null {
  try {
    const u = new URL(input.trim().includes('://') ? input.trim() : `https://${input.trim()}`);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

export async function getAutoOrigins(): Promise<string[]> {
  const got = await chrome.storage.local.get(AUTO_ORIGINS_KEY);
  return Array.isArray(got[AUTO_ORIGINS_KEY]) ? (got[AUTO_ORIGINS_KEY] as string[]) : [];
}

export async function setAutoOrigins(origins: string[]): Promise<void> {
  await chrome.storage.local.set({ [AUTO_ORIGINS_KEY]: [...new Set(origins)].sort() });
}
