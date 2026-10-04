/**
 * Repositories: the single place that talks to IndexedDB.
 * Services and UI never touch `idb.*` directly for domain data.
 */

import * as idb from './idb.js';
import { normalizeText, makeEntryId, makeFavoriteId } from '../services/normalizer.js';
import { uid, dayKey } from '../core/format.js';

const now = () => Date.now();

/* ------------------------------------------------------------------ settings */

export const settingsRepo = {
  async get(key, fallback = null) {
    const row = await idb.get('settings', key);
    return row ? row.value : fallback;
  },
  async set(key, value) {
    await idb.put('settings', { key, value, updatedAt: now() });
    return value;
  },
  async all() {
    const rows = await idb.getAll('settings');
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },
  async remove(key) { await idb.remove('settings', key); }
};

/* ------------------------------------------------------- dictionary entries */

export const dictionaryRepo = {
  async get(id) { return idb.get('dictionaryEntries', id); },

  async getByNormalized(normalized) {
    const rows = await idb.getAllByIndex('dictionaryEntries', 'norm', normalized);
    return rows || [];
  },

  async findByHeadword(text) {
    const normalized = normalizeText(text);
    const rows = await idb.getAllByIndex('dictionaryEntries', 'norm', normalized);
    return rows?.[0] ?? null;
  },

  async all() { return idb.getAll('dictionaryEntries'); },

  async count() { return idb.count('dictionaryEntries'); },

  /**
   * Insert or merge entries. Merge only fills gaps (never overwrites curated
   * content with a lower-priority source) — this keeps pack updates safe.
   */
  async upsertMany(entries, { onConflict = 'merge' } = {}) {
    if (!entries?.length) return { added: 0, updated: 0, skipped: 0 };
    const existingByNorm = new Map();
    const norms = Array.from(new Set(entries.map((e) => e.normalizedWord)));
    for (const norm of norms) {
      const rows = await idb.getAllByIndex('dictionaryEntries', 'norm', norm);
      for (const row of rows || []) existingByNorm.set(`${row.source?.id ?? ''}:${row.normalizedWord}`, row);
    }

    const toPut = [];
    const wordRows = [];
    const phraseRows = [];
    let added = 0; let updated = 0; let skipped = 0;

    for (const entry of entries) {
      const key = `${entry.source?.id ?? ''}:${entry.normalizedWord}`;
      const existing = existingByNorm.get(key);
      if (existing) {
        if (onConflict === 'skip') { skipped += 1; continue; }
        if (onConflict === 'replace') {
          toPut.push({ ...entry, id: existing.id, createdAt: existing.createdAt ?? entry.createdAt });
          updated += 1;
          continue;
        }
        const merged = mergeEntry(existing, entry);
        toPut.push(merged);
        updated += 1;
        continue;
      }
      toPut.push(entry);
      added += 1;
      if (entry.type === 'phrase' || entry.type === 'expression') {
        phraseRows.push({
          id: `phrase:${entry.id}`,
          normalized: entry.normalizedWord,
          headword: entry.headword,
          firstToken: String(entry.normalizedWord).split(' ')[0],
          entryId: entry.id,
          type: entry.type,
          meaning: entry.translations?.[0] || entry.meanings?.[0]?.definition || '',
          packId: entry.packId ?? null
        });
      } else {
        wordRows.push({
          id: `word:${entry.id}`,
          normalized: entry.normalizedWord,
          headword: entry.headword,
          entryId: entry.id,
          frequencyRank: entry.frequencyRank ?? null,
          partOfSpeech: entry.partOfSpeech ?? '',
          packId: entry.packId ?? null
        });
      }
    }

    await idb.bulkPut('dictionaryEntries', toPut);
    await idb.bulkPut('words', wordRows);
    await idb.bulkPut('phrases', phraseRows);
    return { added, updated, skipped };
  },

  async removeByPack(packId) {
    const entries = await idb.query('dictionaryEntries', { index: 'packId', range: IDBKeyRange.only(packId) });
    await idb.bulkRemove('dictionaryEntries', entries.map((e) => e.id));
    const words = await idb.getAll('words');
    const phrases = await idb.getAll('phrases');
    await idb.bulkRemove('words', words.filter((w) => w.packId === packId).map((w) => w.id));
    await idb.bulkRemove('phrases', phrases.filter((p) => p.packId === packId).map((p) => p.id));
    return entries.length;
  },

  async remove(id) {
    await idb.remove('dictionaryEntries', id);
    await idb.remove('words', `word:${id}`);
    await idb.remove('phrases', `phrase:${id}`);
  },

  async allWords() { return idb.getAll('words'); },
  async allPhrases() { return idb.getAll('phrases'); },
  async getWordRow(normalized) {
    const rows = await idb.getAllByIndex('words', 'norm', normalized);
    return rows?.[0] ?? null;
  },
  async getPhraseRowsByFirstToken(firstToken) {
    return idb.getAllByIndex('phrases', 'first', firstToken);
  }
};

