/** Reusable UI building blocks. All text goes through textContent (XSS safe). */

import { h, replaceChildren, svgIcon, on } from '../core/dom.js';
import { TTSService } from '../services/ttsService.js';
import { dictionaryService } from '../services/dictionaryService.js';
import { favoriteRepo } from '../db/repos.js';
import { bus, EVENTS } from '../core/events.js';
import { toast, openSheet } from './shell.js';
import { navigate } from '../core/router.js';
import { relTime, dateTime } from '../core/format.js';
import { ENTRY_TYPES, MASTERY_LEVELS } from '../db/schema.js';

export { h, replaceChildren };

/* --------------------------------------------------------------- buttons */

export function btn(label, { onClick, tone = 'primary', icon = null, block = false, disabled = false, type = 'button', size = 'md' } = {}) {
  return h('button', {
    class: `btn btn--${tone}${block ? ' btn--block' : ''} btn--${size}`,
    type,
    disabled,
    on: { click: onClick }
  }, icon ? svgIcon(icon, 18) : null, h('span', { text: label }));
}

export function iconBtn(icon, { onClick, label, tone = 'ghost', disabled = false } = {}) {
  return h('button', {
    class: `iconbtn iconbtn--${tone}`, type: 'button', 'aria-label': label, title: label, disabled,
    on: { click: onClick }
  }, svgIcon(icon, 20));
}

export function chip(label, { active = false, onClick, count = null, color = null } = {}) {
  return h('button', {
    class: `chip${active ? ' is-active' : ''}`,
    type: 'button',
    style: color && active ? { background: color, borderColor: color, color: '#fff' } : null,
    on: { click: onClick }
  }, h('span', { text: label }), count !== null ? h('span', { class: 'chip__count', text: String(count) }) : null);
}

export function badge(text, tone = 'neutral') {
  return h('span', { class: `badge badge--${tone}`, text });
}

export function typeBadge(type) {
  const label = ENTRY_TYPES[type]?.label || type || '词条';
  const tone = type === 'word' ? 'blue' : type === 'expression' ? 'purple' : type === 'sentence' ? 'amber' : 'teal';
  return badge(label, tone);
}

export function masteryBadge(level) {
  const label = MASTERY_LEVELS[level]?.label || '新词';
  const tone = level === 'mastered' ? 'green' : level === 'familiar' ? 'teal' : level === 'learning' ? 'amber' : 'neutral';
  return badge(label, tone);
}

/* ----------------------------------------------------------------- audio */

/**
 * Playback button with 3 visible states: idle / preparing / playing.
 * When a clip is not cached and the device is offline, it says so instead of
 * failing silently (see TTSService offline contract).
 */
export function audioButton(text, { label = '播放', compact = false, voice = '', onError = null } = {}) {
  const button = h('button', {
    class: `audiobtn${compact ? ' audiobtn--compact' : ''}`,
    type: 'button',
    'aria-label': `${label}：${text.slice(0, 40)}`
  }, svgIcon('play', compact ? 16 : 18), h('span', { class: 'audiobtn__label', text: compact ? '' : label }));

  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (button.dataset.state === 'loading') return;
    try {
      button.dataset.state = 'loading';
      button.classList.add('is-loading');
      await TTSService.unlock();
      await TTSService.speak(text, { voice, wait: false });
      button.dataset.state = 'playing';
      button.classList.add('is-playing');
      setTimeout(() => {
        button.dataset.state = '';
        button.classList.remove('is-playing', 'is-loading');
      }, 1400);
    } catch (err) {
      button.dataset.state = '';
      button.classList.remove('is-playing', 'is-loading');
      onError?.(err);
      const message = err?.code === 'offline-no-audio'
        ? '该音频尚未缓存，需要联网生成'
        : err?.message || '播放失败';
      toast(message, { tone: err?.code === 'offline-no-audio' ? 'warn' : 'error' });
    }
  });

  bus.on(EVENTS.PLAY_AUDIO, (payload) => {
    if (payload?.text !== text) return;
    button.click();
  });

  return button;
}

/* ------------------------------------------------------------- favourites */

