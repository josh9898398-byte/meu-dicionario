/**
 * Shared request handlers for the AI and TTS proxies.
 *
 * SECURITY MODEL (important):
 *   iPhone PWA  →  this endpoint (your server)  →  OpenAI / Azure / …
 *
 * The provider key lives ONLY in the server environment (`OPENAI_API_KEY`, …).
 * It is never embedded in the frontend bundle, never sent to the browser and
 * never readable by the client. The client only receives structured JSON and
 * audio bytes.
 */

import { SYSTEM_PROMPT, TASK_PROMPTS, callOpenAICompatible, errorResponse, json, corsHeaders, readJson } from './_shared.js';

const AI_TASKS = new Set(['analyzeVocabulary', 'explainSentence', 'examples']);

export function aiStatusPayload() {
  const configured = Boolean(process.env.OPENAI_API_KEY);
  return {
    ok: true,
    service: 'meu-dicionario-ptbr',
    feature: 'ai',
    // The browser only learns *whether* AI is available — never the key.
    configured,
    model: configured ? (process.env.AI_MODEL || 'gpt-4o-mini') : null,
    tasks: Array.from(AI_TASKS),
    message: configured
      ? 'AI 已就绪'
      : 'AI 功能暂未启用：服务器未配置 OPENAI_API_KEY。词典、我的词汇、学习、导入导出、已缓存音频全部可正常使用。'
  };
}

export async function handleAIRequest(request, { task: fixedTask = null } = {}) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method === 'GET') return json(aiStatusPayload());
  if (request.method !== 'POST') return errorResponse('method-not-allowed', 'Use POST', 405);

  const body = await readJson(request);
  if (!body) return errorResponse('invalid-json', '请求体不是有效 JSON');

  const task = fixedTask || body.task || 'analyzeVocabulary';
  if (!AI_TASKS.has(task)) return errorResponse('unknown-task', `未知任务：${task}`, 400);

  const status = aiStatusPayload();
  if (!status.configured) {
    // 501 = "not implemented on this server": the client shows
    // 「AI 功能暂未启用」and keeps every offline feature working.
    return errorResponse('not-configured', status.message, 501);
  }

  if (process.env.AI_SHARED_SECRET && request.headers.get('x-app-secret') !== process.env.AI_SHARED_SECRET) {
    return errorResponse('unauthorized', '密钥不匹配', 401);
  }

  const messages = Array.isArray(body.messages) && body.messages.length
    ? [...body.messages]
    : [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: String(body.text || '') }
      ];
  if (!messages.some((m) => m.role === 'system')) messages.unshift({ role: 'system', content: SYSTEM_PROMPT });
  else messages[0] = { role: 'system', content: `${SYSTEM_PROMPT}\n\n${TASK_PROMPTS[task] || ''}` };

  try {
    const content = await callOpenAICompatible({
      messages,
      model: body.model || process.env.AI_MODEL || 'gpt-4o-mini',
      temperature: typeof body.temperature === 'number' ? body.temperature : 0.3,
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.AI_BASE_URL || 'https://api.openai.com/v1'
    });
    return json({ content, task, model: status.model });
  } catch (err) {
    return errorResponse('upstream-error', err.message || 'AI 服务调用失败', err.status && err.status >= 500 ? 502 : 400, err.detail);
  }
}

export function ttsStatusPayload() {
  const provider = (process.env.TTS_PROVIDER || detectTtsProvider()).toLowerCase();
  return {
    ok: true,
    service: 'meu-dicionario-ptbr',
    feature: 'tts',
    provider: provider || null,
    locale: 'pt-BR',
    configured: isTtsConfigured(provider),
    voice: process.env.TTS_VOICE || DEFAULT_VOICE[provider] || null,
    message: isTtsConfigured(provider)
      ? '语音服务已就绪（巴西葡语神经网络语音）'
      : '神经网络语音暂未启用：将使用设备内置 pt-BR 语音（普通音质，离线可用）'
  };
}

