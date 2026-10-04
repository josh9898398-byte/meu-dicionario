/**
 * TTSService — one entry point for all Brazilian Portuguese speech.
 *
 *   TTSService.speak(text, { locale: 'pt-BR' })
 *   TTSService.prefetch([...texts])      // generate + cache for offline use
 *   TTSService.stop()
 *   TTSService.status()
 *
 * Providers (swappable, the rest of the app never knows which is used):
 *   proxy  : POST to `ttsProxyUrl` (ships as api/tts.js) -> neural pt-BR voices
 *   openai : direct call with a user supplied API key
 *   device : iOS/macOS built-in speech synthesis (offline, ordinary quality)
 *   none   : disabled
 *
 * HONESTY CONTRACT: the device provider is NOT presented as a neural voice.
 * If a text has no cached audio and the network is down, speak() fails with
 * `code = 'offline-no-audio'` and the UI shows 需要联网生成.
 *
 * Offline strategy: every generated clip is stored as a Blob in IndexedDB
 * (`audioCache`), keyed by provider+voice+locale+text. Cached audio plays with
 * no network at all. A real on-device neural TTS is possible later by adding a
 * provider implementation (see `registerProvider`).
 */

import { settingsRepo, audioRepo } from '../db/repos.js';
import { makeAudioCacheId, normalizeKey } from './normalizer.js';
import { LIMITS, deployConfig, resolveAppUrl } from '../config.js';
import { isOnline } from './connectivityService.js';
import { bus, EVENTS } from '../core/events.js';

export class TTSError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'TTSError';
    this.code = code;
    this.details = details;
  }
}

export const DEVICE_PROVIDER_NOTE = '设备内置语音（离线可用，普通音质，非神经网络语音）';

const DEFAULTS = {
  provider: 'auto',              // auto | proxy | openai | device | none
  proxyUrl: deployConfig.ttsProxyUrl,
  openaiKey: '',
  openaiModel: 'gpt-4o-mini-tts',
  openaiVoice: 'marin',
  proxyVoice: 'pt-BR-FranciscaNeural',
  rate: 1,
  autoPlay: true,
  prefetchOnSave: false,
  // If the backend TTS is not configured, fall back to the device pt-BR voice so
  // pronunciation always works. The UI states the quality difference honestly.
  allowDeviceFallback: true
};

let settings = { ...DEFAULTS };
let currentAudio = null;
let unlocked = false;
let lastFallback = null;
const providers = new Map();
const listeners = new Set();

export const EVENTS_TTS = { START: 'tts:start', END: 'tts:end', ERROR: 'tts:error' };

/* --------------------------------------------------------------- settings */

export async function init() {
  const saved = (await settingsRepo.get('tts')) || {};
  settings = { ...DEFAULTS, ...saved };
  registerProviders();
  return settings;
}

export async function configure(patch) {
  settings = { ...settings, ...patch };
  await settingsRepo.set('tts', settings);
  bus.emit(EVENTS.SETTINGS_CHANGED, { area: 'tts', settings });
  return settings;
}

export function getSettings() {
  return { ...settings };
}

export function registerProvider(id, impl) {
  providers.set(id, impl);
}

function registerProviders() {
  registerProvider('proxy', proxyProvider);
  registerProvider('openai', openaiProvider);
  registerProvider('device', deviceProvider);
}

/* ------------------------------------------------------------------ speak */

function resolveProvider(requested = settings.provider) {
  if (requested && requested !== 'auto') return requested;
  const wantsProxy = Boolean(settings.proxyUrl);
  const wantsKey = Boolean(settings.openaiKey);
  if (wantsProxy) return 'proxy';
  if (wantsKey) return 'openai';
  return 'device';
}

export function proxyBase() {
  return resolveAppUrl((settings.proxyUrl || deployConfig.ttsProxyUrl || '/api/tts').replace(/\/$/, ''));
}

export function statusUrl() {
  return `${proxyBase()}/status`;
}

/** Provider that would be used if the backend turns out to be unavailable. */
function fallbackProvider() {
  if (!settings.allowDeviceFallback) return null;
  if (typeof speechSynthesis === 'undefined') return null;
  return 'device';
}

