import { getAutoOrigins, normalizeOrigin, originPattern, setAutoOrigins } from './autoOrigins';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const isPopup = new URLSearchParams(location.search).has('popup');

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function setStatus(text: string, isError = false): void {
  const status = $('status');
  status.textContent = text;
  status.className = isError ? 'error' : '';
}

/** Must be called straight from a click handler: Chrome only shows the permission prompt during a user gesture. */
function enable(origin: string): void {
  chrome.permissions.request({ origins: [originPattern(origin)] }).then(
    async (granted) => {
      if (!granted) return setStatus(`Permission for ${origin} was not granted.`, true);
      await setAutoOrigins([...(await getAutoOrigins()), origin]);
      if (isPopup) {
        setStatus(`Done. From now on Raw logs on ${origin} open in LogPane automatically.`);
        setTimeout(() => window.close(), 1800);
      } else {
        setStatus(`Enabled for ${origin}. Raw log pages there now open in LogPane automatically.`);
      }
      history.replaceState(null, '', location.pathname);
      await render();
    },
    (err: unknown) => setStatus(String(err), true),
  );
}

async function disable(origin: string): Promise<void> {
  const remaining = (await getAutoOrigins()).filter((o) => o !== origin);
  await setAutoOrigins(remaining);
  const pattern = originPattern(origin);
  if (!remaining.some((o) => originPattern(o) === pattern)) await chrome.permissions.remove({ origins: [pattern] });
  setStatus(`Disabled for ${origin}.`);
  await render();
}

async function render(): Promise<void> {
  const origins = await getAutoOrigins();
  const list = $('origins');
  list.replaceChildren(
    ...(origins.length
      ? origins.map((o) => el('li', {}, el('code', {}, o), ' ', el('button', { type: 'button', textContent: 'Remove', onclick: () => void disable(o) })))
      : [el('li', { className: 'dim' }, 'None yet. The toolbar button still works on any Raw page.')]),
  );

  const pending = normalizeOrigin(new URLSearchParams(location.search).get('add') ?? '');
  const banner = $('pending');
  banner.hidden = !pending || origins.includes(pending);
  if (pending && !banner.hidden) {
    banner.replaceChildren(
      el('span', {}, 'Open Raw logs from ', el('code', {}, pending), ' in LogPane automatically?'),
      el('button', { type: 'button', className: 'primary', textContent: 'Enable', onclick: () => enable(pending) }),
    );
  }
}

$('add-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('origin-input');
  const origin = normalizeOrigin(input.value);
  if (!origin) return setStatus('Enter a URL such as https://console-openshift-console.apps.example.com', true);
  input.value = '';
  enable(origin);
});

void render();
