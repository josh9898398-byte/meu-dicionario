/**
 * Application entry point.
 *
 * Boot order matters on iOS:
 *   1. connectivity + settings (cheap, no network)
 *   2. IndexedDB bootstrap + bundled dictionary packs
 *   3. service worker registration (offline shell for the next launch)
 *   4. router
 */

import { $ } from './core/dom.js';
import { defineRoute, startRouter, navigate } from './core/router.js';
import { toastError, initShell, viewRoot } from './ui/shell.js';
import { ensureBaseData, enablePersistentStorage } from './services/bootstrap.js';
import { AIService } from './services/aiService.js';
import { TTSService } from './services/ttsService.js';
import { dictionaryService } from './services/dictionaryService.js';
import { init as initConnectivity } from './services/connectivityService.js';
import { capabilityService } from './services/capabilityService.js';
import { settingsRepo } from './db/repos.js';
import { emptyState, btn, h } from './ui/components.js';
import { APP_VERSION } from './config.js';

import homePage from './ui/pages/homePage.js';
import dictionaryPage from './ui/pages/dictionaryPage.js';
import entryPage from './ui/pages/entryPage.js';
import notebookPage from './ui/pages/notebookPage.js';
import favoritePage from './ui/pages/favoritePage.js';
import studyPage from './ui/pages/studyPage.js';
import addPage from './ui/pages/addPage.js';
import importPage from './ui/pages/importPage.js';
import resourcesPage from './ui/pages/resourcesPage.js';
import settingsPage from './ui/pages/settingsPage.js';
import aboutPage from './ui/pages/aboutPage.js';

const bootEl = $('#boot');
const bootText = bootEl?.querySelector('.boot__text');

function setBootText(text) {
  if (bootText) bootText.textContent = text;
}

async function boot() {
  initConnectivity();
  initShell();

  try {
    if (navigator.storage?.persisted) enablePersistentStorage().catch(() => {});
    setBootText('正在准备本地数据…');
    const result = await ensureBaseData({ onProgress: ({ pack }) => setBootText(`正在安装：${pack}`) });
    setBootText('正在启动…');

    await Promise.all([
      AIService.init().catch(() => {}),
      TTSService.init().catch(() => {}),
      dictionaryService.refresh().catch(() => {})
    ]);

    // Learn whether the backend AI/TTS is really available (never touches keys)
    await capabilityService.hydrate().catch(() => {});
    capabilityService.refresh().catch(() => {});

    const theme = await settingsRepo.get('ui.theme', 'auto');
    applyTheme(theme);

    registerRoutes();
    startRouter({ notFound: renderNotFound });
    registerServiceWorker();
    registerGlobalHandlers();

    if (!window.location.hash) navigate('/home', { replace: true });
    bootEl?.classList.add('is-hidden');
    setTimeout(() => bootEl?.remove(), 400);

    if (result?.installed?.length) {
      const total = result.installed.reduce((sum, p) => sum + (p.count || 0), 0);
      console.info(`[boot] installed ${result.installed.length} packs, ${total} entries`);
    }
  } catch (err) {
    console.error('[boot] failed', err);
    renderFatal(err);
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme || 'auto';
}

function registerRoutes() {
  defineRoute('/home', homePage);
  defineRoute('/dict', dictionaryPage);
  defineRoute('/entry/:id', entryPage);
  defineRoute('/notebook', notebookPage);
  defineRoute('/fav/:id', favoritePage);
  defineRoute('/study', studyPage);
  defineRoute('/add', addPage);
  defineRoute('/import', importPage);
  defineRoute('/resources', resourcesPage);
  defineRoute('/settings', settingsPage);
  defineRoute('/about', aboutPage);
}

function registerGlobalHandlers() {
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    if (reason?.name === 'AIError' || reason?.name === 'TTSError') return;
    console.warn('[unhandled]', reason);
  });
  window.addEventListener('error', (event) => {
    console.error('[error]', event.error || event.message);
  });
  // iOS Safari: make the first user gesture unlock audio elements for later playback.
  document.addEventListener('touchstart', () => { TTSService.unlock().catch(() => {}); }, { once: true, passive: true });
  document.addEventListener('click', () => { TTSService.unlock().catch(() => {}); }, { once: true });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  // Service workers require https or localhost; a plain http deploy simply
  // runs without offline support instead of breaking the app.
  if (window.location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(window.location.hostname)) {
    console.info('[sw] skipped: service worker needs HTTPS');
    return null;
  }
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    return reg;
  } catch (err) {
    console.warn('[sw] registration failed', err);
    return null;
  }
}

async function renderNotFound(route, error) {
  const root = viewRoot();
  root.replaceChildren(error
    ? emptyState('页面出错', { message: String(error.message || error), action: btn('回到首页', { onClick: () => navigate('/home') }) })
    : emptyState('页面不存在', { message: `没有找到 ${route?.path || ''}`, action: btn('回到首页', { onClick: () => navigate('/home') }) }));
  return {};
}

function renderFatal(err) {
  if (!bootEl) return;
  bootEl.classList.remove('is-hidden');
  bootEl.replaceChildren(
    emptyState('启动失败', {
      message: `${err?.message || err}\n\n常见原因：Safari 无痕模式会禁用本地数据库，请改用普通窗口打开。`,
      action: btn('重试', { onClick: () => window.location.reload() })
    }),
    h('p', { class: 'muted', text: `版本 ${APP_VERSION}` })
  );
}

boot();
