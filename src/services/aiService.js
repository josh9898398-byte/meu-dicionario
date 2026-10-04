/**
 * AIService — structured vocabulary analysis.
 *
 *   AIService.analyzeVocabulary("dar conta") -> structured JSON
 *   AIService.explainSentence("Eu não estou dando conta disso.")
 *
 * The UI NEVER receives a raw text blob: every response is parsed, validated
 * and normalized into a fixed shape (see NORMALIZED_SHAPE below), so the rest
 * of the app can depend on it and future providers stay swappable.
 *
 * Transports:
 *   proxy  : POST aiProxyUrl (ships as api/ai.js) — key stays on the server
 *   openai : direct browser call with the user's own key (OpenAI compatible)
 *   mock   : clearly labelled, deterministic offline sample data for development
 *   none   : disabled
 *
 * OFFLINE CONTRACT: with no network, AI calls throw AIError('offline') and the
 * UI shows 需要联网使用 AI 功能. Nothing pretends to work offline.
 */

import { settingsRepo } from '../db/repos.js';
import { deployConfig, resolveAppUrl } from '../config.js';
import { isOnline } from './connectivityService.js';
import { normalizeText, detectType } from './normalizer.js';

export class AIError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'AIError';
    this.code = code;
    this.details = details;
  }
}

const DEFAULTS = {
  provider: 'auto',            // auto | proxy | mock | none  (openai = 高级「自带 Key」模式)
  proxyUrl: deployConfig.aiProxyUrl,
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.3,
  maxExamples: 8,
  translateTo: 'zh-CN'
};

let settings = { ...DEFAULTS };
const memoryCache = new Map();
const MAX_CACHE = 100;

export const NORMALIZED_SHAPE = {
  text: 'string',
  language: 'pt-BR',
  type: 'word|phrase|expression|sentence',
  headword: 'string',
  partOfSpeech: 'string',
  translations: 'string[]',
  meanings: '{definition,note}[]',
  patterns: 'string[]',
  collocations: 'string[]',
  examples: '{sourceText,translation,note}[]',
  keyExpressions: '{text,translation,type,note}[]',
  relatedExpressions: 'string[]',
  usageNotes: 'string[]',
  difficulty: 'A1..C2|unknown',
  tags: 'string[]',
  pronunciation: '{ipa,syllables}|null',
  grammar: 'string'
};

export async function init() {
  const saved = (await settingsRepo.get('ai')) || {};
  settings = { ...DEFAULTS, ...saved };
  return settings;
}

export async function configure(patch) {
  settings = { ...settings, ...patch };
  await settingsRepo.set('ai', settings);
  return settings;
}

export function getSettings() {
  return { ...settings };
}

export function resolveProvider(requested = settings.provider) {
  if (requested && requested !== 'auto') return requested;
  // 'auto' always means "my own backend". We never silently switch to mock
  // data: if the backend is missing the UI says 「AI 功能暂未启用」 and the rest
  // of the app keeps working. Mock data must be selected explicitly (advanced).
  if (settings.proxyUrl) return 'proxy';
  if (settings.apiKey) return 'openai';
  return 'none';
}

export function status() {
  const provider = resolveProvider();
  return {
    provider,
    online: isOnline(),
    configured: provider === 'mock'
      ? true
      : Boolean(provider === 'proxy' ? settings.proxyUrl : settings.apiKey),
    model: provider === 'proxy' ? 'server-configured' : settings.model,
    isMock: provider === 'mock',
    settings: getSettings()
  };
}

/** True when a real (non-mock) AI backend is reachable through the proxy. */
export function usesBackend() {
  return resolveProvider() === 'proxy';
}

export function proxyBase() {
  return resolveAppUrl((settings.proxyUrl || deployConfig.aiProxyUrl || '/api/ai').replace(/\/$/, ''));
}

export function statusUrl() {
  return `${proxyBase()}/status`;
}

/* --------------------------------------------------------------- analysis */

