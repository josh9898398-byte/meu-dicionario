/**
 * DictionaryService — search, lookup and tap-to-look-up for pt-BR content.
 *
 * Data flow:
 *   IndexedDB (dictionaryEntries/words/phrases)
 *     -> in-memory index (built once, updated incrementally)
 *       -> lookup / search / phrase matching used by the UI and AI services
 *
 * The dictionary layer is read-mostly and fully replaceable; personal data lives
 * in a different store set (see db/schema.js).
 */

import { dictionaryRepo, exampleRepo, favoriteRepo } from '../db/repos.js';
import {
  normalizeText, normalizeKey, guessLemmaForm, similarity, wordTokens, makeEntryId
} from './normalizer.js';
import { LIMITS } from '../config.js';

const state = {
  ready: false,
  entries: [],
  byNorm: new Map(),
  byKey: new Map(),
  byId: new Map(),
  zhIndex: [],
  headwords: [],
  sources: new Map(),
  wordRows: [],
  phraseRows: []
};

export const MATCH = {
  EXACT: 'exact',
  NORMALIZED: 'normalized',
  PREFIX: 'prefix',
  WORD: 'word',
  CONTAINS: 'contains',
  FUZZY: 'fuzzy',
  CHINESE: 'chinese',
  FAVORITE: 'favorite'
};

const SCORE = {
  [MATCH.EXACT]: 1000,
  [MATCH.NORMALIZED]: 900,
  [MATCH.PREFIX]: 720,
  [MATCH.WORD]: 560,
  [MATCH.CHINESE]: 500,
  [MATCH.CONTAINS]: 360,
  [MATCH.FUZZY]: 200,
  [MATCH.FAVORITE]: 80
};

export async function init(force = false) {
  if (state.ready && !force) return state;
  const [entries, words, phrases] = await Promise.all([
    dictionaryRepo.all(),
    dictionaryRepo.allWords(),
    dictionaryRepo.allPhrases()
  ]);
  rebuild(entries, words, phrases);
  return state;
}

function rebuild(entries, words, phrases) {
  state.entries = entries || [];
  state.byNorm = new Map();
  state.byKey = new Map();
  state.byId = new Map();
  state.zhIndex = [];
  state.sources = new Map();

  const headwords = new Set();
  for (const entry of state.entries) {
    addToIndexes(entry);
    headwords.add(normalizeText(entry.headword));
    if (entry.source?.id) state.sources.set(entry.source.id, entry.source);
  }
  // `words` / `phrases` are lookup accelerators maintained alongside entries.
  state.wordRows = words || [];
  state.phraseRows = phrases || [];
  state.headwords = Array.from(headwords).filter(Boolean).sort();
  state.ready = true;
}

function addToIndexes(entry) {
  const norm = entry.normalizedWord || normalizeText(entry.headword);
  const key = normalizeKey(entry.headword);
  if (!state.byNorm.has(norm)) state.byNorm.set(norm, []);
  state.byNorm.get(norm).push(entry);
  if (!state.byKey.has(key)) state.byKey.set(key, []);
  state.byKey.get(key).push(entry);
  state.byId.set(entry.id, entry);
  state.zhIndex.push({ entry, haystack: buildChineseHaystack(entry) });
}

function buildChineseHaystack(entry) {
  const parts = [
    ...(entry.translations || []),
    ...(entry.meanings || []).map((m) => (typeof m === 'string' ? m : `${m.definition || ''} ${m.note || ''}`)),
    entry.translation || '',
    entry.notes || ''
  ];
  return parts.join(' ').toLowerCase();
}

/** Invalidate + lazily rebuild after imports / pack install / deletes. */
export async function refresh() {
  state.ready = false;
  return init(true);
}

export function isReady() { return state.ready; }

export function stats() {
  const byType = {};
  for (const entry of state.entries) byType[entry.type] = (byType[entry.type] || 0) + 1;
  return {
    total: state.entries.length,
    byType,
    sources: Array.from(state.sources.values()),
    words: state.wordRows?.length || 0,
    phrases: state.phraseRows?.length || 0
  };
}