export function status() {
  const provider = resolveProvider();
  return {
    provider,
    configured: provider === 'device' ? true : Boolean(provider === 'proxy' ? settings.proxyUrl : settings.openaiKey),
    online: isOnline(),
    deviceVoices: typeof speechSynthesis !== 'undefined' ? listPtVoices().length : 0,
    note: provider === 'device' ? DEVICE_PROVIDER_NOTE : null,
    lastFallback,
    settings: getSettings()
  };
}

/**
 * Speak text. Returns { ok, provider, cached, durationMs }.
 * Throws TTSError with a machine readable `code` on failure.
 */
export async function speak(text, options = {}) {
  const value = String(text || '').trim();
  if (!value) throw new TTSError('empty', '没有可播放的文本');

  const locale = options.locale || 'pt-BR';
  const providerId = resolveProvider(options.provider);
  if (providerId === 'none') throw new TTSError('disabled', '语音功能已在设置中关闭');

  const provider = providers.get(providerId);
  if (!provider) throw new TTSError('no-provider', `未知的语音提供方：${providerId}`);

  const voice = providerId === 'device'
    ? (options.voice || '')
    : (options.voice || (providerId === 'openai' ? settings.openaiVoice : settings.proxyVoice));

  const cacheId = makeAudioCacheId({ text: value, voice, provider: providerId, locale });

  // 1. cached audio first (offline path)
  const cached = await audioRepo.get(cacheId);
  if (cached?.blob) {
    notify(EVENTS_TTS.START, { text: value, provider: providerId, cached: true });
    const result = await playBlob(cached.blob, { rate: options.rate ?? settings.rate, wait: options.wait ?? false });
    audioRepo.touch(cacheId).catch(() => {});
    notify(EVENTS_TTS.END, { text: value, provider: providerId, cached: true });
    return { ok: true, provider: providerId, cached: true, ...result };
  }

  // 2. live synthesis
  if (provider.cacheable && !isOnline()) {
    throw new TTSError('offline-no-audio', '该音频尚未缓存，需要联网生成', { provider: providerId, text: value });
  }
  if (providerId === 'device') {
    notify(EVENTS_TTS.START, { text: value, provider: providerId, cached: false });
    const result = await deviceProvider.speak(value, { locale, rate: options.rate ?? settings.rate, wait: options.wait ?? true });
    notify(EVENTS_TTS.END, { text: value, provider: providerId, cached: false });
    return { ok: true, provider: providerId, cached: false, ...result };
  }

  let blob;
  try {
    blob = await provider.speak(value, { locale, voice, rate: options.rate ?? settings.rate });
  } catch (err) {
    // Backend not deployed / not configured → keep pronunciation working with the
    // device pt-BR voice, and remember why so the UI can say it plainly.
    const recoverable = ['not-configured', 'not-enabled', 'bad-response'].includes(err?.code)
      || /50[14]/.test(String(err?.details?.detail || ''))
      || err?.code === 'http' && /50[14]/.test(String(err?.message || ''));
    const fallback = fallbackProvider();
    if (recoverable && fallback === 'device') {
      lastFallback = {
        at: Date.now(),
        reason: 'backend-not-configured',
        message: '神经网络语音暂未启用，正在使用设备内置 pt-BR 语音（普通音质）'
      };
      notify(EVENTS_TTS.START, { text: value, provider: 'device', cached: false, fallback: true });
      const result = await deviceProvider.speak(value, { locale, rate: options.rate ?? settings.rate, wait: options.wait ?? true });
      notify(EVENTS_TTS.END, { text: value, provider: 'device', cached: false, fallback: true });
      return { ok: true, provider: 'device', cached: false, fallback: true, ...result };
    }
    throw err;
  }
  if (blob?.size) {
    await audioRepo.save({
      id: cacheId, text: value, locale, provider: providerId, voice,
      mimeType: blob.type || 'audio/mpeg', blob, size: blob.size
    });
    await audioRepo.prune({ maxItems: LIMITS.audioCacheMaxItems, maxBytes: LIMITS.audioCacheBytes }).catch(() => {});
  }
  notify(EVENTS_TTS.START, { text: value, provider: providerId, cached: false });
  const result = await playBlob(blob, { rate: options.rate ?? settings.rate, wait: options.wait ?? false });
  notify(EVENTS_TTS.END, { text: value, provider: providerId, cached: false });
  return { ok: true, provider: providerId, cached: false, ...result };
}