const SYSTEM_PROMPT = `Você é um lexicógrafo especialista em português brasileiro (pt-BR) que ensina alunos chineses.

Analise o texto do usuário e responda SOMENTE com um objeto JSON válido, sem markdown, sem comentários.

Regras obrigatórias:
1. Use português do Brasil. NUNCA use construções típicas de Portugal (evite "tu" conjugado, "casa de banho", "pequeno-almoço", "autocarro", "telemóvel" quando o Brasil usa "celular").
2. Os exemplos devem ser frases naturais do dia a dia no Brasil. Inclua contextos de trabalho, família, amigos e internet quando fizer sentido.
3. A tradução chinesa deve corresponder exatamente ao sentido da frase em pt-BR.
4. Gere entre 5 e 8 exemplos. Qualidade > quantidade. Não invente frases estranhas.
5. Identifique corretamente o tipo: "word" (uma palavra), "phrase" (locução curta), "expression" (expressão idiomática/gíria), "sentence" (frase completa).
6. Se o usuário enviar uma frase completa, extraia a expressão central e explique a gramática.

Formato exato do JSON:
{
  "text": "texto original do usuário",
  "language": "pt-BR",
  "type": "word|phrase|expression|sentence",
  "headword": "forma canônica (infinitivo para verbos)",
  "partOfSpeech": "substantivo|verbo|adjetivo|advérbio|expressão|locução|preposição|pronome|interjeição",
  "translations": ["traduções curtas em chinês separadas por sentido"],
  "meanings": [{"definition": "explicação em chinês", "note": "observação curta em chinês"}],
  "patterns": ["estruturas gramaticais, ex: dar conta de algo"],
  "collocations": ["combinações frequentes"],
  "examples": [{"sourceText": "frase em pt-BR", "translation": "tradução em chinês", "note": "contexto em chinês"}],
  "relatedExpressions": ["expressões parecidas, em pt-BR"],
  "usageNotes": ["dica de uso em chinês: registro, formalidade, região"],
  "difficulty": "A1|A2|B1|B2|C1|C2",
  "tags": ["tags curtas em chinês, ex: 口语, 工作, 日常"],
  "pronunciation": {"ipa": "", "syllables": ""},
  "grammar": "explicação gramatical curta em chinês"
}`;

export async function analyzeVocabulary(text, options = {}) {
  const input = String(text || '').trim();
  if (!input) throw new AIError('empty', '请输入要分析的内容');
  const provider = resolveProvider(options.provider);
  if (provider === 'none') {
    throw new AIError('not-enabled', 'AI 功能暂未启用：请在「设置 → 高级设置 → AI」中配置后端服务。');
  }

  const cacheKey = `${provider}:${normalizeText(input)}`;
  if (!options.force && memoryCache.has(cacheKey)) {
    return { ...memoryCache.get(cacheKey), cached: true };
  }
  if (provider !== 'mock' && !isOnline()) {
    throw new AIError('offline', '需要联网使用 AI 功能', { provider });
  }

  const userPrompt = [
    `Texto: """${input}"""`,
    options.context ? `Contexto de onde veio: ${options.context}` : '',
    options.source ? `Fonte declarada: ${options.source}` : '',
    `Máximo de exemplos: ${settings.maxExamples}`,
    options.sentenceMode ? 'O usuário enviou uma FRASE: extraia a expressão central e explique a gramática.' : ''
  ].filter(Boolean).join('\n');

  let raw;
  if (provider === 'mock') {
    raw = mockAnalysis(input, options);
  } else {
    raw = await callProvider(provider, [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ], { ...options, task: options.purpose === 'examples' ? 'examples' : (options.sentenceMode ? 'explainSentence' : 'analyzeVocabulary') });
  }

  const normalized = normalizeAnalysis(raw, input, options);
  memoryCache.set(cacheKey, normalized);
  if (memoryCache.size > MAX_CACHE) memoryCache.delete(memoryCache.keys().next().value);
  return { ...normalized, cached: false };
}

export async function explainSentence(sentence, options = {}) {
  return analyzeVocabulary(sentence, { ...options, sentenceMode: true, context: options.context || '来自真实语境的句子' });
}

/** Generate more examples for an existing entry (used by the entry page). */
export async function generateExamples(text, options = {}) {
  return analyzeVocabulary(text, { ...options, purpose: 'examples' });
}

export async function translate(text, options = {}) {
  const result = await analyzeVocabulary(text, options);
  return {
    text: result.text,
    translations: result.translations,
    meanings: result.meanings
  };
}

/** Suggest tags for an existing entry (used by the notebook bulk tools). */
export async function suggestTags(text, options = {}) {
  const result = await analyzeVocabulary(text, options);
  return result.tags || [];
}

/* --------------------------------------------------------------- transport */