export function sources() {
  return Array.from(state.sources.values());
}

/* ------------------------------------------------------------------ lookup */

export function lookupSync(text, { lemma = true } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const norm = normalizeText(raw);
  const key = normalizeKey(raw);
  const direct = state.byNorm.get(norm) || state.byKey.get(key);
  if (direct?.length) return pickBest(direct, raw);
  if (lemma) {
    const guessed = guessLemmaForm(raw);
    if (guessed && normalizeText(guessed) !== norm) {
      const rows = state.byNorm.get(normalizeText(guessed)) || state.byKey.get(normalizeKey(guessed));
      if (rows?.length) return pickBest(rows, raw);
    }
  }
  return null;
}

export async function lookup(text, options) {
  await init();
  const found = lookupSync(text, options);
  if (found) return found;
  // last resort: repo lookup (covers entries where the memory index missed)
  const row = await dictionaryRepo.findByHeadword(text);
  return row ?? null;
}

function pickBest(rows, query) {
  if (rows.length === 1) return rows[0];
  const norm = normalizeText(query);
  const exact = rows.filter((r) => normalizeText(r.headword) === norm);
  const pool = exact.length ? exact : rows;
  return pool.slice().sort((a, b) => {
    const rankA = a.frequencyRank ?? 999999;
    const rankB = b.frequencyRank ?? 999999;
    if (rankA !== rankB) return rankA - rankB;
    return (b.quality ?? 0) - (a.quality ?? 0);
  })[0];
}

/**
 * Longest known phrase starting at token index `i`.
 * When the user taps a word inside a sentence we first try the surrounding
 * multi-word expression ("dar conta de"), then fall back to the single word.
 */
