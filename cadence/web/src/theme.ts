// Follow the Home Assistant theme. Under Ingress the app runs in an iframe on
// the HA origin, so the parent's theme variables can be read directly, and
// HA applies (dark) themes as inline styles on its <html>, which can be
// watched. Outside HA (development) follow the device's light/dark setting.

const VARS: [ha: string, ours: string][] = [
  ['--primary-color', '--c-accent'],
  ['--text-primary-color', '--c-accent-text'],
  ['--primary-background-color', '--c-bg'],
  ['--card-background-color', '--c-surface'],
  ['--secondary-background-color', '--c-surface-2'],
  ['--primary-text-color', '--c-text'],
  ['--secondary-text-color', '--c-muted'],
  ['--divider-color', '--c-line'],
  ['--error-color', '--c-danger'],
];

function haDocument(): Document | null {
  try {
    if (window.parent === window) return null;
    const doc = window.parent.document; // throws if cross-origin
    return doc.documentElement ? doc : null;
  } catch {
    return null;
  }
}

export function isDark(color: string): boolean {
  const c = color.trim();
  let rgb: number[] | null = null;
  const m = /rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(c);
  if (m) rgb = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if (/^#[0-9a-f]{6}$/i.test(c)) rgb = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  else if (/^#[0-9a-f]{3}$/i.test(c)) rgb = [1, 2, 3].map((i) => parseInt(c[i] + c[i], 16));
  if (!rgb) return false;
  return 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2] < 128;
}

/** Copy HA's theme into our tokens. Returns false if the parent exposes no theme. */
function syncFromHa(doc: Document): boolean {
  const root = document.documentElement;
  const el = (doc.querySelector('home-assistant') as HTMLElement | null) ?? doc.documentElement;
  const cs = doc.defaultView!.getComputedStyle(el);
  const bg = cs.getPropertyValue('--primary-background-color').trim();
  if (!bg) return false;
  for (const [ha, ours] of VARS) {
    const v = cs.getPropertyValue(ha).trim();
    if (v) root.style.setProperty(ours, v);
    else root.style.removeProperty(ours); // e.g. switching back from a theme that set it
  }
  root.dataset.theme = isDark(bg) ? 'dark' : 'light';
  return true;
}

function followDevice() {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const set = () => (document.documentElement.dataset.theme = mq.matches ? 'dark' : 'light');
  set();
  mq.addEventListener('change', set);
}

export function applyTheme() {
  const doc = haDocument();
  if (!doc || !syncFromHa(doc)) return followDevice();
  const sync = () => syncFromHa(doc);
  // HA switches themes (and light/dark in "auto" mode) by rewriting inline
  // styles on its root elements: react immediately.
  const watch = new MutationObserver(sync);
  watch.observe(doc.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
  const ha = doc.querySelector('home-assistant');
  if (ha) watch.observe(ha, { attributes: true, attributeFilter: ['style', 'class'] });
  doc.defaultView?.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => setTimeout(sync, 50));
  // Safety net for theme changes made some other way (e.g. a stylesheet swap).
  setInterval(sync, 5000);
}