/** ⭐ 收藏 / ⭐ 已收藏 toggle. Used on every content surface. */
export async function starButton(target, { onChange = null, block = false, labelAdd = '收藏', labelRemove = '已收藏' } = {}) {
  const input = normalizeFavoriteTarget(target);
  const existing = await findExisting(input);
  const button = h('button', {
    class: `starbtn${existing ? ' is-active' : ''}${block ? ' starbtn--block' : ''}`,
    type: 'button',
    'aria-pressed': existing ? 'true' : 'false'
  },
  svgIcon('star', 20),
  h('span', { class: 'starbtn__label', text: existing ? labelRemove : labelAdd }));

  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (button.dataset.busy) return;
    button.dataset.busy = '1';
    try {
      const current = await findExisting(input);
      if (current) {
        await favoriteRepo.remove(current.id);
        button.classList.remove('is-active');
        button.setAttribute('aria-pressed', 'false');
        replaceChildren(button, svgIcon('star', 20), h('span', { class: 'starbtn__label', text: labelAdd }));
        toast('已从我的词汇移除');
        onChange?.({ added: false, favorite: null });
        bus.emit(EVENTS.FAVORITES_CHANGED, { action: 'remove', id: current.id });
      } else {
        const created = await favoriteRepo.create(input);
        button.classList.add('is-active');
        button.setAttribute('aria-pressed', 'true');
        replaceChildren(button, svgIcon('star', 20), h('span', { class: 'starbtn__label', text: labelRemove }));
        toast('已加入我的词汇 ⭐');
        onChange?.({ added: true, favorite: created });
        bus.emit(EVENTS.FAVORITES_CHANGED, { action: 'add', id: created.id });
        if (TTSService.getSettings().prefetchOnSave && input.headword) {
          TTSService.prefetch([input.headword]).catch(() => {});
        }
      }
    } catch (err) {
      toast(err?.message || '操作失败', { tone: 'error' });
    } finally {
      delete button.dataset.busy;
    }
  });
  return button;
}

function normalizeFavoriteTarget(target) {
  if (target?.isDictionaryEntry) {
    return { ...dictionaryService.entryToFavoriteInput(target), source: target.sourceKind || 'dictionary' };
  }
  if (target?.favorite) return target.favorite;
  return {
    customText: target.customText || target.headword || target.text || '',
    headword: target.headword || target.text || '',
    type: target.type || 'word',
    translation: target.translation || '',
    partOfSpeech: target.partOfSpeech || '',
    dictionaryEntryId: target.dictionaryEntryId ?? null,
    examples: target.examples || [],
    tags: target.tags || [],
    source: target.source || 'manual'
  };
}

async function findExisting(input) {
  if (input.dictionaryEntryId) {
    const byEntry = await favoriteRepo.findByEntryId(input.dictionaryEntryId);
    if (byEntry) return byEntry;
  }
  return favoriteRepo.findByText(input.customText || input.headword);
}

/* ------------------------------------------------------- clickable content */

/**
 * Sentence where every word is tappable. Tapping a word first tries the
 * surrounding expression ("dar conta de"), then the single word.
 */
export function clickableSentence(sentence, { translation = '', onWordTap = null, source = '', compact = false } = {}) {
  const tokens = dictionaryService.tokenizeForDisplay(sentence);
  const words = [];
  const wrap = h('p', { class: `sentence${compact ? ' sentence--compact' : ''}` });
  for (const token of tokens) {
    if (token.type === 'sep') {
      wrap.appendChild(document.createTextNode(token.text));
      continue;
    }
    words.push(token.text);
    const index = words.length - 1;
    const wordEl = h('button', {
      class: 'tok',
      type: 'button',
      text: token.text,
      dataset: { index: String(index) }
    });
    wordEl.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (onWordTap) { onWordTap(token.text, index); return; }
      await openWordPopup({ tokens: words, index, sentence, translation, source });
    });
    wrap.appendChild(wordEl);
  }
  return wrap;
}

export function exampleCard(example, { showTranslation = true, onJump = null } = {}) {
  const pt = example.sourceText || example.pt || '';
  const zh = example.translation || example.zh || '';
  return h('div', { class: 'example' },
    h('div', { class: 'example__row' },
      audioButton(pt, { compact: true }),
      clickableSentence(pt, { translation: zh, source: example.source })
    ),
    showTranslation && zh ? h('p', { class: 'example__zh', text: zh }) : null,
    example.note ? h('p', { class: 'example__note', text: example.note }) : null,
    onJump ? h('button', { class: 'linkbtn', type: 'button', text: '查看词组', on: { click: () => onJump(example) } }) : null
  );
}

