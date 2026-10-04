/**
 * ImportService — turn "any" user file into dictionary + notebook records.
 *
 * Pipeline:   file/paste -> grid -> field detection -> user confirms mapping
 *             -> preview + de-duplication -> commit
 *
 * The user always sees 检测到以下字段 and can correct every column before the
 * import runs; nothing is written during detection.
 */

import { parseSpreadsheet, parsePlainLines, parseDelimited } from './csvParser.js';
import { dictionaryService } from './dictionaryService.js';
import { favoriteRepo, importRepo, settingsRepo } from '../db/repos.js';
import { normalizeText, detectType, isPortugueseLike, hasChinese } from './normalizer.js';
import { uid } from '../core/format.js';
import { dictionaryRepo } from '../db/repos.js';

export const FIELD_ROLES = {
  portuguese: '葡语字段（必填）',
  chinese: '中文字段（解释/翻译）',
  example: '例句字段',
  partOfSpeech: '词性字段',
  tags: '标签字段',
  notes: '备注字段',
  pronunciation: '发音/音标字段',
  ignore: '忽略此列'
};

const HEADER_PATTERNS = {
  portuguese: [/^(palavra|portugu[eê]s|portugues|termo|express[ãa]o|frase|verbo|voc[áa]bulo|word|portuguese|term|headword)$/i, /葡语|葡萄牙语|单词|葡文|词语|词组/],
  chinese: [/^(significado|tradu[çc][ãa]o|chin[eê]s|chines|meaning|translation|defini[çc][ãa]o|explica[çc][ãa]o)$/i, /中文|汉语|意思|释义|翻译|解释/],
  example: [/^(exemplo|frase|exemplos|example|sentence|uso)$/i, /例句|例子|示例|句子/],
  partOfSpeech: [/^(classe|classe gramatical|tipo|pos|part of speech|gramatica|gram[áa]tica)$/i, /词性|词类|语法/],
  tags: [/^(tags?|etiquetas?|categorias?)$/i, /标签|分类/],
  notes: [/^(notas?|observa[çc][õo]es|obs)$/i, /备注|笔记|说明/],
  pronunciation: [/^(pron[úu]ncia|fon[ée]tica|ipa|s[íi]labas)$/i, /发音|音标|拼音/]
};

/* ------------------------------------------------------------- detection */

export function detectHeaderRow(grid, maxScan = 5) {
  for (let i = 0; i < Math.min(grid.length, maxScan); i += 1) {
    const row = grid[i] || [];
    const cells = row.filter((c) => String(c || '').trim());
    if (cells.length < 2) continue;
    const headerish = cells.filter((cell) => Object.values(HEADER_PATTERNS)
      .some((patterns) => patterns.some((re) => re.test(String(cell).trim())))).length;
    const numericish = cells.filter((cell) => /^[\d.,%]+$/.test(String(cell).trim())).length;
    if (headerish >= Math.max(2, Math.ceil(cells.length * 0.4)) && numericish === 0) return i;
  }
  return 0;
}

/**
 * Score every column against every role using header text + content shape.
 * Returns a mapping the UI shows for confirmation.
 */
