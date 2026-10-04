/** Tiny synchronous event bus. */

export function createEmitter() {
  const listeners = new Map();
  return {
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    off(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    emit(type, payload) {
      const set = listeners.get(type);
      if (!set) return;
      for (const fn of Array.from(set)) {
        try { fn(payload); } catch (err) { console.error(`[events] handler failed for "${type}"`, err); }
      }
    },
    clear() { listeners.clear(); }
  };
}

export const bus = createEmitter();

export const EVENTS = {
  DATA_CHANGED: 'data:changed',
  FAVORITES_CHANGED: 'favorites:changed',
  DICTIONARY_CHANGED: 'dictionary:changed',
  RESOURCES_CHANGED: 'resources:changed',
  CONNECTIVITY_CHANGED: 'connectivity:changed',
  SETTINGS_CHANGED: 'settings:changed',
  TOAST: 'ui:toast',
  NAVIGATE: 'ui:navigate',
  PLAY_AUDIO: 'audio:play'
};
