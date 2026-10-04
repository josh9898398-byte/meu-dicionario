/** 词典 — full search with type filters and personal + dictionary results. */

import { viewRoot, setTitle } from '../shell.js';
import {
  h, replaceChildren, btn, chip, listRow, emptyState, typeBadge, badge,
  audioButton, starButton, spinner, navigate
} from '../components.js';
import { svgIcon } from '../../core/dom.js';
import { dictionaryService } from '../../services/dictionaryService.js';
import { favoriteRepo } from '../../db/repos.js';
import { bus, EVENTS } from '../../core/events.js';
import { capabilityService } from '../../services/capabilityService.js';

const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'word', label: '单词' },
  { id: 'phrase', label: '词组' },
  { id: 'expression', label: '表达' },
  { id: 'personal', label: '我的收藏' }
];

export default async function dictionaryPage(route) {
  const initialQuery = route.query.q || '';
  setTitle('词典', {
    back: false,
    actions: [
      h('button', { class: 'iconbtn', type: 'button', 'aria-label': '添加新词', on: { click: () => navigate('/add') } }, svgIcon('plus', 20))
    ]
  });

  const root = viewRoot();
  const input = h('input', {
    class: 'search__input',
    type: 'search',
    value: initialQuery,
    placeholder: '搜索单词、词组或中文释义',
    enterkeyhint: 'search',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false'
  });
  let filter = 'all';
  const filterRow = h('div', { class: 'chiprow' });
  const resultHost = h('div', { class: 'stack' });
  const metaHost = h('p', { class: 'searchmeta' });

  const form = h('form', { class: 'search search--compact', role: 'search' },
    h('div', { class: 'search__field' },
      h('span', { class: 'search__icon' }, svgIcon('search', 18)),
      input,
      h('button', { class: 'search__clear', type: 'button', 'aria-label': '清空', text: '×' })
    )
  );

  const clearBtn = form.querySelector('.search__clear');
  clearBtn.addEventListener('click', () => { input.value = ''; clearBtn.hidden = true; run(); input.focus(); });

  root.replaceChildren(h('div', { class: 'page' },
    h('div', { class: 'page__pad sticky-search' }, form, filterRow, metaHost),
    resultHost
  ));

  function renderFilters() {
    replaceChildren(filterRow, ...FILTERS.map((f) => chip(f.label, {
      active: filter === f.id,
      onClick: () => { filter = f.id; renderFilters(); run(); }
    })));
  }

  let timer = null;
  input.addEventListener('input', () => {
    clearBtn.hidden = !input.value;
    clearTimeout(timer);
    timer = setTimeout(run, 200);
  });
  form.addEventListener('submit', (event) => { event.preventDefault(); run(); });

  async function run() {
    const query = input.value.trim();
    clearTimeout(timer);
    if (!query) {
      replaceChildren(metaHost);
      replaceChildren(resultHost, browseView());
      return;
    }
    replaceChildren(resultHost, spinner('搜索中…'));
    const types = filter === 'all' || filter === 'personal' ? null : [filter];
    const results = await dictionaryService.search(query, { limit: 80, types });
    const filtered = filter === 'personal' ? results.filter((r) => r.entry.isPersonal) : results;

    replaceChildren(metaHost, filtered.length
      ? `${filtered.length} 个结果 · “${query}”`
      : '');

    if (!filtered.length) {
      const aiReady = capabilityService.isAIAvailable();
      replaceChildren(resultHost, emptyState(`没有找到“${query}”`, {
        message: aiReady
          ? '词典里没有这个词。可以用 AI 分析并保存到我的词汇，或换个关键词。'
          : '词典里没有这个词。可以先保存到我的词汇，或换个关键词（AI 分析暂未启用）。',
        action: h('div', { class: 'row row--gap' },
          aiReady
            ? btn('AI 分析并保存', { icon: 'sparkles', onClick: () => navigate(`/add?text=${encodeURIComponent(query)}`) })
            : null,
          btn('保存到我的词汇', {
            tone: aiReady ? 'ghost' : 'primary',
            icon: 'plus',
            onClick: () => navigate(`/add?text=${encodeURIComponent(query)}&manual=1`)
          })
        )
      }));
      return;
    }
    replaceChildren(resultHost, h('div', { class: 'card card--list' }, filtered.map(resultRow)));
  }

  function resultRow(result) {
    const entry = result.entry;
    const translation = (entry.translations || [])[0] || entry.meanings?.[0]?.definition || '';
    const matchHint = {
      exact: '完全匹配',
      normalized: '忽略重音匹配',
      prefix: '前缀匹配',
      word: '词组中的词',
      contains: '包含',
      fuzzy: '近似拼写',
      chinese: '中文释义匹配',
      favorite: '我的收藏'
    }[result.matchType] || '';

    return listRow({
      title: entry.headword,
      subtitle: translation,
      badges: [
        typeBadge(entry.type),
        entry.isPersonal ? badge('我的', 'amber') : null,
        entry.partOfSpeech ? badge(entry.partOfSpeech, 'neutral') : null
      ].filter(Boolean),
      meta: matchHint ? `${matchHint}${entry.frequencyRank ? ` · 高频第 ${entry.frequencyRank}` : ''}` : (entry.frequencyRank ? `高频第 ${entry.frequencyRank}` : ''),
      onClick: () => {
        if (entry.isPersonal && entry.favoriteId) navigate(`/fav/${encodeURIComponent(entry.favoriteId)}`);
        else navigate(`/entry/${encodeURIComponent(entry.id)}`);
      },
      right: audioButton(entry.headword, { compact: true })
    });
  }

  function browseView() {
    const stats = dictionaryService.stats();
    const byType = stats.byType || {};
    return h('div', { class: 'stack' },
      h('div', { class: 'card' },
        h('h2', { class: 'card__title', text: '词典概览' }),
        h('div', { class: 'stats-grid stats-grid--small' },
          stat('词汇', byType.word || 0),
          stat('词组', byType.phrase || 0),
          stat('表达', byType.expression || 0),
          stat('句子', byType.sentence || 0)
        ),
        h('p', { class: 'muted small', text: `已收录 ${stats.total} 条 · 可在资源中心下载更多词表` })
      ),
      h('div', { class: 'card' },
        h('h2', { class: 'card__title', text: '试试这些' }),
        h('div', { class: 'row row--wrap row--gap-sm' }, ['aproveitar', 'dar conta', 'saudade', 'ficar de boa', 'trabalho', 'beleza', 'prazo'].map((word) => h('button', {
          class: 'phrasechip',
          type: 'button',
          text: word,
          on: { click: () => { input.value = word; clearBtn.hidden = false; run(); } }
        })))
      ),
      h('div', { class: 'card' },
        h('h2', { class: 'card__title', text: '用中文搜' }),
        h('p', { class: 'muted small', text: '直接输入中文也能搜：例如「应付」「想念」「赶时间」。' })
      )
    );
  }

  function stat(label, value) {
    return h('div', { class: 'stat stat--mini' }, h('span', { class: 'stat__value', text: String(value) }), h('span', { class: 'stat__label', text: label }));
  }

  renderFilters();
  await dictionaryService.init();
  if (initialQuery) clearBtn.hidden = false;
  await run();

  const offFav = bus.on(EVENTS.FAVORITES_CHANGED, () => { run().catch(() => {}); });
  return { unmount() { clearTimeout(timer); offFav(); } };
}
