/**
 * First-run bootstrap: install the bundled dictionary packs, request persistent
 * storage and make sure the dictionary index is warm.
 *
 * Everything here is offline-safe: packs ship with the app, so the very first
 * launch works with no network at all.
 */

import { settingsRepo, resourceRepo } from '../db/repos.js';
import { resourceService } from './resourceService.js';
import { dictionaryService } from './dictionaryService.js';
import { requestPersistence } from '../db/idb.js';

const BOOTSTRAP_KEY = 'bootstrap.version';
const BOOTSTRAP_VERSION = 1;

export async function ensureBaseData({ onProgress } = {}) {
  const installedVersion = await settingsRepo.get(BOOTSTRAP_KEY, 0);
  const dictionaryCount = await dictionaryService.init().then(() => dictionaryService.stats().total);

  if (installedVersion >= BOOTSTRAP_VERSION && dictionaryCount > 0) {
    return { firstRun: false, installed: [], dictionaryCount };
  }

  const installed = [];
  let catalog;
  try {
    catalog = await resourceService.loadCatalog();
  } catch (err) {
    // Without the catalog we still boot: the app works, the dictionary is empty.
    console.warn('[bootstrap] catalog unavailable', err);
    return { firstRun: true, installed: [], dictionaryCount, error: String(err?.message || err) };
  }

  const autoPacks = (catalog.packs || []).filter((pack) => pack.autoInstall && pack.bundled);
  for (const pack of autoPacks) {
    const existing = await resourceRepo.get(pack.id);
    if (existing) continue;
    onProgress?.({ phase: 'pack', pack: pack.name });
    try {
      const result = await resourceService.install(pack);
      installed.push({ id: pack.id, name: pack.name, count: result.itemCount });
    } catch (err) {
      console.warn(`[bootstrap] failed to install ${pack.id}`, err);
    }
  }

  await resourceService.markBaseInstalled();
  await settingsRepo.set(BOOTSTRAP_KEY, BOOTSTRAP_VERSION);
  await dictionaryService.refresh();

  return {
    firstRun: installedVersion === 0,
    installed,
    dictionaryCount: dictionaryService.stats().total
  };
}

export async function enablePersistentStorage() {
  const granted = await requestPersistence();
  await settingsRepo.set('storage.persistent', granted);
  return granted;
}
