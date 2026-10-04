/**
 * Minimal DOM helpers. Everything is created with createElement + textContent,
 * so user/AI text can never be injected as HTML (XSS-safe by construction).
 */

export function h(tag, props = null, ...children) {
  const el = document.createElement(tag);
  applyProps(el, props);
  append(el, children);
  return el;
}

export const frag = (...children) => {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
};

function applyProps(el, props) {
  if (!props) return;
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class' || key === 'className') { el.className = String(value); continue; }
    if (key === 'text') { el.textContent = String(value); continue; }
    if (key === 'html') { throw new Error('h(): raw HTML is not allowed; use text or child nodes'); }
    if (key === 'dataset') { Object.assign(el.dataset, value); continue; }
    if (key === 'style' && typeof value === 'object') { Object.assign(el.style, value); continue; }
    if (key === 'on' && typeof value === 'object') {
      for (const [evt, fn] of Object.entries(value)) if (typeof fn === 'function') el.addEventListener(evt, fn);
      continue;
    }
    if (key.startsWith('on') && typeof value === 'function') { el.addEventListener(key.slice(2).toLowerCase(), value); continue; }
    if (key === 'value') { el.value = value; continue; }
    if (key === 'checked' || key === 'disabled' || key === 'hidden' || key === 'selected') { el[key] = Boolean(value); continue; }
    el.setAttribute(key, value === true ? '' : String(value));
  }
}

function append(parent, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) { append(parent, child); continue; }
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function replaceChildren(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

export function on(target, type, handler, options) {
  target.addEventListener(type, handler, options);
  return () => target.removeEventListener(type, handler, options);
}

/** Event delegation: one listener on a container for many dynamic children. */
export function delegate(root, type, selector, handler) {
  return on(root, type, (event) => {
    const start = event.target instanceof Element ? event.target : null;
    const match = start?.closest(selector);
    if (match && root.contains(match)) handler(event, match);
  });
}

export function svgIcon(name, size = 20) {
  const paths = ICONS[name] || ICONS.dot;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('icon');
  for (const d of paths) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

const ICONS = {
  dot: ['M12 12h.01'],
  home: ['M4 11l8-7 8 7', 'M6 10v10h12V10', 'M10 20v-6h4v6'],
  book: ['M4 5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v14H6a2 2 0 0 0-2 2z', 'M17 5h1a2 2 0 0 1 2 2v12a2 2 0 0 0-2-2h-1'],
  star: ['M12 4l2.5 5.2 5.5.8-4 3.9 1 5.6-5-2.8-5 2.8 1-5.6-4-3.9 5.5-.8z'],
  cards: ['M4 8h16v10H4z', 'M8 5h10a2 2 0 0 1 2 2v1', 'M8 12h6', 'M8 15h4'],
  gear: ['M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.7-2.2l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10.4 3a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4z'],
  plus: ['M12 5v14', 'M5 12h14'],
  search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.3-4.3'],
  play: ['M8 5.5v13l11-6.5z'],
  pause: ['M9 6v12', 'M15 6v12'],
  speaker: ['M11 5L6 9H3v6h3l5 4z', 'M15.5 8.5a5 5 0 0 1 0 7', 'M18.5 6a8.5 8.5 0 0 1 0 12'],
  trash: ['M4 7h16', 'M9 7V5h6v2', 'M6 7l1 13h10l1-13', 'M10 11v6', 'M14 11v6'],
  download: ['M12 4v11', 'M8 11l4 4 4-4', 'M5 20h14'],
  upload: ['M12 20V9', 'M8 13l4-4 4 4', 'M5 4h14'],
  sparkles: ['M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6z', 'M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z'],
  check: ['M5 13l4 4 10-10'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  chevron: ['M9 6l6 6-6 6'],
  back: ['M15 5l-7 7 7 7'],
  filter: ['M4 6h16', 'M7 12h10', 'M10 18h4'],
  tag: ['M3 12l9-9h9v9l-9 9z', 'M15 8h.01'],
  wifiOff: ['M3 3l18 18', 'M8.5 16.5a5 5 0 0 1 7 0', 'M5 12.5a10 10 0 0 1 4-2.4', 'M12 20h.01'],
  cloud: ['M7 18a4 4 0 0 1 0-8 5.5 5.5 0 0 1 10.5 1.5A3.5 3.5 0 0 1 17 18z'],
  chart: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M22 20H2'],
  edit: ['M4 20h4l10-10-4-4L4 16z', 'M14 6l4 4'],
  copy: ['M9 9h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z', 'M5 15V6a2 2 0 0 1 2-2h9'],
  mic: ['M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3z', 'M5 12a7 7 0 0 0 14 0', 'M12 19v3'],
  info: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 11v5', 'M12 8h.01'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  box: ['M3 8l9-5 9 5-9 5z', 'M3 8v8l9 5 9-5V8', 'M12 13v8'],
  arrowRight: ['M5 12h14', 'M13 6l6 6-6 6'],
  refresh: ['M4 10a8 8 0 0 1 13.7-5.3L20 7', 'M20 4v4h-4', 'M20 14a8 8 0 0 1-13.7 5.3L4 17', 'M4 20v-4h4'],
  globe: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M3 12h18', 'M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9S9.5 5.5 12 3z'],
  list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01']
};

export { ICONS };
