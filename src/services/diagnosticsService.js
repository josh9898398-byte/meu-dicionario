/**
 * DiagnosticsService — the on-device self test.
 *
 * This exists because the PWA has to be verified on the real target (iPhone
 * Safari). The 设置 → 诊断 page runs these checks on the user's own device and
 * reports pass/fail, instead of us claiming results we cannot observe.
 */

import { APP_VERSION, DB_NAME } from '../config.js';
import * as idb from '../db/idb.js';
import { dictionaryService } from './dictionaryService.js';
import { favoriteRepo, audioRepo, resourceRepo, dictionaryRepo } from '../db/repos.js';
import { AIService } from './aiService.js';
import { TTSService } from './ttsService.js';
import { isOnline } from './connectivityService.js';
import { SRS } from './index.js';

export function environment() {
  const ua = navigator.userAgent || '';
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches
    || navigator.standalone === true;
  return {
    userAgent: ua,
    isIOS: /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
    isSafari: /^((?!chrome|android|crios|fxios).)*safari/i.test(ua),
    standalone,
    displayMode: standalone ? 'standalone' : 'browser',
    safeAreaSupported: CSS.supports?.('padding: env(safe-area-inset-bottom)') ?? false,
    dpr: window.devicePixelRatio,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    language: navigator.language,
    online: isOnline(),
    hasIndexedDB: idb.isIndexedDBAvailable(),
    hasServiceWorker: 'serviceWorker' in navigator,
    hasSpeechSynthesis: 'speechSynthesis' in window,
    hasDecompressionStream: typeof DecompressionStream !== 'undefined',
    hasShare: typeof navigator.share === 'function'
  };
}

export async function runSelfTest() {
  const results = [];
  const add = (id, label, status, detail = '') => results.push({ id, label, status, detail });

  // 1. IndexedDB
  try {
    await idb.put('settings', { key: '__selftest', value: Date.now() });
    const row = await idb.get('settings', '__selftest');
    add('idb', '本地数据库（IndexedDB）可读写', row ? 'pass' : 'fail', DB_NAME);
  } catch (err) {
    add('idb', '本地数据库（IndexedDB）可读写', 'fail', String(err.message || err));
  }

  // 2. Storage quota / persistence
  try {
    const estimate = await idb.estimateStorage();
    const persisted = await navigator.storage?.persisted?.();
    add('storage', '存储空间与持久化', estimate ? 'pass' : 'warn',
      estimate ? `已用 ${Math.round(estimate.usage / 1048576)}MB / 配额 ${Math.round(estimate.quota / 1048576)}MB，持久化：${persisted ? '已授予' : '未授予'}` : '此浏览器不支持存储估算');
  } catch (err) {
    add('storage', '存储空间与持久化', 'warn', String(err.message || err));
  }

  // 3. Service worker
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    add('sw', 'Service Worker 离线外壳', reg?.active ? 'pass' : 'warn',
      reg?.active ? `已激活，作用域 ${reg.scope}` : '尚未注册（需要 https 或 localhost）');
  } catch (err) {
    add('sw', 'Service Worker 离线外壳', 'fail', String(err.message || err));
  }

  // 4. Manifest
  try {
    const link = document.querySelector('link[rel="manifest"]');
    const href = link?.getAttribute('href');
    const res = href ? await fetch(href, { cache: 'no-cache' }) : null;
    const manifest = res?.ok ? await res.json() : null;
    add('manifest', 'PWA manifest', manifest ? 'pass' : 'fail',
      manifest ? `${manifest.name} · display=${manifest.display}` : '未找到 manifest');
  } catch (err) {
    add('manifest', 'PWA manifest', 'fail', String(err.message || err));
  }

  // 5. Dictionary data
  try {
    const stats = dictionaryService.stats();
    const dictCount = await dictionaryRepo.count();
    add('dictionary', '词典数据', dictCount > 0 ? 'pass' : 'warn',
      `词条 ${dictCount} 条（索引中 ${stats.total}）`);
  } catch (err) {
    add('dictionary', '词典数据', 'fail', String(err.message || err));
  }

  // 6. Notebook
  try {
    const count = await favoriteRepo.count();
    add('notebook', '我的词汇', 'pass', `${count} 条记录`);
  } catch (err) {
    add('notebook', '我的词汇', 'fail', String(err.message || err));
  }

  // 7. Audio cache
  try {
    const stats = await audioRepo.stats();
    add('audio', '语音缓存', stats.count ? 'pass' : 'warn',
      `${stats.count} 段音频，约 ${Math.round(stats.bytes / 1024)}KB`);
  } catch (err) {
    add('audio', '语音缓存', 'fail', String(err.message || err));
  }

  // 8. TTS
  try {
    const status = TTSService.status();
    const voices = TTSService.listPtVoices();
    const level = status.provider === 'device' ? 'warn' : status.configured ? 'pass' : 'warn';
    add('tts', '巴西葡语语音 (pt-BR)', level,
      `当前提供方：${status.provider}｜设备 pt-BR 语音：${voices.length ? voices.map((v) => v.name).join('、') : '未检测到'}`);
  } catch (err) {
    add('tts', '巴西葡语语音 (pt-BR)', 'fail', String(err.message || err));
  }

  // 9. AI
  try {
    const status = AIService.status();
    add('ai', 'AI 分析服务', status.provider === 'mock' ? 'warn' : status.configured ? 'pass' : 'warn',
      status.provider === 'mock'
        ? '当前为示例数据（非 AI），可在设置中配置真实服务'
        : `提供方：${status.provider}｜模型：${status.model}`);
  } catch (err) {
    add('ai', 'AI 分析服务', 'fail', String(err.message || err));
  }

  // 10. Excel support
  try {
    add('xlsx', 'Excel (.xlsx) 导入支持', typeof DecompressionStream !== 'undefined' ? 'pass' : 'warn',
      typeof DecompressionStream !== 'undefined' ? '支持（内置解压 + XML 解析）' : '此系统版本不支持，请使用 CSV 导入');
  } catch (err) {
    add('xlsx', 'Excel (.xlsx) 导入支持', 'fail', String(err.message || err));
  }

  // 11. Scheduler sanity
  try {
    const sample = { ease: 2.5, intervalDays: 0, streak: 0, masteryLevel: 'new', reviewCount: 0 };
    const good = SRS.schedule(sample, 'good');
    const again = SRS.schedule(sample, 'again');
    const ok = good.intervalDays === 1 && good.masteryLevel === 'learning' && again.masteryLevel === 'learning';
    add('srs', '复习算法', ok ? 'pass' : 'fail', `认识→${good.intervalDays}天(${good.masteryLevel})，不认识→${again.masteryLevel}`);
  } catch (err) {
    add('srs', '复习算法', 'fail', String(err.message || err));
  }

  // 12. Resources
  try {
    const list = await resourceRepo.all();
    add('resources', '资源中心', 'pass', `已安装 ${list.length} 个资源包`);
  } catch (err) {
    add('resources', '资源中心', 'fail', String(err.message || err));
  }

  const failed = results.filter((r) => r.status === 'fail').length;
  const warned = results.filter((r) => r.status === 'warn').length;
  return {
    version: APP_VERSION,
    ranAt: Date.now(),
    results,
    summary: { passed: results.length - failed - warned, failed, warned, total: results.length }
  };
}

export const diagnosticsService = { environment, runSelfTest };