export async function handleTTSRequest(request) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });
  const status = ttsStatusPayload();
  if (request.method === 'GET') return json(status);
  if (request.method !== 'POST') return errorResponse('method-not-allowed', 'Use POST', 405);

  const body = await readJson(request);
  if (!body) return errorResponse('invalid-json', '请求体不是有效 JSON');
  const text = String(body.text || '').trim();
  if (!text) return errorResponse('empty-text', '缺少 text');
  if (text.length > 2000) return errorResponse('text-too-long', '文本过长（上限 2000 字符）');

  if (!status.configured) return errorResponse('not-configured', status.message, 501);

  const voice = body.voice || status.voice;
  const locale = body.locale || 'pt-BR';

  try {
    const audio = await synthesize({ provider: status.provider, text, voice, locale, rate: body.rate });
    return new Response(audio, {
      status: 200,
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'public, max-age=604800, immutable',
        'X-TTS-Provider': status.provider,
        'X-TTS-Voice': voice || '',
        ...corsHeaders()
      }
    });
  } catch (err) {
    return errorResponse('upstream-error', err.message || 'TTS 生成失败', err.status && err.status >= 500 ? 502 : 400, err.detail);
  }
}

/* -------------------------------------------------------------------------- */

const DEFAULT_VOICE = {
  openai: 'marin',
  elevenlabs: '',
  azure: 'pt-BR-FranciscaNeural',
  google: 'pt-BR-Neural2-A'
};

function detectTtsProvider() {
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ELEVENLABS_API_KEY) return 'elevenlabs';
  if (process.env.AZURE_SPEECH_KEY) return 'azure';
  if (process.env.GOOGLE_TTS_API_KEY) return 'google';
  return '';
}

function isTtsConfigured(provider) {
  switch (provider) {
    case 'openai': return Boolean(process.env.OPENAI_API_KEY);
    case 'elevenlabs': return Boolean(process.env.ELEVENLABS_API_KEY);
    case 'azure': return Boolean(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION);
    case 'google': return Boolean(process.env.GOOGLE_TTS_API_KEY);
    default: return false;
  }
}

async function synthesize({ provider, text, voice, locale, rate }) {
  if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: process.env.TTS_MODEL || 'gpt-4o-mini-tts',
        voice: voice || 'marin',
        input: text,
        response_format: 'mp3',
        instructions: 'Fale em português do Brasil natural, entonação de conversa cotidiana, pronúncia brasileira (não europeia).'
      })
    });
    if (!res.ok) throw Object.assign(new Error(`openai tts ${res.status}`), { status: res.status, detail: (await res.text()).slice(0, 300) });
    return res.arrayBuffer();
  }

  if (provider === 'elevenlabs') {
    const voiceId = process.env.ELEVENLABS_VOICE_ID || voice;
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': process.env.ELEVENLABS_API_KEY, Accept: 'audio/mpeg' },
      body: JSON.stringify({
        text,
        model_id: process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.2, use_speaker_boost: true }
      })
    });
    if (!res.ok) throw Object.assign(new Error(`elevenlabs ${res.status}`), { status: res.status, detail: (await res.text()).slice(0, 300) });
    return res.arrayBuffer();
  }

  if (provider === 'azure') {
    const region = process.env.AZURE_SPEECH_REGION;
    const voiceName = voice || 'pt-BR-FranciscaNeural';
    const ssml = `<speak version="1.0" xml:lang="${locale}"><voice name="${voiceName}"><prosody rate="${rateToPercent(rate)}">${escapeXml(text)}</prosody></voice></speak>`;
    const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': process.env.AZURE_SPEECH_KEY,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'meu-dicionario-ptbr'
      },
      body: ssml
    });
    if (!res.ok) throw Object.assign(new Error(`azure tts ${res.status}`), { status: res.status, detail: (await res.text()).slice(0, 300) });
    return res.arrayBuffer();
  }

  if (provider === 'google') {
    const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${process.env.GOOGLE_TTS_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: locale, name: voice || 'pt-BR-Neural2-A' },
        audioConfig: { audioEncoding: 'MP3', speakingRate: Number(rate) || 1 }
      })
    });
    if (!res.ok) throw Object.assign(new Error(`google tts ${res.status}`), { status: res.status, detail: (await res.text()).slice(0, 300) });
    const data = await res.json();
    const binary = Buffer.from(data.audioContent, 'base64');
    return binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength);
  }

  throw new Error(`unknown provider: ${provider}`);
}

function rateToPercent(rate) {
  const percent = Math.round(((Number(rate) || 1) - 1) * 100);
  return `${percent >= 0 ? '+' : ''}${percent}%`;
}

function escapeXml(text) {
  return String(text).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}