async function callProvider(provider, messages, options = {}) {
  const attempt = async (msgs) => {
    if (provider === 'proxy') return callProxy(msgs, options);
    if (provider === 'openai') return callOpenAI(msgs, options);
    throw new AIError('no-provider', `未知的 AI 提供方：${provider}`);
  };

  const first = await attempt(messages);
  let parsed = tryParseJson(first);
  if (parsed) return parsed;

  // one repair round-trip, then fail loudly
  const repair = await attempt([
    ...messages,
    { role: 'assistant', content: String(first).slice(0, 4000) },
    { role: 'user', content: 'Sua resposta não era JSON válido. Responda novamente APENAS com o objeto JSON, sem texto extra.' }
  ]);
  parsed = tryParseJson(repair);
  if (parsed) return parsed;
  throw new AIError('invalid-json', 'AI 返回的内容不是有效 JSON，请重试或更换模型', { preview: String(repair).slice(0, 400) });
}

async function callProxy(messages, options = {}) {
  const base = resolveAppUrl((options.proxyUrl || settings.proxyUrl || deployConfig.aiProxyUrl || '/api/ai').replace(/\/$/, ''));
  if (!base) throw new AIError('not-enabled', 'AI 功能暂未启用：未配置后端地址');

  const taskRoute = {
    analyzeVocabulary: '/analyze',
    explainSentence: '/explain',
    examples: '/examples'
  }[options.task || 'analyzeVocabulary'] || '/analyze';

  const post = async (url) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: options.task || 'analyzeVocabulary',
        messages,
        temperature: settings.temperature,
        responseFormat: 'json',
        locale: 'pt-BR'
      })
    });
    return res;
  };

  let res;
  try {
    res = await post(`${base}${taskRoute}`);
    // Backwards compatibility: older deployments only expose POST /api/ai
    if (res.status === 404 || res.status === 405) res = await post(base);
  } catch (err) {
    throw new AIError('network', '无法连接 AI 服务，请检查网络', { cause: String(err) });
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 404 || res.status === 501) {
      throw new AIError('not-enabled',
        'AI 功能暂未启用。应用的其他功能不受影响；需要 AI 时请在「设置 → 高级设置 → AI」中配置后端服务。',
        { status: res.status, detail: detail.slice(0, 300) });
    }
    throw new AIError('http', `AI 服务返回 ${res.status}`, { detail: detail.slice(0, 400) });
  }
  const type = res.headers.get('Content-Type') || '';
  if (type.includes('application/json')) {
    const data = await res.json();
    if (data?.content) return data.content;
    if (data?.choices?.[0]?.message?.content) return data.choices[0].message.content;
    return JSON.stringify(data);
  }
  return res.text();
}

async function callOpenAI(messages, options = {}) {
  if (!settings.apiKey) throw new AIError('not-configured', '未配置 API Key');
  const base = (options.baseUrl || settings.baseUrl || '').replace(/\/$/, '');
  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: settings.temperature,
        response_format: { type: 'json_object' },
        messages
      })
    });
  } catch (err) {
    throw new AIError('network', '无法连接 AI 服务，请检查网络', { cause: String(err) });
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new AIError('http', `AI 服务返回 ${res.status}`, { detail: detail.slice(0, 400) });
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content ?? '';
}

function tryParseJson(text) {
  if (!text) return null;
  if (typeof text === 'object') return text;
  let s = String(text).trim();
  if (s.startsWith('```')) s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(s); } catch { /* try to salvage */ }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(s.slice(start, end + 1)); } catch { return null; }
  }
  return null;
}

/* -------------------------------------------------------------- validation */

function asArray(value, mapper = (v) => v) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map(mapper).filter((v) => v !== null && v !== undefined && v !== '');
}

function asString(value, fallback = '') {
  if (value === null || value === undefined) return fallback;
  return typeof value === 'string' ? value : String(value);
}

/**
 * Coerce an arbitrary provider response into the fixed shape.
 * Unknown/missing fields become empty arrays/strings — never `undefined`.
 */
