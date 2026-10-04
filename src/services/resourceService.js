/**
 * ResourceService — the "资源中心".
 *
 * Honest data policy (see LICENSE-DATA.md):
 *  - Only data that is legally redistributable is offered as a downloadable pack.
 *  - Commercial dictionaries are NEVER faked: a pack either exists with a clear
 *    license, or the catalog marks it as "需要你自行提供数据" with an import path.
 *
 * Pack manifest shape:
 *  { id, name, description, kind, version, license:{name,url}, source:{name,url},
 *    size:{entries}, bundled:boolean, url?:string, requiresNetwork?:boolean,
 *    note?:string, generator?:'tts' }
 */

import { deployConfig } from '../config.js';
import { dictionaryService } from './dictionaryService.js';
import { resourceRepo, settingsRepo, dictionaryRepo, audioRepo } from '../db/repos.js';
import { TTSService } from './ttsService.js';
import { isOnline } from './connectivityService.js';
import { bus, EVENTS } from '../core/events.js';

export const BUNDLED_CATALOG = 'src/data/packs/catalog.json';

export async function loadCatalog({ forceRemote = false } = {}) {
  const remote = deployConfig.resourceCatalogUrl;
  if (remote && (forceRemote || isOnline())) {
    try {
      const res = await fetch(remote, { cache: 'no-cache' });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data?.packs)) return { packs: data.packs, origin: 'remote' };
      }
    } catch { /* fall back to the bundled catalog */ }
  }
  const res = await fetch(new URL(BUNDLED_CATALOG, new URL('../../', import.meta.url)).href, { cache: 'no-cache' });
  if (!res.ok) throw new Error('无法读取内置资源目录');
  const data = await res.json();
  return { packs: data.packs || [], origin: 'bundled' };
}

export async function listPacks() {
  const [{ packs }, installed] = await Promise.all([loadCatalog(), resourceRepo.all()]);
  const installedMap = new Map(installed.map((r) => [r.id, r]));
  return packs.map((pack) => ({
    ...pack,
    installed: installedMap.has(pack.id),
    installedRecord: installedMap.get(pack.id) || null
  }));
}

export async function install(pack, { onProgress } = {}) {
  if (!pack?.id) throw new Error('资源包缺少 id');
  if (pack.requiresNetwork && !isOnline()) throw new Error('该资源包需要联网下载');

  if (pack.generator === 'tts') return installAudioPack(pack, { onProgress });
  if (pack.generator === 'frequency-remote') return installRemoteFrequencyPack(pack, { onProgress });

  const url = pack.url || `src/data/packs/${pack.id}.json`;
  onProgress?.({ phase: 'download', percent: 10 });
  const res = await fetch(new URL(url, new URL('../../', import.meta.url)).href, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`下载失败（${res.status}）`);
  const data = await res.json();
  const rawEntries = Array.isArray(data) ? data : data.entries;
  if (!Array.isArray(rawEntries)) throw new Error('资源包格式不正确（缺少 entries 数组）');
  onProgress?.({ phase: 'parse', percent: 45 });

  const source = {
    id: pack.id,
    name: pack.name,
    license: pack.license?.name || data.license || 'unknown',
    version: pack.version || data.version || 1
  };

  const entries = rawEntries.map((entry) => dictionaryService.createEntryFromInput({
    headword: entry.headword || entry.word || entry.text,
    type: entry.type || null,
    partOfSpeech: entry.partOfSpeech || entry.pos || '',
    translations: entry.translations || (entry.translation ? [entry.translation] : []),
    meanings: entry.meanings || (entry.meaning ? [{ definition: entry.meaning, note: '' }] : []),
    examples: entry.examples || [],
    collocations: entry.collocations || [],
    patterns: entry.patterns || [],
    relatedExpressions: entry.relatedExpressions || [],
    usageNotes: entry.usageNotes || [],
    tags: entry.tags || [],
    difficulty: entry.difficulty || '',
    pronunciation: entry.pronunciation || null,
    frequencyRank: entry.frequencyRank ?? entry.rank ?? null,
    source,
    packId: pack.id,
    notes: entry.notes || ''
  }));

  onProgress?.({ phase: 'write', percent: 65 });
  const result = await dictionaryService.upsertEntries(entries, { onConflict: 'merge' });
  onProgress?.({ phase: 'index', percent: 90 });
  await dictionaryService.refresh();

  const record = await resourceRepo.save({
    id: pack.id,
    name: pack.name,
    kind: pack.kind || 'dictionary',
    version: pack.version || 1,
    itemCount: entries.length,
    added: result.added,
    updated: result.updated,
    license: pack.license || null,
    source: pack.source || null,
    description: pack.description || '',
    installedAt: Date.now(),
    sizeBytes: data.sizeBytes || null
  });
  onProgress?.({ phase: 'done', percent: 100 });
  bus.emit(EVENTS.RESOURCES_CHANGED, { packId: pack.id, action: 'install' });
  return { record, result, itemCount: entries.length };
}

