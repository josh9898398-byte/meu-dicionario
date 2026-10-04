/**
 * Config resolution: defaults <- deploy-time config (app-config.js) <- user settings (IndexedDB).
 * Never throws: a broken config file must not stop the app from booting.
 */

export const APP_VERSION = '1.0.0';
export const DB_NAME = 'plp-db';
export const DB_VERSION = 1;

const DEFAULTS = {
  version: APP_VERSION,
  aiProxyUrl: '/api/ai',
  ttsProxyUrl: '/api/tts',
  aiTransport: 'auto',
  ttsTransport: 'auto',
  resourceCatalogUrl: '',
  allowMockAI: true
};

function readDeployConfig() {
  try {
    const cfg = globalThis.__APP_CONFIG__;
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch {
    return {};
  }
}

export const deployConfig = { ...DEFAULTS, ...readDeployConfig() };

export const LIMITS = {
  searchResults: 60,
  searchSuggestions: 8,
  aiExamples: 8,
  favoritesPageSize: 40,
  audioCacheBytes: 220 * 1024 * 1024,
  audioCacheMaxItems: 4000,
  studySessionSize: 20
};

/**
 * Resolve an app-relative backend path against the page's base URL.
 *
 * Keeps deployments working in BOTH cases:
 *   root deploy   https://app.example.com/       -> https://app.example.com/api/ai
 *   sub-directory https://user.github.io/repo/   -> https://user.github.io/repo/api/ai
 *
 * Absolute http(s) URLs (a backend hosted elsewhere) are returned untouched.
 */
export function resolveAppUrl(path) {
  if (!path) return path;
  if (/^https?:/i.test(path)) return path;
  try {
    const base = (globalThis.document?.baseURI) || (globalThis.location?.href) || '';
    if (!base) return path;
    return new URL(String(path).replace(/^\.?\//, ''), base).href;
  } catch {
    return path;
  }
}