export async function matchPhraseAt(tokens, index, { maxSpan = 5 } = {}) {
  await init();
  const lower = tokens.map((t) => normalizeText(t));
  const lemma = guessLemmaForm(lower[index] || '');
  for (let span = Math.min(maxSpan, lower.length - index); span >= 1; span -= 1) {
    const slice = lower.slice(index, index + span);
    const candidates = new Set([slice.join(' ').trim()]);
    // "dou conta" should still find the entry "dar conta"
    if (lemma && lemma !== slice[0]) {
      candidates.add([normalizeText(lemma), ...slice.slice(1)].join(' ').trim());
    }
    for (const phrase of candidates) {
      if (!phrase) continue;
      const rows = state.byNorm.get(phrase) || state.byKey.get(normalizeKey(phrase));
      if (rows?.length) return { entry: pickBest(rows, phrase), span };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ search */

/**
 * Ranked search across Portuguese headwords AND Chinese meanings.
 * Returns [{ entry, score, matchType }]
 */
export async function search(query, { limit = LIMITS.searchResults, types = null } = {}) {
  await init();
  const raw = String(query || '').trim();
  if (!raw) return [];
  const norm = normalizeText(raw);
  const key = normalizeKey(raw);
  const isChineseQuery = /[\u3400-\u4dbf\u4e00-\u9fff]/.test(raw);
  const results = new Map();

  const push = (entry, matchType, extra = 0) => {
    if (!entry) return;
    if (types && !types.includes(entry.type)) return;
    const score = SCORE[matchType] + extra;
    const current = results.get(entry.id);
    if (!current || current.score < score) results.set(entry.id, { entry, score, matchType });
  };

  if (isChineseQuery) {
    const q = raw.toLowerCase();
    for (const { entry, haystack } of state.zhIndex) {
      if (!haystack) continue;
      const idx = haystack.indexOf(q);
      if (idx === -1) continue;
      const exactMeaning = (entry.translations || []).some((t) => String(t).trim() === raw);
      push(entry, MATCH.CHINESE, exactMeaning ? 200 : idx === 0 ? 80 : 0);
    }
  } else {
    for (const entry of state.byNorm.get(norm) || []) {
      push(entry, normalizeText(entry.headword) === norm ? MATCH.EXACT : MATCH.NORMALIZED, 40);
    }
    for (const entry of state.byKey.get(key) || []) push(entry, MATCH.NORMALIZED, 20);

    for (const entry of state.entries) {
      const head = normalizeText(entry.headword);
      if (!head || head === norm) continue;
      if (head.startsWith(norm)) {
        push(entry, MATCH.PREFIX, entry.type === 'word' ? 60 : 0);
        continue;
      }
      const words = head.split(' ');
      if (words.some((w) => w.startsWith(norm))) push(entry, MATCH.WORD, 0);
      else if (norm.length >= 3 && head.includes(norm)) push(entry, MATCH.CONTAINS, 0);
    }

    if (results.size < 6 && norm.length >= 4) {
      const scored = [];
      for (const entry of state.entries) {
        const head = normalizeText(entry.headword);
        if (!head) continue;
        const first = head.split(' ')[0];
        if (Math.abs(first.length - norm.length) > 2) continue;
        const sim = similarity(first, norm);
        if (sim >= 0.74) scored.push({ entry, sim });
      }
      scored.sort((a, b) => b.sim - a.sim);
      for (const { entry, sim } of scored.slice(0, 8)) push(entry, MATCH.FUZZY, Math.round(sim * 100));
    }
  }

  // Personal vocabulary is surfaced in the same box: "search everything I saved".
  if (!isChineseQuery) {
    const favorites = await favoriteRepo.all();
    for (const fav of favorites) {
      const text = fav.normalizedText || normalizeText(fav.customText);
      if (!text) continue;
      if (text === norm || normalizeKey(fav.customText) === key) {
        push(favoriteToEntryShim(fav), MATCH.FAVORITE, 0);
      }
    }
  }

  return Array.from(results.values())
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const rankA = a.entry.frequencyRank ?? 999999;
      const rankB = b.entry.frequencyRank ?? 999999;
      if (rankA !== rankB) return rankA - rankB;
      return String(a.entry.headword).localeCompare(String(b.entry.headword), 'pt-BR');
    })
    .slice(0, limit);
}

function favoriteToEntryShim(fav) {
  return {
    id: `favview:${fav.id}`,
    headword: fav.headword || fav.customText,
    normalizedWord: fav.normalizedText,
    type: fav.type || 'word',
    language: 'pt-BR',
    partOfSpeech: fav.partOfSpeech,
    translations: fav.translation ? [fav.translation] : [],
    meanings: fav.meanings || [],
    collocations: fav.collocations || [],
    patterns: fav.patterns || [],
    examples: fav.examples || [],
    tags: fav.tags || [],
    source: { id: 'personal', name: '我的词汇', license: 'user' },
    isPersonal: true,
    favoriteId: fav.id,
    updatedAt: fav.updatedAt
  };
}

export async function suggest(query, limit = LIMITS.searchSuggestions) {
  const results = await search(query, { limit: limit * 2 });
  return results.slice(0, limit).map((r) => ({
    id: r.entry.id,
    headword: r.entry.headword,
    translation: (r.entry.translations || [])[0] || '',
    type: r.entry.type,
    matchType: r.matchType,
    isPersonal: Boolean(r.entry.isPersonal),
    favoriteId: r.entry.favoriteId || null
  }));
}

/* --------------------------------------------------------------- mutations */

export function createEntryFromInput({
  headword,
  partOfSpeech = '',
  translations = [],
  meanings = [],
  examples = [],
  collocations = [],
  patterns = [],
  relatedExpressions = [],
  usageNotes = [],
  tags = [],
  difficulty = '',
  type = null,
  source = { id: 'user', name: '我添加的', license: 'user' },
  packId = 'user',
  pronunciation = null,
  frequencyRank = null,
  notes = ''
}) {
  const timestamp = Date.now();
  const normalizedWord = normalizeText(headword);
  return {
    id: makeEntryId(normalizedWord, source?.id || 'user'),
    headword: String(headword || '').trim(),
    normalizedWord,
    language: 'pt-BR',
    type,
    partOfSpeech,
    translations,
    meanings,
    examples: (examples || []).map((ex) => ({
      id: ex.id || null,
      sourceText: ex.sourceText || ex.pt || '',
      translation: ex.translation || ex.zh || '',
      note: ex.note || '',
      source: ex.source || source?.name || 'user',
      audioUrl: ex.audioUrl ?? null,
      cachedAudio: ex.cachedAudio ?? null
    })),
    collocations,
    patterns,
    relatedExpressions,
    usageNotes,
    tags,
    difficulty,
    notes,
    pronunciation,
    frequencyRank,
    source,
    packId,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

export async function upsertEntries(entries, options) {
  const result = await dictionaryRepo.upsertMany(entries, options);
  await refresh();
  return result;
}

export async function attachExamples(entryId, examples) {
  const entry = await dictionaryRepo.get(entryId);
  if (!entry) return null;
  const merged = [...(entry.examples || []), ...examples];
  const deduped = [];
  const seen = new Set();
  for (const ex of merged) {
    const key = normalizeText(ex.sourceText || ex.pt || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(ex);
  }
  const record = { ...entry, examples: deduped, updatedAt: Date.now() };
  await dictionaryRepo.upsertMany([record], { onConflict: 'replace' });
  await exampleRepo.addForEntry(entryId, examples);
  await refresh();
  return record;
}

export async function removeEntry(id) {
  await dictionaryRepo.remove(id);
  await refresh();
}

/** Convert a dictionary entry into a personal notebook record. */
export function entryToFavoriteInput(entry, { source = 'dictionary' } = {}) {
  return {
    dictionaryEntryId: entry.isPersonal ? null : entry.id,
    customText: entry.headword,
    headword: entry.headword,
    type: entry.type || 'word',
    translation: (entry.translations || [])[0] || '',
    meanings: entry.meanings || [],
    partOfSpeech: entry.partOfSpeech || '',
    collocations: entry.collocations || [],
    patterns: entry.patterns || [],
    relatedExpressions: entry.relatedExpressions || [],
    usageNotes: entry.usageNotes || [],
    examples: (entry.examples || []).map((ex, i) => ({
      id: `${entry.id}#fav${i}`,
      sourceText: ex.sourceText || ex.pt || '',
      translation: ex.translation || ex.zh || '',
      note: ex.note || '',
      source: ex.source || entry.source?.name || 'dictionary',
      audioUrl: ex.audioUrl ?? null
    })),
    tags: entry.tags || [],
    difficulty: entry.difficulty || '',
    pronunciation: entry.pronunciation || null,
    source,
    sourceRef: entry.source?.name || ''
  };
}

/** Tokens for a clickable sentence (punctuation stays inert). */
export function tokenizeForDisplay(sentence) {
  const tokens = wordTokens(sentence);
  const text = String(sentence || '');
  const out = [];
  let cursor = 0;
  for (const token of tokens) {
    const idx = text.indexOf(token, cursor);
    if (idx === -1) continue;
    if (idx > cursor) out.push({ type: 'sep', text: text.slice(cursor, idx) });
    out.push({ type: 'word', text: token });
    cursor = idx + token.length;
  }
  if (cursor < text.length) out.push({ type: 'sep', text: text.slice(cursor) });
  return out;
}

export function allEntriesSync() { return state.entries; }

export { normalizeText, normalizeKey };

export const dictionaryService = {
  init, refresh, isReady, stats, sources,
  lookup, lookupSync, matchPhraseAt, search, suggest,
  createEntryFromInput, upsertEntries, attachExamples, removeEntry,
  entryToFavoriteInput, tokenizeForDisplay, allEntriesSync, MATCH
};