/**
 * One-tap download of a legally redistributable frequency list.
 *
 * Source: FrequencyWords (Hermit Dave) — CC BY-SA 4.0, redistributable with
 * attribution (kept in the pack metadata and shown in 资源中心).
 * Downloaded once, then stored locally → fully offline afterwards.
 */
async function installRemoteFrequencyPack(pack, { onProgress } = {}) {
  if (!isOnline()) throw new Error('下载需要联网');
  const url = pack.sourceUrl;
  if (!url) throw new Error('该资源缺少下载地址');
  const limit = Number(pack.limit) || 3000;

  onProgress?.({ phase: 'download', percent: 10 });
  let text;
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (err) {
    throw new Error(`下载失败：${err.message}。请检查网络后重试。`);
  }

  onProgress?.({ phase: 'parse', percent: 45 });
  const lines = text.split(/\r?\n/);
  const seen = new Set();
  const rows = [];
  for (const line of lines) {
    const word = (line.split(/\s+/)[0] || '').trim();
    if (!word || !/^[\p{L}][\p{L}'-]*$/u.test(word)) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(word);
    if (rows.length >= limit) break;
  }
  if (!rows.length) throw new Error('下载内容无法解析为词表');

  const source = {
    id: pack.id,
    name: pack.name,
    license: pack.license?.name || 'CC BY-SA 4.0',
    version: pack.version || 1
  };

  onProgress?.({ phase: 'write', percent: 70, total: rows.length, done: 0 });
  const entries = rows.map((word, index) => dictionaryService.createEntryFromInput({
    headword: word,
    type: 'word',
    translations: [],
    frequencyRank: index + 1,
    tags: ['高频词'],
    source,
    packId: pack.id
  }));

  const result = await dictionaryService.upsertEntries(entries, { onConflict: 'merge' });
  onProgress?.({ phase: 'index', percent: 90, total: rows.length, done: rows.length });
  await dictionaryService.refresh();

  const record = await resourceRepo.save({
    id: pack.id,
    name: pack.name,
    kind: pack.kind || 'frequency',
    version: pack.version || 1,
    itemCount: entries.length,
    added: result.added,
    updated: result.updated,
    license: pack.license || null,
    source: pack.source || null,
    description: pack.description || '',
    installedAt: Date.now(),
    sizeBytes: text.length
  });
  onProgress?.({ phase: 'done', percent: 100 });
  bus.emit(EVENTS.RESOURCES_CHANGED, { packId: pack.id, action: 'install' });
  return { record, result, itemCount: entries.length };
}

async function installAudioPack(pack, { onProgress } = {}) {
  if (!isOnline()) throw new Error('生成语音资源包需要联网');
  const status = TTSService.status();
  if (status.provider === 'device') {
    throw new Error('当前语音提供方是「设备内置语音」，无法生成可离线播放的音频包。请先在设置 → 语音 中配置 TTS 服务。');
  }
  const entries = dictionaryService.allEntriesSync();
  const texts = [];
  for (const entry of entries.slice(0, pack.limit || 300)) {
    if (entry.headword) texts.push(entry.headword);
    for (const ex of (entry.examples || []).slice(0, 2)) if (ex.sourceText) texts.push(ex.sourceText);
  }
  if (!texts.length) throw new Error('词典为空，无法生成音频包');
  onProgress?.({ phase: 'tts', percent: 5, total: texts.length });
  const result = await TTSService.prefetch(texts, {
    onProgress: ({ done, total }) => onProgress?.({ phase: 'tts', percent: 5 + Math.round((done / total) * 90), done, total })
  });
  const record = await resourceRepo.save({
    id: pack.id,
    name: pack.name,
    kind: 'audio',
    version: pack.version || 1,
    itemCount: result.generated,
    failures: result.failures.length,
    description: pack.description || '',
    license: pack.license || null,
    installedAt: Date.now()
  });
  onProgress?.({ phase: 'done', percent: 100 });
  bus.emit(EVENTS.RESOURCES_CHANGED, { packId: pack.id, action: 'install' });
  return { record, itemCount: result.generated, failures: result.failures };
}

export async function remove(packId) {
  const record = await resourceRepo.get(packId);
  if (!record) return { removed: 0 };
  let removedEntries = 0;
  if (record.kind !== 'audio') removedEntries = await dictionaryRepo.removeByPack(packId);
  else await audioRepo.clear();
  await resourceRepo.remove(packId);
  await dictionaryService.refresh();
  bus.emit(EVENTS.RESOURCES_CHANGED, { packId, action: 'remove' });
  return { removed: removedEntries };
}

export async function installed() {
  return resourceRepo.all();
}

export async function markBaseInstalled() {
  await resourceRepo.save({
    id: 'core',
    name: '内置核心词典（示例数据）',
    kind: 'dictionary',
    version: 1,
    description: '随应用一起安装的示例词条，包含单词、词组与巴西口语表达。',
    license: { name: 'CC0-1.0（作者原创示例数据）', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
    installedAt: Date.now()
  });
}

export async function lastError() {
  return settingsRepo.get('resources.lastError', null);
}

export const resourceService = { loadCatalog, listPacks, install, remove, installed, markBaseInstalled };
