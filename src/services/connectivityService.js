/** Online/offline awareness. AI features must fail loudly (never silently). */

import { bus, EVENTS } from '../core/events.js';

let online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;

export function isOnline() {
  return online;
}

export function isOffline() {
  return !online;
}

export function init() {
  if (typeof window === 'undefined') return;
  window.addEventListener('online', () => setOnline(true));
  window.addEventListener('offline', () => setOnline(false));
  setOnline(navigator.onLine !== false);
}

function setOnline(next) {
  if (online === next) return;
  online = next;
  bus.emit(EVENTS.CONNECTIVITY_CHANGED, { online });
}

export function subscribe(fn) {
  return bus.on(EVENTS.CONNECTIVITY_CHANGED, fn);
}

/** Probe a proxy endpoint; used by the diagnostics page. */
export async function probe(url, { timeoutMs = 6000 } = {}) {
  if (!url) return { ok: false, reason: 'no-url' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal, cache: 'no-store' });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, reason: err?.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}
