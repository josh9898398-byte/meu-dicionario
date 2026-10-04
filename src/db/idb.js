/**
 * Promise wrapper around IndexedDB.
 *
 * Design notes:
 *  - One shared connection, lazily opened.
 *  - `indexedDB` is resolved through a factory so the same repositories can be
 *    exercised in Node tests with an in-memory fake.
 *  - Bulk writes are chunked: Safari keeps a transaction alive only while
 *    requests are pending, and huge single transactions are a common source of
 *    iOS crashes.
 */

import { DB_NAME, DB_VERSION } from '../config.js';
import { SCHEMA } from './schema.js';

let dbPromise = null;
let factoryProvider = () => globalThis.indexedDB;

/** Test seam: swap the IndexedDB implementation (must be called before open()). */
export function configureIndexedDB(provider) {
  factoryProvider = provider;
  dbPromise = null;
}

export function resetConnection() {
  dbPromise = null;
}

export function isIndexedDBAvailable() {
  try { return Boolean(factoryProvider()); } catch { return false; }
}

export function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const factory = factoryProvider();
    if (!factory) { reject(new Error('IndexedDB 不可用。若使用 Safari 无痕模式，请改用普通窗口。')); return; }
    let request;
    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch (err) { reject(err); return; }

    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction;
      applySchema(db, tx, event.oldVersion || 0);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); resetConnection(); };
      resolve(db);
    };
    request.onerror = () => reject(request.error || new Error('无法打开本地数据库'));
    request.onblocked = () => reject(new Error('数据库被其他标签页占用，请关闭其他页面后重试'));
  });
  return dbPromise;
}

function applySchema(db, tx, oldVersion) {
  for (const [name, def] of Object.entries(SCHEMA)) {
    let store;
    if (!db.objectStoreNames.contains(name)) {
      store = db.createObjectStore(name, { keyPath: def.keyPath, autoIncrement: Boolean(def.autoIncrement) });
    } else if (oldVersion > 0) {
      store = tx.objectStore(name);
    } else {
      continue;
    }
    for (const [indexName, indexDef] of Object.entries(def.indexes || {})) {
      if (store.indexNames.contains(indexName)) continue;
      store.createIndex(indexName, indexDef.keyPath, {
        unique: Boolean(indexDef.unique),
        multiEntry: Boolean(indexDef.multiEntry)
      });
    }
  }
}

function promisify(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 操作失败'));
  });
}

/**
 * Open a transaction and capture its completion promise immediately.
 * (Attaching `oncomplete` only after awaiting a request is a classic
 * IndexedDB race — Safari may have already fired it.)
 */
async function store(name, mode = 'readonly') {
  const db = await openDatabase();
  const tx = db.transaction(name, mode);
  const done = new Promise((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
  return { tx, store: tx.objectStore(name), done };
}

export async function get(name, key) {
  const { store: s } = await store(name);
  return promisify(s.get(key));
}

export async function getAll(name, query = null, count = undefined) {
  const { store: s } = await store(name);
  return promisify(query ? s.getAll(query, count) : s.getAll());
}

export async function getAllByIndex(name, indexName, query = null, count = undefined) {
  const { store: s } = await store(name);
  const index = s.index(indexName);
  return promisify(query ? index.getAll(query, count) : index.getAll());
}

export async function getOneByIndex(name, indexName, query) {
  const { store: s } = await store(name);
  return promisify(s.index(indexName).get(query));
}

export async function put(name, value) {
  const { done, store: s } = await store(name, 'readwrite');
  const result = await promisify(s.put(value));
  await done;
  return result;
}

export async function bulkPut(name, values, chunkSize = 250) {
  if (!values?.length) return 0;
  let written = 0;
  for (let i = 0; i < values.length; i += chunkSize) {
    const chunk = values.slice(i, i + chunkSize);
    const { done, store: s } = await store(name, 'readwrite');
    const requests = chunk.map((value) => s.put(value));
    await Promise.all(requests.map(promisify));
    await done;
    written += chunk.length;
  }
  return written;
}

export async function remove(name, key) {
  const { done, store: s } = await store(name, 'readwrite');
  await promisify(s.delete(key));
  await done;
}

export async function bulkRemove(name, keys) {
  if (!keys?.length) return 0;
  const { done, store: s } = await store(name, 'readwrite');
  await Promise.all(keys.map((key) => promisify(s.delete(key))));
  await done;
  return keys.length;
}

export async function clearStore(name) {
  const { done, store: s } = await store(name, 'readwrite');
  await promisify(s.clear());
  await done;
}

export async function count(name, query = null) {
  const { store: s } = await store(name);
  return promisify(query ? s.count(query) : s.count());
}

/** Cursor based query with range + optional in-memory filter. */
export async function query(name, {
  index = null,
  range = null,
  direction = 'next',
  limit = Infinity,
  filter = null
} = {}) {
  const { store: s } = await store(name);
  const source = index ? s.index(index) : s;
  const results = [];
  return new Promise((resolve, reject) => {
    const request = source.openCursor(range, direction);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || results.length >= limit) { resolve(results); return; }
      const value = cursor.value;
      if (!filter || filter(value)) results.push(value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error('查询失败'));
  });
}

/** Run several operations of the same store atomically-ish inside one tx. */
export async function runTx(name, mode, fn) {
  const { done, store: s } = await store(name, mode);
  const helpers = {
    get: (k) => promisify(s.get(k)),
    getAll: (q, c) => promisify(s.getAll(q, c)),
    put: (v) => promisify(s.put(v)),
    delete: (k) => promisify(s.delete(k)),
    clear: () => promisify(s.clear()),
    indexGetAll: (idx, q, c) => promisify(s.index(idx).getAll(q, c))
  };
  const result = await fn(helpers, s);
  await done;
  return result;
}

export function rangeOnly() {
  return IDBKeyRange.only(...arguments); // eslint-disable-line
}

export async function estimateStorage() {
  if (!navigator.storage?.estimate) return null;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    return { usage, quota };
  } catch { return null; }
}

export async function requestPersistence() {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch { return false; }
}

export async function deleteDatabase() {
  const db = await openDatabase().catch(() => null);
  db?.close();
  resetConnection();
  const factory = factoryProvider();
  return new Promise((resolve) => {
    const req = factory.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve(true);
    req.onerror = () => resolve(false);
    req.onblocked = () => resolve(false);
  });
}