export function normalizeAnalysis(raw, inputText, options = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const type = ['word', 'phrase', 'expression', 'sentence'].includes(source.type)
    ? source.type
    : (options.type || detectType(inputText));

  const examples = asArray(source.examples, (ex) => {
    if (!ex) return null;
    if (typeof ex === 'string') return { sourceText: ex.trim(), translation: '', note: '' };
    const pt = asString(ex.sourceText || ex.pt || ex.sentence || ex.portuguese).trim();
    if (!pt) return null;
    return {
      sourceText: pt,
      translation: asString(ex.translation || ex.zh || ex.chinese).trim(),
      note: asString(ex.note || ex.context || ex.usage).trim()
    };
  }).slice(0, options.maxExamples || settings.maxExamples || 8);

  const meanings = asArray(source.meanings, (m) => {
    if (!m) return null;
    if (typeof m === 'string') return { definition: m.trim(), note: '' };
    const definition = asString(m.definition || m.meaning || m.zh || m.translation).trim();
    if (!definition) return null;
    return { definition, note: asString(m.note || m.example || '').trim() };
  });

  const translations = asArray(source.translations || source.translation, (t) => asString(t).trim());

  const pronunciation = source.pronunciation && typeof source.pronunciation === 'object'
    ? {
        ipa: asString(source.pronunciation.ipa).trim(),
        syllables: asString(source.pronunciation.syllables || source.pronunciation.syllabification).trim()
      }
    : null;

  const keyExpressions = asArray(source.keyExpressions || source.keyItems || source.learnItems, (item) => {
    if (!item) return null;
    if (typeof item === 'string') {
      const text = item.trim();
      return text ? { text, translation: '', type: 'expression', note: '' } : null;
    }
    const text = asString(item.text || item.expression || item.pt || item.headword).trim();
    if (!text) return null;
    const type = ['word', 'phrase', 'expression', 'sentence'].includes(item.type) ? item.type : 'expression';
    return {
      text,
      translation: asString(item.translation || item.zh || item.chinese).trim(),
      type,
      note: asString(item.note || item.usage || item.comment).trim()
    };
  }).slice(0, 6);

  return {
    text: asString(source.text, inputText).trim() || inputText,
    language: 'pt-BR',
    type,
    headword: asString(source.headword || source.lemma, inputText).trim() || inputText,
    partOfSpeech: asString(source.partOfSpeech || source.pos).trim(),
    translations: translations.length ? translations : meanings.map((m) => m.definition),
    meanings,
    patterns: asArray(source.patterns || source.structures, (v) => asString(v).trim()),
    collocations: asArray(source.collocations || source.combinations, (v) => asString(v).trim()),
    examples,
    relatedExpressions: asArray(source.relatedExpressions || source.related, (v) => asString(v).trim()),
    usageNotes: asArray(source.usageNotes || source.notes, (v) => asString(v).trim()),
    keyExpressions,
    difficulty: asString(source.difficulty, 'unknown').trim() || 'unknown',
    tags: asArray(source.tags, (v) => asString(v).trim()).slice(0, 8),
    pronunciation,
    grammar: asString(source.grammar || source.grammarNotes).trim(),
    provider: asString(source.provider),
    generatedAt: Date.now()
  };
}

/* -------------------------------------------------------------- mock mode */

/**
 * Deterministic, clearly-labelled development data.
 * It is NEVER presented as AI output: the UI shows a yellow
 * "示例数据（非 AI）" badge whenever provider === 'mock'.
 */
function mockAnalysis(input, options = {}) {
  const type = options.sentenceMode ? 'sentence' : detectType(input);
  const head = String(input).trim().toLowerCase();
  const tail = head.split(/\s+/).slice(-2).join(' ');
  const keyExpressions = type === 'sentence' && tail
    ? [{ text: tail, translation: '【示例】句子里的关键表达', type: 'phrase', note: 'mock 数据，仅用于验证流程' }]
    : [];
  return {
    text: input,
    language: 'pt-BR',
    type,
    headword: head,
    partOfSpeech: type === 'word' ? 'verbo' : 'locução',
    translations: [`【示例】${head} 的中文释义`],
    meanings: [
      { definition: `【示例数据】${head} 的释义。配置真实 AI 后会替换为准确内容。`, note: '这是 mock provider 生成的占位数据，不是 AI 结果。' }
    ],
    patterns: [`${head} de algo`, `${head} para fazer algo`],
    collocations: [`${head} muito`, `${head} bem`],
    examples: [
      { sourceText: `Eu preciso ${head} hoje.`, translation: `我今天需要${head}。`, note: '示例数据' },
      { sourceText: `Você consegue ${head} amanhã?`, translation: `你明天能${head}吗？`, note: '示例数据' },
      { sourceText: `A gente vai ${head} depois do trabalho.`, translation: `我们下班后会${head}。`, note: '示例数据' }
    ],
    relatedExpressions: [],
    usageNotes: ['【示例数据】请到「设置 → AI」配置真实服务后重新分析。'],
    keyExpressions,
    difficulty: 'unknown',
    tags: ['示例数据'],
    grammar: '',
    provider: 'mock'
  };
}

export function clearCache() {
  memoryCache.clear();
}

export const AIService = {
  init, configure, getSettings, status, resolveProvider,
  proxyBase, statusUrl, usesBackend,
  analyzeVocabulary, explainSentence, generateExamples, translate, suggestTags,
  clearCache, AIError, NORMALIZED_SHAPE
};
