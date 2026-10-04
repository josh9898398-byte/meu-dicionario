/** App shell: title bar, back button, bottom navigation, status banner, toast. */

import { h, replaceChildren, $, svgIcon, on } from '../core/dom.js';
import { navigate, currentRoute } from '../core/router.js';
import { bus, EVENTS } from '../core/events.js';
import { isOnline, subscribe as subscribeConnectivity } from '../services/connectivityService.js';

export const TABS = [
  { id: 'home', label: '首页', icon: 'home', path: '/home' },
  { id: 'dict', label: '词典', icon: 'book', path: '/dict' },
  { id: 'notebook', label: '我的词汇', icon: 'star', path: '/notebook' },
  { id: 'study', label: '学习', icon: 'cards', path: '/study' },
  { id: 'settings', label: '设置', icon: 'gear', path: '/settings' }
];

const els = {};
let currentTab = 'home';

export function initShell() {
  els.appbarTitle = $('#appbar-title');
  els.appbarBack = $('#appbar-back');
  els.appbarActions = $('#appbar-actions');
  els.status = $('#appbar-status');
  els.view = $('#view');
  els.tabbar = $('#tabbar');
  els.toastHost = $('#toast-host');

  els.appbarBack.addEventListener('click', () => {
    if (window.history.length > 1) window.history.back();
    else navigate('/home');
  });

  renderTabbar();
  subscribeConnectivity(() => updateConnectivity());
  updateConnectivity();
  watchKeyboard();
  bus.on(EVENTS.TOAST, (payload) => toast(payload));
  bus.on(EVENTS.NAVIGATE, (route) => {
    const tab = TABS.find((t) => route.path.startsWith(`/${t.id}`) || (t.id === 'dict' && route.path.startsWith('/entry')));
    setActiveTab(tab ? tab.id : currentTab);
  });
}

export function viewRoot() {
  return els.view;
}

export function setTitle(title, { back = false, actions = [] } = {}) {
  els.appbarTitle.textContent = title;
  els.appbarBack.hidden = !back;
  replaceChildren(els.appbarActions, ...actions);
}

export function setActiveTab(id) {
  currentTab = id;
  for (const btn of els.tabbar.querySelectorAll('button[data-tab]')) {
    const active = btn.dataset.tab === id;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-current', active ? 'page' : 'false');
  }
}

export function scrollTop({ smooth = false } = {}) {
  window.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
}

function renderTabbar() {
  replaceChildren(els.tabbar, ...TABS.map((tab) => h('button', {
    type: 'button',
    class: 'tabbar__item',
    dataset: { tab: tab.id },
    'aria-label': tab.label,
    on: {
      click: () => {
        if (tab.id === 'add') return;
        navigate(tab.path);
      }
    }
  }, svgIcon(tab.icon, 22), h('span', { class: 'tabbar__label', text: tab.label }))));
}

function updateConnectivity() {
  const online = isOnline();
  els.status.hidden = online;
  if (!online) {
    replaceChildren(els.status, svgIcon('wifiOff', 14), h('span', { text: '离线模式 · AI 功能需要联网，词典与我的词汇仍可使用' }));
  }
  document.documentElement.classList.toggle('is-offline', !online);
}

/**
 * iPhone Safari: when the keyboard opens, a fixed bottom nav would sit on top of
 * the input. Detect the visual-viewport shrink and hide the nav while typing.
 */
function watchKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const update = () => {
    const shrink = window.innerHeight - vv.height;
    const typing = shrink > 120 && vv.height < window.innerHeight * 0.75;
    document.documentElement.classList.toggle('keyboard-open', typing);
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}

/* ------------------------------------------------------------------ toast */

export function toast(message, { tone = 'info', duration = 2600, action = null } = {}) {
  const node = h('div', { class: `toast toast--${tone}`, role: 'status' },
    h('span', { class: 'toast__text', text: message }),
    action ? h('button', {
      class: 'toast__action',
      type: 'button',
      text: action.label,
      on: { click: () => { action.run?.(); dismiss(); } }
    }) : null
  );
  els.toastHost.appendChild(node);
  const dismiss = () => node.remove();
  setTimeout(dismiss, duration + (action ? 4000 : 0));
  return dismiss;
}

export function toastError(err, fallback = '操作失败') {
  const message = err?.message || String(err || fallback);
  const offline = err?.code === 'offline' || err?.code === 'offline-no-audio';
  toast(offline ? message : `${fallback}：${message}`, { tone: offline ? 'warn' : 'error', duration: 4200 });
}

/* ------------------------------------------------------------------- sheet */

export function openSheet({ title, content, actions = [], size = 'auto', onClose = null, dismissible = true }) {
  const host = $('#sheet-host');
  const backdrop = h('div', { class: 'sheet-backdrop' });
  const panel = h('div', { class: `sheet sheet--${size}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '面板' });
  const close = () => {
    if (!dismissible) return;
    backdrop.classList.remove('is-open');
    panel.classList.remove('is-open');
    setTimeout(() => { backdrop.remove(); panel.remove(); onClose?.(); }, 180);
  };

  replaceChildren(panel,
    h('div', { class: 'sheet__handle' }),
    title ? h('div', { class: 'sheet__header' },
      h('h2', { class: 'sheet__title', text: title }),
      h('button', { class: 'iconbtn', type: 'button', 'aria-label': '关闭', on: { click: close } }, svgIcon('close', 18))
    ) : null,
    h('div', { class: 'sheet__body' }, content),
    actions.length ? h('div', { class: 'sheet__actions' }, actions) : null
  );

  backdrop.addEventListener('click', close);
  host.appendChild(backdrop);
  host.appendChild(panel);
  requestAnimationFrame(() => {
    backdrop.classList.add('is-open');
    panel.classList.add('is-open');
  });
  return { close, panel };
}

export function confirmDialog({ title = '确认', message, confirmLabel = '确定', cancelLabel = '取消', tone = 'primary' }) {
  return new Promise((resolve) => {
    const { close } = openSheet({
      title,
      content: h('p', { class: 'sheet__text', text: message }),
      actions: [
        h('button', { class: 'btn btn--ghost', type: 'button', text: cancelLabel, on: { click: () => { close(); resolve(false); } } }),
        h('button', { class: `btn btn--${tone}`, type: 'button', text: confirmLabel, on: { click: () => { close(); resolve(true); } } })
      ],
      onClose: () => resolve(false)
    });
  });
}
