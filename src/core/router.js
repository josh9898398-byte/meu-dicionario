/**
 * Hash-based router.
 *
 * Hash routing (not history API) is a deliberate choice: it needs no server
 * rewrites, so the exact same build works on Vercel, Netlify, Cloudflare Pages,
 * GitHub Pages and even plain shared hosting / a USB stick.
 *
 * Routes:
 *   #/home | #/dict?q=aproveitar | #/entry/<id> | #/notebook | #/fav/<id>
 *   #/study | #/add | #/import | #/resources | #/settings | #/about
 */

import { bus, EVENTS } from './events.js';

const routes = [];
let current = null;
let currentPage = null;
let handler = null;

export function defineRoute(pattern, page) {
  routes.push({ pattern, page, segments: pattern.split('/').filter(Boolean) });
}

/**
 * Pages render themselves and return an object with an optional `unmount()`.
 * `notFound` receives (route, error?) and renders the fallback screen.
 */
export function startRouter({ notFound }) {
  handler = { notFound };
  window.addEventListener('hashchange', resolve);
  resolve();
}

export function navigate(path, { replace = false } = {}) {
  const target = `#${path.startsWith('/') ? path : `/${path}`}`;
  if (window.location.hash === target) { resolve(); return; }
  if (replace) window.history.replaceState(null, '', target);
  else window.location.hash = target;
  if (replace) resolve();
}

export function back() {
  if (window.history.length > 1) window.history.back();
  else navigate('/home');
}

export function currentRoute() {
  return current;
}

export function buildPath(name, params = {}, query = {}) {
  let path = `/${name}`;
  for (const [key, value] of Object.entries(params)) {
    path += `/${encodeURIComponent(value)}`;
  }
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') qs.set(key, value);
  }
  const q = qs.toString();
  return q ? `${path}?${q}` : path;
}

function parseHash() {
  const raw = window.location.hash.replace(/^#/, '') || '/home';
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  const query = Object.fromEntries(new URLSearchParams(queryPart || ''));
  return { path: pathPart, segments, query };
}

function matchRoute(segments) {
  let best = null;
  for (const route of routes) {
    if (route.segments.length !== segments.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < route.segments.length; i += 1) {
      const seg = route.segments[i];
      if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(segments[i]);
      else if (seg !== segments[i]) { ok = false; break; }
    }
    if (ok) { best = { route, params }; break; }
  }
  return best;
}

async function resolve() {
  const parsed = parseHash();
  const match = matchRoute(parsed.segments);
  const next = { ...parsed, name: match?.route.pattern ?? 'notfound', params: match?.params ?? {} };
  const same = current && current.path === next.path && JSON.stringify(current.query) === JSON.stringify(next.query);
  if (same) return;

  if (currentPage?.unmount) {
    try { currentPage.unmount(); } catch (err) { console.error('[router] unmount failed', err); }
  }
  current = next;
  bus.emit(EVENTS.NAVIGATE, next);

  try {
    currentPage = match ? await match.route.page(next) : await handler.notFound(next);
  } catch (err) {
    console.error('[router] page failed', err);
    currentPage = await handler.notFound(next, err);
  }
}