export function detectFields(grid, { hasHeader = true, headerRow = 0 } = {}) {
  const body = hasHeader ? grid.slice(headerRow + 1) : grid.slice(headerRow);
  const header = hasHeader ? (grid[headerRow] || []) : [];
  const columnCount = Math.max(header.length, ...body.map((r) => r.length), 0);
  const columns = [];

  for (let col = 0; col < columnCount; col += 1) {
    const headerCell = String(header[col] || '').trim();
    const values = body.map((r) => String(r[col] ?? '').trim()).filter(Boolean);
    const sample = values.slice(0, 60);
    const scores = {};
    for (const role of Object.keys(HEADER_PATTERNS)) scores[role] = 0;

    if (headerCell) {
      for (const [role, patterns] of Object.entries(HEADER_PATTERNS)) {
        if (patterns.some((re) => re.test(headerCell))) scores[role] += 12;
      }
    }

    const cjkCount = sample.filter((v) => hasChinese(v)).length;
    const ptCount = sample.filter((v) => isPortugueseLike(v) && !hasChinese(v)).length;
    const longCount = sample.filter((v) => v.split(/\s+/).length >= 5).length;
    const shortPtCount = sample.filter((v) => isPortugueseLike(v) && !hasChinese(v) && v.split(/\s+/).length <= 4).length;
    const posCount = sample.filter((v) => /^(substantivo|verbo|adjetivo|adv[ée]rbio|express[ãa]o|locu[çc][ãa]o|preposi[çc][ãa]o|pronome|interjei[çc][ãa]o|numeral|artigo|名词|动词|形容词|副词|词组|短语|介词|代词)$/i.test(v)).length;
    const tagCount = sample.filter((v) => /[,，、]/.test(v) && v.length < 24).length;

    scores.chinese += (cjkCount / Math.max(1, sample.length)) * 10;
    scores.portuguese += (ptCount / Math.max(1, sample.length)) * 8 + (shortPtCount / Math.max(1, sample.length)) * 3;
    scores.example += (longCount / Math.max(1, sample.length)) * 12;
    scores.portuguese -= (longCount / Math.max(1, sample.length)) * 5;
    scores.partOfSpeech += (posCount / Math.max(1, sample.length)) * 14;
    scores.tags += (tagCount / Math.max(1, sample.length)) * 3;

    columns.push({ index: col, header: headerCell, samples: sample.slice(0, 4), scores, empty: values.length === 0 });
  }

  // assign roles greedily by highest score, each role at most once
  const assignment = {};
  const taken = new Set();
  const roleOrder = ['portuguese', 'chinese', 'example', 'partOfSpeech', 'pronunciation', 'tags', 'notes'];
  for (const role of roleOrder) {
    let best = null;
    for (const col of columns) {
      if (taken.has(col.index)) continue;
      if (role === 'portuguese' && hasChinese(col.header)) continue;
      const score = col.scores[role] || 0;
      if (score <= (role === 'portuguese' || role === 'chinese' ? 1.2 : 2.4)) continue;
      if (!best || score > best.score) best = { index: col.index, score };
    }
    if (best) { assignment[role] = best.index; taken.add(best.index); }
  }

  // Guarantee at least one Portuguese column
  if (assignment.portuguese === undefined) {
    const fallback = columns.find((c) => !taken.has(c.index) && !c.empty && c.scores.portuguese >= 0) || columns[0];
    if (fallback) { assignment.portuguese = fallback.index; taken.add(fallback.index); }
  }
  if (assignment.chinese === undefined) {
    const fallback = columns.find((c) => !taken.has(c.index) && (c.scores.chinese || 0) > 0.5);
    if (fallback) { assignment.chinese = fallback.index; taken.add(fallback.index); }
  }

  const mapped = new Set(Object.values(assignment));
  for (const col of columns) {
    if (!mapped.has(col.index)) assignment[`ignore:${col.index}`] = col.index;
  }

  const coverage = (['portuguese', 'chinese'].filter((r) => assignment[r] !== undefined).length) / 2;
  return {
    headerRow,
    hasHeader,
    columns,
    mapping: assignment,
    confidence: Math.round(coverage * 100)
  };
}

/** Rows -> normalized import items (no DB writes). */
export function buildItems(grid, detection, { limit = 5000 } = {}) {
  const { mapping, hasHeader, headerRow } = detection;
  const body = hasHeader ? grid.slice(headerRow + 1) : grid.slice(headerRow);
  const items = [];

  for (const row of body.slice(0, limit)) {
    const get = (role) => {
      const col = mapping[role];
      return col === undefined ? '' : String(row[col] ?? '').trim();
    };
    const pt = get('portuguese');
    const zh = get('chinese');
    const example = get('example');
    const pos = get('partOfSpeech');
    const tags = get('tags');
    const notes = get('notes');
    const pronunciation = get('pronunciation');

    if (!pt && !zh) continue;
    if (!pt) continue; // a Chinese-only row cannot become a Portuguese entry
    if (/^(palavra|word|portugu[eê]s|termo)$/i.test(pt)) continue; // repeated header

    const normalized = normalizeText(pt);
    const examples = [];
    if (example && normalizeText(example) !== normalized) {
      examples.push({ sourceText: example, translation: '', note: '导入的例句', source: 'import' });
    }

    items.push({
      headword: pt,
      normalized,
      translation: zh,
      partOfSpeech: pos,
      tags: tags ? tags.split(/[,，、;]/).map((t) => t.trim()).filter(Boolean) : [],
      notes,
      pronunciation: pronunciation ? { ipa: pronunciation, syllables: '' } : null,
      examples,
      type: detectType(pt)
    });
  }
  return items;
}

/** Split into new vs duplicate (against dictionary + notebook). */
export async function analyzeDuplicates(items) {
  const existingDictionary = new Set();
  const existingFavorites = new Set();
  const [entries, favorites] = await Promise.all([dictionaryRepo.all(), favoriteRepo.all()]);
  for (const entry of entries) existingDictionary.add(entry.normalizedWord);
  for (const fav of favorites) existingFavorites.add(fav.normalizedText);

  const seen = new Set();
  const fresh = [];
  const duplicates = [];
  for (const item of items) {
    const key = normalizeText(item.normalized || item.headword);
    item.normalized = key;
    if (seen.has(key) || existingDictionary.has(key) || existingFavorites.has(key)) duplicates.push(item);
    else { seen.add(key); fresh.push(item); }
  }
  return { fresh, duplicates, total: items.length };
}

