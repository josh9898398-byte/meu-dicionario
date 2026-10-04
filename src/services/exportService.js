/**
 * ExportService — the user always owns their data.
 *
 * exportJson()  : complete, lossless backup (notebook + settings + tags + history)
 * exportCsv()   : spreadsheet friendly notebook export
 * exportDictionaryCsv() : dictionary layer only (separate on purpose)
 * importBackup(): restore a JSON backup produced by this app
 */

import { favoriteRepo, learningRepo, tagRepo, settingsRepo, dictionaryRepo, resourceRepo } from '../db/repos.js';
import { escapeCsvCell, downloadBlob, dayKey } from '../core/format.js';
import { dictionaryService } from './dictionaryService.js';
import { APP_VERSION } from '../config.js';

const NOTEBOOK_CSV_HEADERS = [
  'headword', 'translation', 'part_of_speech', 'type', 'tags', 'mastery_level',
  'review_count', 'last_reviewed_at', 'next_review_at', 'source', 'notes',
  'examples_pt', 'examples_zh', 'created_at', 'updated_at'
];

/**
 * Backup kinds — personal data and system dictionary data are exported
 * SEPARATELY on purpose (they are different layers, see db/schema.js).
 *
 *   personal   : 我的词汇库（收藏、例句、复习记录、标签、外观/学习设置）
 *   dictionary : 系统词典资源（词条 + 已安装资源包清单）
 *   full       : 两者都包含
 *
 * Security note: secrets (AI/TTS keys) are NEVER included in exports.
 */
const SECRET_SETTING_PREFIXES = ['ai', 'tts', 'capability'];

function isSecretSetting(key) {
  return SECRET_SETTING_PREFIXES.some((prefix) => key === prefix || key.startsWith(`${prefix}.`));
}

export async function buildJsonBackup({ kind = 'personal' } = {}) {
  const [favorites, records, tags, settings] = await Promise.all([
    favoriteRepo.all(),
    learningRepo.all(),
    tagRepo.all(),
    settingsRepo.all()
  ]);
  const settingsSafe = Object.fromEntries(Object.entries(settings).filter(([key]) => !isSecretSetting(key)));
  const includeDictionary = kind === 'dictionary' || kind === 'full';
  const includePersonal = kind === 'personal' || kind === 'full';

  const dictionary = includeDictionary ? await dictionaryRepo.all() : [];
  const resources = includeDictionary ? await resourceRepo.all() : [];

  return {
    app: 'meu-dicionario-ptbr',
    kind,
    version: APP_VERSION,
    exportedAt: new Date().toISOString(),
    counts: {
      favorites: includePersonal ? favorites.length : 0,
      learningRecords: includePersonal ? records.length : 0,
      tags: includePersonal ? tags.length : 0,
      dictionaryEntries: dictionary.length,
      resources: resources.length
    },
    favorites: includePersonal ? favorites : [],
    learningRecords: includePersonal ? records : [],
    tags: includePersonal ? tags : [],
    settings: includePersonal ? settingsSafe : {},
    dictionaryEntries: dictionary,
    resources
  };
}

/** 我的词汇库（个人数据，推荐用于换手机） */
export async function exportPersonalJson() {
  const backup = await buildJsonBackup({ kind: 'personal' });
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `meu-vocabulario-${dayKey()}.json`);
  return backup.counts;
}

/** 系统词典资源（词条 + 已安装资源包），与个人数据分开备份 */
export async function exportDictionaryJson() {
  const backup = await buildJsonBackup({ kind: 'dictionary' });
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `dicionario-${dayKey()}.json`);
  return backup.counts;
}

export async function exportJson(options = {}) {
  const kind = options.kind || (options.includeDictionary ? 'full' : 'personal');
  const backup = await buildJsonBackup({ kind });
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
  downloadBlob(blob, `meu-dicionario-backup-${dayKey()}.json`);
  return backup.counts;
}