function mergeEntry(existing, incoming) {
  const pick = (a, b) => (a && (!Array.isArray(a) || a.length) ? a : b);
  return {
    ...incoming,
    id: existing.id,
    createdAt: existing.createdAt ?? incoming.createdAt,
    updatedAt: now(),
    // curated/richer side wins where it exists
    meanings: pick(existing.meanings, incoming.meanings),
    translations: pick(existing.translations, incoming.translations),
    collocations: pick(existing.collocations, incoming.collocations),
    patterns: pick(existing.patterns, incoming.patterns),
    relatedExpressions: pick(existing.relatedExpressions, incoming.relatedExpressions),
    usageNotes: pick(existing.usageNotes, incoming.usageNotes),
    examples: mergeExamples(existing.examples, incoming.examples),
    tags: Array.from(new Set([...(existing.tags || []), ...(incoming.tags || [])])),
    partOfSpeech: existing.partOfSpeech || incoming.partOfSpeech,
    pronunciation: existing.pronunciation || incoming.pronunciation,
    difficulty: existing.difficulty || incoming.difficulty
  };
}

function mergeExamples(a = [], b = []) {
  const seen = new Set();
  const out = [];
  for (const ex of [...(a || []), ...(b || [])]) {
    const key = normalizeText(ex.sourceText || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(ex);
  }
  return out.slice(0, 24);
}

/* ---------------------------------------------------------------- favorites */

export const favoriteRepo = {
  async get(id) { return idb.get('favorites', id); },

  async all() { return idb.getAll('favorites'); },

  async count() { return idb.count('favorites'); },

  async findByText(text) {
    const normalized = normalizeText(text);
    const rows = await idb.getAllByIndex('favorites', 'norm', normalized);
    return rows?.[0] ?? null;
  },

  async findByEntryId(entryId) {
    const rows = await idb.getAllByIndex('favorites', 'entryId', entryId);
    return rows?.[0] ?? null;
  },

  async save(favorite) {
    const record = { ...favorite, updatedAt: now() };
    await idb.put('favorites', record);
    await exampleRepo.replaceForFavorite(record.id, record.examples || []);
    await tagRepo.recountTags(record.tags || []);
    return record;
  },

  async create(input) {
    const timestamp = now();
    const normalized = normalizeText(input.customText || input.headword || '');
    const record = {
      id: input.id || makeFavoriteId(normalized),
      dictionaryEntryId: input.dictionaryEntryId ?? null,
      customText: input.customText ?? input.headword ?? '',
      normalizedText: normalized,
      type: input.type || 'word',
      headword: input.headword ?? input.customText ?? '',
      translation: input.translation ?? '',
      meanings: input.meanings ?? [],
      partOfSpeech: input.partOfSpeech ?? '',
      notes: input.notes ?? '',
      collocations: input.collocations ?? [],
      patterns: input.patterns ?? [],
      relatedExpressions: input.relatedExpressions ?? [],
      usageNotes: input.usageNotes ?? [],
      examples: input.examples ?? [],
      tags: input.tags ?? [],
      difficulty: input.difficulty ?? '',
      pronunciation: input.pronunciation ?? null,
      source: input.source ?? 'manual',
      sourceRef: input.sourceRef ?? '',
      masteryLevel: input.masteryLevel ?? 'new',
      reviewCount: 0,
      correctCount: 0,
      lastReviewedAt: null,
      nextReviewAt: timestamp,
      ease: 2.5,
      intervalDays: 0,
      streak: 0,
      archived: false,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await idb.put('favorites', record);
    await exampleRepo.replaceForFavorite(record.id, record.examples);
    await tagRepo.recountTags(record.tags);
    return record;
  },

  async update(id, patch) {
    const existing = await idb.get('favorites', id);
    if (!existing) throw new Error('未找到该收藏');
    const merged = { ...existing, ...patch, updatedAt: now() };
    if (patch.customText || patch.headword) {
      merged.normalizedText = normalizeText(patch.headword || patch.customText || merged.customText);
    }
    await idb.put('favorites', merged);
    if (patch.examples) await exampleRepo.replaceForFavorite(id, patch.examples);
    if (patch.tags) await tagRepo.recountTags(patch.tags);
    return merged;
  },

  async remove(id) {
    const row = await idb.get('favorites', id);
    await idb.remove('favorites', id);
    await exampleRepo.removeForFavorite(id);
    if (row?.tags) await tagRepo.recountTags(row.tags);
    return row;
  },

  async removeMany(ids) {
    for (const id of ids) await this.remove(id);
    return ids.length;
  },

  async dueBefore(timestamp) {
    const rows = await idb.query('favorites', {
      index: 'nextReviewAt',
      range: IDBKeyRange.upperBound(timestamp),
      limit: 500
    });
    return rows.filter((r) => !r.archived);
  },

  async allSorted() {
    const rows = await idb.getAll('favorites');
    return rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
};

/* ----------------------------------------------------------------- examples */

export const exampleRepo = {
  async replaceForFavorite(favoriteId, examples, source = 'favorite') {
    const existing = await idb.getAllByIndex('examples', 'favoriteId', favoriteId);
    const previousIds = new Set((existing || []).map((e) => e.id));
    const rows = (examples || []).map((ex, index) => {
      const id = ex.id && previousIds.has(ex.id) ? ex.id : `${favoriteId}#ex${index}`;
      previousIds.delete(id);
      return {
        id,
        favoriteId,
        dictionaryEntryId: ex.dictionaryEntryId ?? null,
        sourceText: ex.sourceText || ex.pt || '',
        translation: ex.translation || ex.zh || '',
        note: ex.note || '',
        source: ex.source || source,
        audioUrl: ex.audioUrl ?? null,
        cachedAudio: ex.cachedAudio ?? null,
        normalizedText: normalizeText(ex.sourceText || ex.pt || ''),
        createdAt: ex.createdAt ?? now()
      };
    });
    await idb.bulkPut('examples', rows);
    if (previousIds.size) await idb.bulkRemove('examples', Array.from(previousIds));
    return rows;
  },

  async removeForFavorite(favoriteId) {
    const rows = await idb.getAllByIndex('examples', 'favoriteId', favoriteId);
    await idb.bulkRemove('examples', (rows || []).map((r) => r.id));
  },

  async addForEntry(entryId, examples) {
    const rows = (examples || []).map((ex, index) => ({
      id: `${entryId}#dex${index}`,
      favoriteId: null,
      dictionaryEntryId: entryId,
      sourceText: ex.sourceText || ex.pt || '',
      translation: ex.translation || ex.zh || '',
      note: ex.note || '',
      source: ex.source || 'dictionary',
      audioUrl: ex.audioUrl ?? null,
      cachedAudio: ex.cachedAudio ?? null,
      normalizedText: normalizeText(ex.sourceText || ex.pt || ''),
      createdAt: now()
    }));
    await idb.bulkPut('examples', rows);
    return rows;
  },

  async all() { return idb.getAll('examples'); },
  async count() { return idb.count('examples'); }
};

/* ----------------------------------------------------------- learning calls */

export const learningRepo = {
  async add(record) {
    const row = {
      id: record.id || uid('rev'),
      favoriteId: record.favoriteId,
      rating: record.rating,
      mode: record.mode || 'study',
      durationMs: record.durationMs ?? 0,
      previousLevel: record.previousLevel ?? null,
      nextLevel: record.nextLevel ?? null,
      reviewedAt: record.reviewedAt ?? now(),
      day: dayKey(record.reviewedAt ?? now())
    };
    await idb.put('learningRecords', row);
    return row;
  },
  async forFavorite(favoriteId) {
    const rows = await idb.getAllByIndex('learningRecords', 'favoriteId', favoriteId);
    return (rows || []).sort((a, b) => b.reviewedAt - a.reviewedAt);
  },
  async all() { return idb.getAll('learningRecords'); },
  async count() { return idb.count('learningRecords'); },
  async since(timestamp) {
    return idb.query('learningRecords', { index: 'reviewedAt', range: IDBKeyRange.lowerBound(timestamp) });
  }
};

/* -------------------------------------------------------------------- tags */

export const tagRepo = {
  async all() { return idb.getAll('tags'); },

  async touch(names) {
    const timestamp = now();
    for (const name of names || []) {
      const id = normalizeText(name);
      if (!id) continue;
      const existing = await idb.get('tags', id);
      await idb.put('tags', {
        id,
        name: existing?.name || name,
        color: existing?.color || pickTagColor(id),
        count: existing?.count ?? 0,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp
      });
    }
  },

  async recountTags(names) {
    await this.touch(names);
    const favorites = await idb.getAll('favorites');
    const counts = new Map();
    for (const fav of favorites) {
      for (const tag of fav.tags || []) {
        const id = normalizeText(tag);
        counts.set(id, (counts.get(id) || 0) + 1);
      }
    }
    const tags = await idb.getAll('tags');
    const updated = tags.map((t) => ({ ...t, count: counts.get(t.id) || 0, updatedAt: now() }));
    const known = new Set(tags.map((t) => t.id));
    for (const [id, count] of counts) {
      if (known.has(id)) continue;
      updated.push({ id, name: id, color: pickTagColor(id), count, createdAt: now(), updatedAt: now() });
    }
    await idb.bulkPut('tags', updated);
    return updated;
  },

  async remove(id) {
    await idb.remove('tags', id);
    const favorites = await idb.getAll('favorites');
    const affected = favorites.filter((f) => (f.tags || []).some((t) => normalizeText(t) === id));
    for (const fav of affected) {
      await favoriteRepo.update(fav.id, { tags: (fav.tags || []).filter((t) => normalizeText(t) !== id) });
    }
    return affected.length;
  }
};

function pickTagColor(seed) {
  const palette = ['#0f766e', '#b45309', '#7c3aed', '#0369a1', '#be123c', '#4d7c0f', '#a21caf', '#c2410c'];
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) % 997;
  return palette[hash % palette.length];
}

/* ------------------------------------------------------------- audio cache */

export const audioRepo = {
  async get(id) { return idb.get('audioCache', id); },

  async save(record) {
    await idb.put('audioCache', { ...record, createdAt: record.createdAt ?? now(), lastUsedAt: now() });
    return record;
  },

  async touch(id) {
    const row = await idb.get('audioCache', id);
    if (!row) return;
    await idb.put('audioCache', { ...row, lastUsedAt: now(), hits: (row.hits || 0) + 1 });
  },

  async all() { return idb.getAll('audioCache'); },
  async count() { return idb.count('audioCache'); },
  async remove(id) { await idb.remove('audioCache', id); },
  async clear() { await idb.clearStore('audioCache'); },

  async stats() {
    const rows = await idb.getAll('audioCache');
    return {
      count: rows.length,
      bytes: rows.reduce((sum, r) => sum + (r.size || r.blob?.size || 0), 0)
    };
  },

  /** Evict least-recently-used entries beyond the configured budget. */
  async prune({ maxItems, maxBytes }) {
    const rows = await idb.getAll('audioCache');
    rows.sort((a, b) => (a.lastUsedAt || a.createdAt || 0) - (b.lastUsedAt || b.createdAt || 0));
    let totalBytes = rows.reduce((sum, r) => sum + (r.size || r.blob?.size || 0), 0);
    const toRemove = [];
    while (rows.length && (rows.length > maxItems || totalBytes > maxBytes)) {
      const row = rows.shift();
      totalBytes -= row.size || row.blob?.size || 0;
      toRemove.push(row.id);
    }
    if (toRemove.length) await idb.bulkRemove('audioCache', toRemove);
    return toRemove.length;
  }
};

/* --------------------------------------------------------------- resources */

export const resourceRepo = {
  async all() { return idb.getAll('resources'); },
  async get(id) { return idb.get('resources', id); },
  async save(record) {
    await idb.put('resources', { ...record, installedAt: record.installedAt ?? now() });
    return record;
  },
  async remove(id) { await idb.remove('resources', id); }
};

/* ----------------------------------------------------------------- imports */

export const importRepo = {
  async add(record) {
    const row = { id: record.id || uid('imp'), createdAt: record.createdAt ?? now(), ...record };
    await idb.put('imports', row);
    return row;
  },
  async all() {
    const rows = await idb.getAll('imports');
    return rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  },
  async count() { return idb.count('imports'); }
};

/* --------------------------------------------------------------- aggregate */

export const repos = {
  settings: settingsRepo,
  dictionary: dictionaryRepo,
  favorites: favoriteRepo,
  examples: exampleRepo,
  learning: learningRepo,
  tags: tagRepo,
  audio: audioRepo,
  resources: resourceRepo,
  imports: importRepo
};

/** Remove everything the user created — dictionary packs are kept. */
export async function clearAllUserData() {
  await idb.clearStore('favorites');
  await idb.clearStore('examples');
  await idb.clearStore('learningRecords');
  await idb.clearStore('tags');
  return true;
}

/** Full reset: drop the whole database (used by 设置 → 危险操作). */
export async function wipeDatabase() {
  return idb.deleteDatabase();
}

export { makeEntryId, makeFavoriteId };