/** Generate + store audio without playing (used for offline preparation). */
export async function prefetch(texts, { locale = 'pt-BR', onProgress } = {}) {
  const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t || '').trim()).filter(Boolean);
  const providerId = resolveProvider();
  const provider = providers.get(providerId);
  if (!provider?.cacheable) {
    throw new TTSError('not-cacheable', '当前语音提供方（设备内置语音）无法缓存音频');
  }
  if (!isOnline()) throw new TTSError('offline', '需要联网生成语音');

  let done = 0;
  let generated = 0;
  const failures = [];
  for (const text of list) {
    const voice = providerId === 'openai' ? settings.openaiVoice : settings.proxyVoice;
    const cacheId = makeAudioCacheId({ text, voice, provider: providerId, locale });
    const cached = await audioRepo.get(cacheId);
    if (!cached?.blob) {
      try {
        const blob = await provider.speak(text, { locale, voice, rate: settings.rate });
        if (blob?.size) {
          await audioRepo.save({
            id: cacheId, text, locale, provider: providerId, voice,
            mimeType: blob.type || 'audio/mpeg', blob, size: blob.size
          });
          generated += 1;
        }
      } catch (err) {
        failures.push({ text, message: err?.message || String(err) });
      }
    }
    done += 1;
    onProgress?.({ done, total: list.length, text });
  }
  await audioRepo.prune({ maxItems: LIMITS.audioCacheMaxItems, maxBytes: LIMITS.audioCacheBytes }).catch(() => {});
  return { total: list.length, generated, failures };
}

export function stop() {
  if (currentAudio) {
    try { currentAudio.pause(); } catch { /* noop */ }
    currentAudio = null;
  }
  try { globalThis.speechSynthesis?.cancel(); } catch { /* noop */ }
  notify(EVENTS_TTS.END, { stopped: true });
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(type, payload) {
  bus.emit(type, payload);
  for (const fn of Array.from(listeners)) {
    try { fn({ type, ...payload }); } catch (err) { console.error('[tts] listener failed', err); }
  }
}

/* -------------------------------------------------------------- playback */

/**
 * iOS requires audio playback to start inside a user gesture at least once.
 * We prime an <audio> element with a silent clip on the first tap.
 */
export async function unlock() {
  if (unlocked) return true;
  try {
    const audio = new Audio();
    audio.src = SILENT_WAV;
    audio.volume = 0.01;
    await audio.play();
    audio.pause();
    unlocked = true;
    return true;
  } catch {
    return false;
  }
}

const SILENT_WAV = `data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=`;

async function playBlob(blob, { rate = 1, wait = false } = {}) {
  if (!globalThis.document || !blob) return { played: false };
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.preload = 'auto';
  try { audio.playbackRate = Math.min(2, Math.max(0.5, Number(rate) || 1)); } catch { /* noop */ }
  if (currentAudio) { try { currentAudio.pause(); } catch { /* noop */ } }
  currentAudio = audio;

  const finished = new Promise((resolve) => {
    const cleanup = () => {
      URL.revokeObjectURL(url);
      if (currentAudio === audio) currentAudio = null;
      resolve();
    };
    audio.addEventListener('ended', cleanup, { once: true });
    audio.addEventListener('error', cleanup, { once: true });
    setTimeout(cleanup, 60_000);
  });

  try {
    await audio.play();
  } catch (err) {
    URL.revokeObjectURL(url);
    throw new TTSError('playback-blocked', '浏览器阻止了自动播放，请再次点击播放按钮', { cause: String(err) });
  }
  if (wait) await finished;
  return { played: true, durationMs: Number.isFinite(audio.duration) ? audio.duration * 1000 : null };
}

/* -------------------------------------------------------------- providers */

const proxyProvider = {
  cacheable: true,
  label: '服务器 TTS（神经网络语音）',
  async speak(text, { locale, voice, rate }) {
    const base = proxyBase();
    if (!base) throw new TTSError('not-configured', '神经网络语音暂未启用');

    const post = (url) => fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, locale, voice, rate, format: 'mp3' })
    });

    let res;
    try {
      res = await post(`${base}/speak`);
      // Backwards compatibility: older deployments expose POST /api/tts
      if (res.status === 404 || res.status === 405) res = await post(base);
    } catch (err) {
      throw new TTSError('network', '语音服务器连接失败，请检查网络', { cause: String(err) });
    }

    if (!res.ok) {
      const detail = await safeText(res);
      throw new TTSError(res.status === 501 || res.status === 404 ? 'not-configured' : 'http',
        res.status === 501 || res.status === 404
          ? '神经网络语音暂未启用（服务器未配置 TTS）'
          : `语音服务返回 ${res.status}`,
        { status: res.status, detail });
    }

    const type = res.headers.get('Content-Type') || '';
    if (type.includes('application/json')) {
      const data = await res.json().catch(() => ({}));
      const audioUrl = data.audioUrl || data.url;
      if (!audioUrl) throw new TTSError('bad-response', '语音服务未返回音频');
      const audioRes = await fetch(audioUrl);
      if (!audioRes.ok) throw new TTSError('http', '无法下载生成的音频');
      return audioRes.blob();
    }
    return res.blob();
  }
};