export function favoritesToCsv(favorites) {
  const lines = [NOTEBOOK_CSV_HEADERS.join(',')];
  for (const fav of favorites) {
    const pt = (fav.examples || []).map((e) => e.sourceText).filter(Boolean).join(' | ');
    const zh = (fav.examples || []).map((e) => e.translation).filter(Boolean).join(' | ');
    lines.push([
      fav.headword || fav.customText,
      fav.translation,
      fav.partOfSpeech,
      fav.type,
      (fav.tags || []).join(' '),
      fav.masteryLevel,
      fav.reviewCount,
      fav.lastReviewedAt ? new Date(fav.lastReviewedAt).toISOString() : '',
      fav.nextReviewAt ? new Date(fav.nextReviewAt).toISOString() : '',
      fav.source,
      fav.notes,
      pt,
      zh,
      fav.createdAt ? new Date(fav.createdAt).toISOString() : '',
      fav.updatedAt ? new Date(fav.updatedAt).toISOString() : ''
    ].map(escapeCsvCell).join(','));
  }
  return lines.join('\r\n');
}

export async function exportCsv() {
  const favorites = await favoriteRepo.allSorted();
  const blob = new Blob([`\ufeff${favoritesToCsv(favorites)}`], { type: 'text/csv;charset=utf-8' });
  downloadBlob(blob, `meu-dicionario-notebook-${dayKey()}.csv`);
  return favorites.length;
}

export async function exportDictionaryCsv() {
  const entries = await dictionaryRepo.all();
  const header = ['headword', 'type', 'part_of_speech', 'translations', 'example_pt', 'example_zh', 'tags', 'source'];
  const lines = [header.join(',')];
  for (const entry of entries) {
    const ex = (entry.examples || [])[0] || {};
    lines.push([
      entry.headword,
      entry.type,
      entry.partOfSpeech,
      (entry.translations || []).join(' | '),
      ex.sourceText || '',
      ex.translation || '',
      (entry.tags || []).join(' '),
      entry.source?.name || entry.source?.id || ''
    ].map(escapeCsvCell).join(','));
  }
  const blob = new Blob([`\ufeff${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
  downloadBlob(blob, `meu-dicionario-lexico-${dayKey()}.csv`);
  return entries.length;
}

/**
 * Restore a backup. Personal data is merged (never silently overwritten);
 * dictionary entries are optional and merge by source+headword.
 */
export async function importBackup(json, { mode = 'auto', restoreSettings = false } = {}) {
  if (!json || typeof json !== 'object') throw new Error('备份文件格式不正确');
  if (json.app && json.app !== 'meu-dicionario-ptbr') {
    throw new Error('这不是本应用导出的备份文件');
  }
  const kind = mode !== 'auto' ? mode : (json.kind || (json.dictionaryEntries?.length && !json.favorites?.length ? 'dictionary' : 'personal'));
  const wantsPersonal = kind === 'personal' || kind === 'full';
  const wantsDictionary = kind === 'dictionary' || kind === 'full';

  let favorites = 0;
  let records = 0;
  let entries = 0;

  if (wantsPersonal) {
    for (const fav of json.favorites || []) {
      const existing = await favoriteRepo.findByText(fav.customText || fav.headword);
      if (existing) {
        await favoriteRepo.update(existing.id, { ...fav, id: existing.id, createdAt: existing.createdAt });
      } else {
        await favoriteRepo.save({ ...fav });
      }
      favorites += 1;
    }
    for (const rec of json.learningRecords || []) {
      await learningRepo.add(rec);
      records += 1;
    }
    if (restoreSettings && json.settings && typeof json.settings === 'object') {
      for (const [key, value] of Object.entries(json.settings)) {
        if (isSecretSetting(key)) continue;   // never restore secrets from a file
        await settingsRepo.set(key, value);
      }
    }
  }

  if (wantsDictionary && Array.isArray(json.dictionaryEntries) && json.dictionaryEntries.length) {
    const result = await dictionaryService.upsertEntries(json.dictionaryEntries, { onConflict: 'merge' });
    entries = result.added + result.updated;
  }
  if (wantsDictionary && Array.isArray(json.resources)) {
    for (const resource of json.resources) {
      await resourceRepo.save(resource);
    }
  }
  await dictionaryService.refresh();
  return { kind, favorites, records, entries };
}

export const exportService = {
  buildJsonBackup, exportJson, exportPersonalJson, exportDictionaryJson,
  exportCsv, exportDictionaryCsv, importBackup, favoritesToCsv
};
