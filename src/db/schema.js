/**
 * IndexedDB schema (declarative, versioned).
 *
 * Two logical layers, deliberately separated:
 *
 *  1. DICTIONARY LAYER — replaceable data, owned by "packs"/sources
 *     dictionaryEntries, words, phrases, examples, resources
 *
 *  2. PERSONAL LAYER — 100% user owned, never overwritten by dictionary updates
 *     favorites, learningRecords, audioCache, tags, imports, settings
 *
 * A Favorite keeps its own snapshot (translation/examples/…) plus an optional
 * `dictionaryEntryId` reference, so replacing or deleting a dictionary pack can
 * never damage the user's notebook.
 */

export const SCHEMA = {
  /** Full dictionary entries (words, phrases, expressions, sentences). */
  dictionaryEntries: {
    keyPath: 'id',
    indexes: {
      norm: { keyPath: 'normalizedWord' },
      head: { keyPath: 'headword' },
      type: { keyPath: 'type' },
      sourceId: { keyPath: 'source.id' },
      packId: { keyPath: 'packId' },
      freq: { keyPath: 'frequencyRank' },
      updatedAt: { keyPath: 'updatedAt' },
      tags: { keyPath: 'tags', multiEntry: true }
    }
  },

  /** Fast single-token lookup index for tapped words inside a sentence. */
  words: {
    keyPath: 'id',
    indexes: {
      norm: { keyPath: 'normalized' },
      entryId: { keyPath: 'entryId' },
      freq: { keyPath: 'frequencyRank' }
    }
  },

  /** Fast multi-word lookup index ("dar conta", "ficar de boa"). */
  phrases: {
    keyPath: 'id',
    indexes: {
      norm: { keyPath: 'normalized' },
      entryId: { keyPath: 'entryId' },
      first: { keyPath: 'firstToken' }
    }
  },

  /** Every example sentence ever seen (dictionary, AI, imports, user input). */
  examples: {
    keyPath: 'id',
    indexes: {
      entryId: { keyPath: 'dictionaryEntryId' },
      favoriteId: { keyPath: 'favoriteId' },
      norm: { keyPath: 'normalizedText' },
      createdAt: { keyPath: 'createdAt' }
    }
  },

  /** Personal notebook. */
  favorites: {
    keyPath: 'id',
    indexes: {
      norm: { keyPath: 'normalizedText' },
      entryId: { keyPath: 'dictionaryEntryId' },
      createdAt: { keyPath: 'createdAt' },
      updatedAt: { keyPath: 'updatedAt' },
      nextReviewAt: { keyPath: 'nextReviewAt' },
      lastReviewedAt: { keyPath: 'lastReviewedAt' },
      mastery: { keyPath: 'masteryLevel' },
      type: { keyPath: 'type' },
      source: { keyPath: 'source' },
      tags: { keyPath: 'tags', multiEntry: true }
    }
  },

  /** Per-review history (feeds statistics and the scheduler). */
  learningRecords: {
    keyPath: 'id',
    indexes: {
      favoriteId: { keyPath: 'favoriteId' },
      reviewedAt: { keyPath: 'reviewedAt' },
      day: { keyPath: 'day' },
      rating: { keyPath: 'rating' }
    }
  },

  /** Generated audio blobs (offline playback). */
  audioCache: {
    keyPath: 'id',
    indexes: {
      createdAt: { keyPath: 'createdAt' },
      lastUsedAt: { keyPath: 'lastUsedAt' },
      text: { keyPath: 'text' }
    }
  },

  /** Installed resource packs. */
  resources: {
    keyPath: 'id',
    indexes: {
      kind: { keyPath: 'kind' },
      installedAt: { keyPath: 'installedAt' }
    }
  },

  /** Import history / logs. */
  imports: {
    keyPath: 'id',
    indexes: {
      createdAt: { keyPath: 'createdAt' },
      status: { keyPath: 'status' }
    }
  },

  /** Tag registry with usage counts. */
  tags: {
    keyPath: 'id',
    indexes: {
      name: { keyPath: 'name' },
      count: { keyPath: 'count' },
      updatedAt: { keyPath: 'updatedAt' }
    }
  },

  /** Simple key/value settings. */
  settings: {
    keyPath: 'key',
    indexes: {}
  }
};

export const STORE_NAMES = Object.keys(SCHEMA);

export const MASTERY_LEVELS = {
  new: { id: 'new', label: '新词', order: 0 },
  learning: { id: 'learning', label: '学习中', order: 1 },
  familiar: { id: 'familiar', label: '熟悉', order: 2 },
  mastered: { id: 'mastered', label: '已掌握', order: 3 }
};

export const ENTRY_TYPES = {
  word: { id: 'word', label: '单词' },
  phrase: { id: 'phrase', label: '词组' },
  expression: { id: 'expression', label: '表达' },
  sentence: { id: 'sentence', label: '句子' },
  unknown: { id: 'unknown', label: '未知' }
};