/* ------------------------------------------------------------------ commit */

/**
 * Write the confirmed items.
 * options: { target: 'both'|'dictionary'|'notebook', strategy: 'skip'|'merge'|'update',
 *            sourceName: string, tags: string[], duplicates: item[] }
 */
export async function commit(items, options = {}) {
  const {
    target = 'both',
    strategy = 'skip',
    sourceName = '',
    extraTags = [],
    includeDuplicates = false
  } = options;

  const list = items || [];
  const source = {
    id: 'import',
    name: sourceName || '导入的词库',
    license: 'user-provided',
    version: 1
  };

  let dictionaryResult = { added: 0, updated: 0, skipped: 0 };
  let notebookAdded = 0;
  let notebookSkipped = 0;

  if (target === 'both' || target === 'dictionary') {
    const entries = list.map((item) => dictionaryService.createEntryFromInput({
      headword: item.headword,
      type: item.type,
      partOfSpeech: item.partOfSpeech,
      translations: item.translation ? [item.translation] : [],
      meanings: item.translation ? [{ definition: item.translation, note: item.notes || '' }] : [],
      examples: item.examples || [],
      tags: [...(item.tags || []), ...extraTags],
      pronunciation: item.pronunciation || null,
      source,
      packId: 'import',
      notes: item.notes || ''
    }));
    dictionaryResult = await dictionaryService.upsertEntries(entries, {
      onConflict: strategy === 'update' ? 'replace' : strategy === 'merge' ? 'merge' : 'skip'
    });
  }

  if (target === 'both' || target === 'notebook') {
    for (const item of list) {
      const existing = await favoriteRepo.findByText(item.headword);
      if (existing) {
        if (strategy === 'update') {
          await favoriteRepo.update(existing.id, {
            translation: item.translation || existing.translation,
            partOfSpeech: item.partOfSpeech || existing.partOfSpeech,
            tags: Array.from(new Set([...(existing.tags || []), ...(item.tags || []), ...extraTags])),
            notes: item.notes || existing.notes,
            examples: [...(existing.examples || []), ...(item.examples || [])]
          });
          notebookAdded += 1;
        } else if (strategy === 'merge') {
          await favoriteRepo.update(existing.id, {
            tags: Array.from(new Set([...(existing.tags || []), ...(item.tags || []), ...extraTags]))
          });
          notebookSkipped += 1;
        } else {
          notebookSkipped += 1;
        }
        continue;
      }
      await favoriteRepo.create({
        customText: item.headword,
        headword: item.headword,
        type: item.type,
        translation: item.translation,
        meanings: item.translation ? [{ definition: item.translation, note: '' }] : [],
        partOfSpeech: item.partOfSpeech,
        examples: item.examples || [],
        tags: [...(item.tags || []), ...extraTags],
        pronunciation: item.pronunciation || null,
        source: 'import',
        sourceRef: source.name
      });
      notebookAdded += 1;
    }
  }

  const record = await importRepo.add({
    id: uid('imp'),
    fileName: sourceName || '（粘贴文本）',
    totalRows: list.length + (includeDuplicates ? 0 : 0),
    importedRows: notebookAdded + dictionaryResult.added,
    skippedRows: dictionaryResult.skipped + notebookSkipped,
    mapping: options.mapping || null,
    target,
    strategy,
    status: 'completed',
    log: [dictionaryResult, { notebookAdded, notebookSkipped }]
  });

  return { dictionaryResult, notebookAdded, notebookSkipped, record };
}

/* -------------------------------------------------------------- entrypoint */

/** High-level: parse a File into sheets (used by the import page). */
export async function loadFile(file) {
  if (file.size > 25 * 1024 * 1024) throw new Error('文件过大（>25MB）。请拆分后导入。');
  return parseSpreadsheet(file);
}

export async function loadPastedText(text) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('没有可解析的文本');
  const looksDelimited = /\t|;|,|\|/.test(clean.split(/\r?\n/)[0] || '');
  const parsed = looksDelimited ? parseDelimited(clean) : parsePlainLines(clean);
  return { kind: 'paste', sheets: [{ name: '粘贴内容', grid: parsed.grid }], delimiter: parsed.delimiter };
}

export async function saveImportPreferences(prefs) {
  return settingsRepo.set('import.lastOptions', prefs);
}

export async function loadImportPreferences() {
  return (await settingsRepo.get('import.lastOptions')) || { target: 'both', strategy: 'skip', extraTags: '' };
}

export const importService = {
  loadFile, loadPastedText, detectFields, detectHeaderRow, buildItems,
  analyzeDuplicates, commit, saveImportPreferences, loadImportPreferences,
  FIELD_ROLES
};