/** Dictionary/expression popup used when tapping a word inside a sentence. */
export async function openWordPopup({ tokens, index, sentence, translation = '', source = '' }) {
  const tokensText = tokens || dictionaryService.tokenizeForDisplay(sentence).filter((t) => t.type === 'word').map((t) => t.text);
  const match = await dictionaryService.matchPhraseAt(tokensText, index, { maxSpan: 5 });
  const entry = match?.entry || await dictionaryService.lookup(tokensText[index]);
  const headword = entry?.headword || tokensText[index];
  const type = entry?.type || 'word';

  const content = h('div', { class: 'wordpop' });
  content.appendChild(h('div', { class: 'wordpop__head' },
    h('h2', { class: 'wordpop__word', text: headword }),
    h('div', { class: 'wordpop__badges' }, typeBadge(type), entry?.partOfSpeech ? badge(entry.partOfSpeech, 'neutral') : null)
  ));
  content.appendChild(h('div', { class: 'row row--wrap row--gap' },
    audioButton(headword, { label: '播放发音' }),
    await starButton(entry ? { ...entry, isDictionaryEntry: true } : { headword, type, source: 'sentence' }, {
      onChange: () => bus.emit(EVENTS.FAVORITES_CHANGED, { action: 'toggle' })
    })
  ));
  if (entry?.translations?.length) {
    content.appendChild(h('p', { class: 'wordpop__translation', text: entry.translations.join('；') }));
  } else {
    content.appendChild(h('p', { class: 'muted', text: '词典中暂无此词的释义。可以收藏后使用「AI 整理」补充。' }));
  }
  if (entry?.meanings?.length) {
    content.appendChild(h('ul', { class: 'meaninglist' }, entry.meanings.map((m) => h('li', {},
      h('span', { class: 'meaninglist__def', text: m.definition || '' }),
      m.note ? h('span', { class: 'meaninglist__note', text: m.note }) : null
    ))));
  }
  if (entry?.patterns?.length) content.appendChild(kvBlock('常见结构', entry.patterns));
  if (entry?.collocations?.length) content.appendChild(chipBlock('常见搭配', entry.collocations));
  if (entry?.relatedExpressions?.length) content.appendChild(chipBlock('相关表达', entry.relatedExpressions));
  if (entry?.examples?.length) {
    content.appendChild(h('h3', { class: 'section__title', text: '例句' }));
    for (const example of entry.examples.slice(0, 4)) content.appendChild(exampleCard(example));
  }
  if (entry?.id && !entry.isPersonal) {
    content.appendChild(btn('打开完整词条', {
      tone: 'ghost',
      icon: 'arrowRight',
      block: true,
      onClick: () => { navigate(`/entry/${encodeURIComponent(entry.id)}`); }
    }));
  }
  openSheet({ title: '生词速查', content, size: 'tall' });
}

/* ------------------------------------------------------------- primitives */

export function sectionTitle(text, { action = null } = {}) {
  return h('div', { class: 'section__head' },
    h('h2', { class: 'section__title', text }),
    action
  );
}

export function kvBlock(title, values) {
  if (!values?.length) return h('span');
  return h('div', { class: 'block' },
    h('h3', { class: 'block__title', text: title }),
    h('ul', { class: 'block__list' }, values.map((v) => h('li', { text: typeof v === 'string' ? v : v.definition || '' })))
  );
}

export function chipBlock(title, values, { onPick = null } = {}) {
  if (!values?.length) return h('span');
  const items = values.map((value) => {
    const text = typeof value === 'string' ? value : value.text || '';
    return h('button', {
      class: 'phrasechip',
      type: 'button',
      text,
      on: {
        click: () => {
          if (onPick) { onPick(value); return; }
          const words = dictionaryService.tokenizeForDisplay(text)
            .filter((token) => token.type === 'word')
            .map((token) => token.text);
          openWordPopup({ tokens: words, index: 0, sentence: text });
        }
      }
    });
  });
  return h('div', { class: 'block' },
    h('h3', { class: 'block__title', text: title }),
    h('div', { class: 'row row--wrap row--gap-sm' }, items)
  );
}

export function statTile(label, value, { hint = '', tone = 'default', onClick = null } = {}) {
  return h(onClick ? 'button' : 'div', {
    class: `stat stat--${tone}${onClick ? ' stat--clickable' : ''}`,
    type: onClick ? 'button' : null,
    on: onClick ? { click: onClick } : null
  },
  h('span', { class: 'stat__value', text: String(value) }),
  h('span', { class: 'stat__label', text: label }),
  hint ? h('span', { class: 'stat__hint', text: hint }) : null);
}

export function emptyState(title, { message = '', action = null, icon = 'info' } = {}) {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty__icon' }, svgIcon(icon, 30)),
    h('h3', { class: 'empty__title', text: title }),
    message ? h('p', { class: 'empty__text', text: message }) : null,
    action || null
  );
}

export function spinner(text = '加载中…') {
  return h('div', { class: 'spinner' }, h('span', { class: 'spinner__dot' }), h('span', { text }));
}

export function progressBar(percent) {
  const value = Math.max(0, Math.min(100, Math.round(percent)));
  return h('div', { class: 'progress' }, h('div', { class: 'progress__fill', style: { width: `${value}%` } }));
}

