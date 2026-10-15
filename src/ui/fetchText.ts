// The viewer's only network code. Just the viewer inside a log page (content.ts) hands it to its LogStore:
// the file viewer and the standalone logpane.html don't include it at all.
import { withoutFollow } from '../core/sources';
import { HttpError, LimitError, MAX_LOG_BYTES, tooLarge } from './store';

/** A fetch that receives nothing for this long is given up (e.g. a log URL with `follow=true` never ends). */
export const FETCH_IDLE_MS = 30_000;

/**
 * Fetches a log from the page's own server: cookies only for that origin, no redirects to other sites,
 * at most MAX_LOG_BYTES, and given up after FETCH_IDLE_MS without data.
 */
export async function fetchText(url: string, maxBytes = MAX_LOG_BYTES): Promise<string> {
  const ctrl = new AbortController();
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      ctrl.abort();
    }, FETCH_IDLE_MS);
  };
  arm();
  try {
    const res = await fetch(withoutFollow(url), { credentials: 'same-origin', cache: 'no-store', signal: ctrl.signal });
    if (res.url && new URL(res.url).origin !== new URL(url).origin) {
      throw new LimitError(`The server redirected the log to another site (${new URL(res.url).host}); LogPane doesn't follow it.`);
    }
    if (!res.ok) throw new HttpError(res.status, res.statusText);
    if ((res.headers.get('content-type') ?? '').includes('text/html')) {
      throw new Error('Got an HTML page instead of a log. Is the console session still valid?');
    }
    if (Number(res.headers.get('content-length')) > maxBytes) throw tooLarge();
    if (!res.body) return await res.text();
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel();
        throw tooLarge();
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (err) {
    if (stalled) throw new LimitError(`No data from the server for ${FETCH_IDLE_MS / 1000} s; gave up.`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
