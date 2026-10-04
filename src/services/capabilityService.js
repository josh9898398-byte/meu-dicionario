/**
 * CapabilityService — "这个功能现在能用吗？"
 *
 * 单点事实来源，供 UI 决定显示什么（而不是让用户去猜、或者点一个注定失败的按钮）：
 *
 *   AI ： 需要 (a) 联网 且 (b) 后端 /api/ai/status 报告 configured=true
 *   TTS： 已缓存音频 → 离线也能播；未缓存 → 需要联网（后端神经网络语音）
 *         或设备内置 pt-BR 语音（离线可用，普通音质）
 *
 * 所有探测都通过 `GET .../status` 完成，不涉及任何密钥（密钥只在服务器）。
 * 探测失败不会抛错，只会把状态标为「未启用」，应用其余部分照常工作。
 */

import { deployConfig } from '../config.js';
import { isOnline } from './connectivityService.js';
import { settingsRepo } from '../db/repos.js';
import { bus, EVENTS } from '../core/events.js';
import { AIService } from './aiService.js';
import { TTSService } from './ttsService.js';

const TTL_MS = 15 * 60 * 1000;

let state = {
  ai: { status: 'unknown', configured: false, message: '', model: null, checkedAt: 0 },
  tts: { status: 'unknown', configured: false, message: '', provider: null, voice: null, checkedAt: 0 }
};

let inFlight = null;

/** Probe URLs are derived from the configured proxies. */
function aiStatusUrl() {
  return AIService.statusUrl();
}

function ttsStatusUrl() {
  return TTSService.statusUrl();
}

async function probe(url, { timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store', headers: { Accept: 'application/json' } });
    if (res.status === 404) return { kind: 'missing' };
    if (!res.ok) return { kind: 'error', status: res.status };
    const data = await res.json();
    return { kind: 'ok', data };
  } catch (err) {
    return { kind: err?.name === 'AbortError' ? 'timeout' : 'error' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Refresh capability state. Cheap and cached; pass { force: true } to re-check
 * (used by the "重新检查" button and by the diagnostics page).
 */
export async function refresh({ force = false } = {}) {
  const now = Date.now();
  const online = isOnline();
  const fresh = (entry) => entry.checkedAt && now - entry.checkedAt < TTL_MS && entry.status !== 'unknown';

  if (!force && fresh(state.ai) && fresh(state.tts)) return snapshot();
  if (inFlight) return inFlight;

  inFlight = (async () => {
    if (!online) {
      state.ai = {
        status: 'offline',
        configured: false,
        message: '需要联网使用 AI 功能',
        model: null,
        checkedAt: now
      };
      state.tts = {
        status: 'offline',
        configured: false,
        message: '未缓存的语音需要联网生成',
        provider: null,
        voice: null,
        checkedAt: now
      };
      return snapshot();
    }

    const [aiResult, ttsResult] = await Promise.all([probe(aiStatusUrl()), probe(ttsStatusUrl())]);

    if (aiResult.kind === 'ok') {
      state.ai = {
        status: aiResult.data.configured ? 'ready' : 'not-configured',
        configured: Boolean(aiResult.data.configured),
        message: aiResult.data.message || '',
        model: aiResult.data.model || null,
        checkedAt: now
      };
    } else if (aiResult.kind === 'missing') {
      state.ai = {
        status: 'not-deployed',
        configured: false,
        message: 'AI 功能暂未启用：后端 /api/ai 未部署。应用的其他功能不受影响。',
        model: null,
        checkedAt: now
      };
    } else {
      state.ai = {
        status: 'unreachable',
        configured: false,
        message: 'AI 功能暂未启用：无法连接到后端服务。',
        model: null,
        checkedAt: now
      };
    }

    if (ttsResult.kind === 'ok') {
      state.tts = {
        status: ttsResult.data.configured ? 'ready' : 'not-configured',
        configured: Boolean(ttsResult.data.configured),
        provider: ttsResult.data.provider || null,
        voice: ttsResult.data.voice || null,
        message: ttsResult.data.message || '',
        checkedAt: now
      };
    } else {
      state.tts = {
        status: ttsResult.kind === 'missing' ? 'not-deployed' : 'unreachable',
        configured: false,
        provider: null,
        voice: null,
        message: '神经网络语音暂未启用：使用设备内置 pt-BR 语音（普通音质，离线可用）。',
        checkedAt: now
      };
    }

    await persist();
    bus.emit(EVENTS.SETTINGS_CHANGED, { area: 'capability' });
    return snapshot();
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

async function persist() {
  try {
    await settingsRepo.set('capability', {
      ai: { status: state.ai.status, checkedAt: state.ai.checkedAt },
      tts: { status: state.tts.status, checkedAt: state.tts.checkedAt }
    });
  } catch { /* non fatal */ }
}

/** Load the last known state so the UI can render instantly on cold start. */
export async function hydrate() {
  try {
    const saved = await settingsRepo.get('capability', null);
    if (saved?.ai?.checkedAt) {
      state.ai = { ...state.ai, status: saved.ai.status, checkedAt: saved.ai.checkedAt };
      state.tts = { ...state.tts, status: saved.tts?.status || 'unknown', checkedAt: saved.tts?.checkedAt || 0 };
    }
  } catch { /* ignore */ }
  return snapshot();
}

export function snapshot() {
  return {
    online: isOnline(),
    ai: { ...state.ai },
    tts: { ...state.tts }
  };
}

/** Convenience predicates used by pages/buttons. */
export function isAIAvailable() {
  // Explicit developer choices (mock / bring-your-own key) win over the probe.
  const provider = AIService.resolveProvider();
  if (provider === 'mock') return true;
  if (provider === 'none') return false;
  if (provider === 'openai') return isOnline() && Boolean(AIService.getSettings().apiKey);
  return isOnline() && state.ai.configured;
}

export function aiUnavailableReason() {
  const provider = AIService.resolveProvider();
  if (provider === 'mock') return '';
  if (provider === 'none') return 'AI 功能暂未启用：后端未配置。词典、我的词汇、学习、导入导出都可以正常使用。';
  if (!isOnline()) return '需要联网使用 AI 功能';
  if (state.ai.status === 'unknown') return '正在检查 AI 功能……';
  if (provider === 'openai') return '自带 Key 模式未配置密钥';
  return state.ai.message || 'AI 功能暂未启用';
}

export function ttsBackendReady() {
  const provider = TTSService.getSettings().provider;
  if (provider === 'device') return false;
  if (provider === 'none') return false;
  return isOnline() && state.tts.configured;
}

export function texts() {
  const ai = state.ai;
  return {
    aiReady: isAIAvailable(),
    aiLabel: isAIAvailable() ? 'AI 已启用' : 'AI 功能暂未启用',
    aiDetail: ai.message,
    ttsLabel: ttsBackendReady() ? '神经网络语音已启用' : '使用设备内置语音'
  };
}

export const capabilityService = { refresh, hydrate, snapshot, isAIAvailable, aiUnavailableReason, ttsBackendReady, texts };