export function field(label, input, { hint = '' } = {}) {
  return h('label', { class: 'field' },
    h('span', { class: 'field__label', text: label }),
    input,
    hint ? h('span', { class: 'field__hint', text: hint }) : null
  );
}

export function textInput({ value = '', placeholder = '', onInput = null, onEnter = null, type = 'text', autofocus = false, inputmode = null, name = null } = {}) {
  const input = h('input', { class: 'input', type, value, placeholder, inputmode, name });
  if (onInput) input.addEventListener('input', () => onInput(input.value));
  if (onEnter) input.addEventListener('keydown', (event) => { if (event.key === 'Enter') onEnter(input.value); });
  if (autofocus) setTimeout(() => input.focus(), 120);
  return input;
}

export function textArea({ value = '', placeholder = '', onInput = null, rows = 4 } = {}) {
  const area = h('textarea', { class: 'input input--area', rows, placeholder }, value ? document.createTextNode(value) : null);
  if (value) area.value = value;
  if (onInput) area.addEventListener('input', () => onInput(area.value));
  return area;
}

export function select(options, { value = null, onChange = null } = {}) {
  const el = h('select', { class: 'input input--select' },
    options.map((opt) => h('option', { value: opt.value, selected: opt.value === value, text: opt.label })));
  el.value = value ?? options[0]?.value ?? '';
  if (onChange) el.addEventListener('change', () => onChange(el.value));
  return el;
}

export function segmented(options, { value, onChange }) {
  let current = value;
  const wrap = h('div', { class: 'segmented', role: 'tablist' });
  const render = () => replaceChildren(wrap, ...options.map((opt) => h('button', {
    class: `segmented__item${opt.value === current ? ' is-active' : ''}`,
    type: 'button',
    role: 'tab',
    'aria-selected': opt.value === current ? 'true' : 'false',
    text: opt.label,
    on: {
      click: () => {
        if (current === opt.value) return;
        current = opt.value;
        render();
        onChange?.(opt.value);
      }
    }
  })));
  render();
  return wrap;
}

export function listRow({ title, subtitle = '', meta = '', right = null, onClick = null, leading = null, badges = [] }) {
  const content = h('div', { class: 'listrow__content' },
    h('div', { class: 'listrow__titleline' },
      h('span', { class: 'listrow__title', text: title }),
      badges.length ? h('span', { class: 'listrow__badges' }, badges) : null
    ),
    subtitle ? h('div', { class: 'listrow__subtitle', text: subtitle }) : null,
    meta ? h('div', { class: 'listrow__meta', text: meta }) : null
  );
  return h(onClick ? 'button' : 'div', {
    class: `listrow${onClick ? ' listrow--clickable' : ''}`,
    type: onClick ? 'button' : null,
    on: onClick ? { click: onClick } : null
  }, leading || null, content, right ? h('div', { class: 'listrow__right' }, right) : null);
}

export function tagChips(tags, { onRemove = null, max = 6 } = {}) {
  const list = (tags || []).slice(0, max);
  return h('div', { class: 'row row--wrap row--gap-sm' }, list.map((tag) => h('span', { class: 'tagchip' },
    h('span', { text: `#${tag}` }),
    onRemove ? h('button', { class: 'tagchip__x', type: 'button', 'aria-label': `移除标签 ${tag}`, text: '×', on: { click: () => onRemove(tag) } }) : null
  )));
}

export function metaLine(parts) {
  const items = parts.filter((p) => p !== null && p !== undefined && p !== '');
  if (!items.length) return h('span');
  const wrap = h('div', { class: 'metalist' });
  items.forEach((item, i) => {
    if (i) wrap.appendChild(h('span', { class: 'metalist__sep', text: '·' }));
    wrap.appendChild(h('span', { class: 'metalist__item', text: String(item) }));
  });
  return wrap;
}

export function reviewMeta(favorite) {
  return metaLine([
    MASTERY_LEVELS[favorite.masteryLevel]?.label,
    favorite.reviewCount ? `复习 ${favorite.reviewCount} 次` : '未复习',
    favorite.lastReviewedAt ? `上次 ${relTime(favorite.lastReviewedAt)}` : '',
    favorite.nextReviewAt ? `下次 ${relTime(favorite.nextReviewAt)}` : ''
  ]);
}

export function confirmInline(message, { onConfirm, confirmLabel = '删除' }) {
  return h('div', { class: 'inline-confirm' },
    h('span', { text: message }),
    btn(confirmLabel, { tone: 'danger', size: 'sm', onClick: onConfirm })
  );
}

export { toast, openSheet, dateTime, relTime, navigate, bus, EVENTS };