const openaiProvider = {
  cacheable: true,
  label: 'OpenAI TTS（gpt-4o-mini-tts）',
  async speak(text, { voice, rate }) {
    if (!settings.openaiKey) throw new TTSError('not-configured', '未配置 OpenAI API Key');
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.openaiKey}`
      },
      body: JSON.stringify({
        model: settings.openaiModel || 'gpt-4o-mini-tts',
        voice: voice || settings.openaiVoice || 'marin',
        input: text,
        response_format: 'mp3',
        instructions: 'Fale em português do Brasil natural, com entonação de conversa cotidiana. Pronúncia brasileira, sem sotaque de Portugal.'
      })
    });
    if (!res.ok) {
      const detail = await safeText(res);
      throw new TTSError('http', `OpenAI TTS 返回 ${res.status}`, { detail });
    }
    return res.blob();
  }
};

const deviceProvider = {
  cacheable: false,
  label: DEVICE_PROVIDER_NOTE,
  async speak(text, { locale, rate, wait }) {
    if (typeof speechSynthesis === 'undefined') {
      throw new TTSError('unsupported', '此浏览器不支持内置语音合成');
    }
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = locale || 'pt-BR';
    utterance.rate = Math.min(2, Math.max(0.5, Number(rate) || 1));
    const voice = pickVoice(locale || 'pt-BR');
    if (voice) utterance.voice = voice;

    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        resolve({ played: true, wait });
      };
      utterance.onend = done;
      utterance.onerror = done;
      try {
        speechSynthesis.cancel();
        speechSynthesis.speak(utterance);
      } catch { done(); }
      if (!wait) done();
      setTimeout(done, Math.max(2500, text.length * 120));
    });
  }
};

export function listPtVoices() {
  if (typeof speechSynthesis === 'undefined') return [];
  return (speechSynthesis.getVoices() || [])
    .filter((v) => /^pt/i.test(v.lang || ''))
    .map((v) => ({ name: v.name, lang: v.lang, local: v.localService, default: v.default }));
}

const PREFERRED_DEVICE_VOICES = [
  'Luciana', 'Felipe', 'Fernanda', 'Joana', 'Maria', 'Thiago',
  'Luciana (Enhanced)', 'Felipe (Enhanced)', 'Fluent'
];

function pickVoice(locale) {
  if (typeof speechSynthesis === 'undefined') return null;
  const voices = speechSynthesis.getVoices() || [];
  if (!voices.length) return null;
  const brVoices = voices.filter((v) => /pt[-_]BR/i.test(v.lang || ''));
  const pool = brVoices.length ? brVoices : voices.filter((v) => /^pt/i.test(v.lang || ''));
  if (!pool.length) return null;
  for (const name of PREFERRED_DEVICE_VOICES) {
    const found = pool.find((v) => v.name?.includes(name));
    if (found) return found;
  }
  return pool.find((v) => v.localService) || pool[0];
}

async function safeText(res) {
  try { return (await res.text()).slice(0, 300); } catch { return ''; }
}

/** Cache statistics for the settings page. */
export async function cacheStats() {
  const stats = await audioRepo.stats();
  return { ...stats, textKeySample: normalizeKey('exemplo') };
}

export const TTSService = {
  init, configure, getSettings, speak, prefetch, stop, status, unlock,
  proxyBase, statusUrl, registerProvider, subscribe, listPtVoices, cacheStats, TTSError,
  DEVICE_PROVIDER_NOTE
};
