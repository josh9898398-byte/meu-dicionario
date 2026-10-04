/** 首页 — big search box, quick add, today's review, recent activity, stats. */

import { viewRoot, setTitle } from '../shell.js';
import {
  h, replaceChildren, iconBtn, btn, statTile, listRow, emptyState,
  masteryBadge, typeBadge, badge, audioButton, sectionTitle, navigate
} from '../components.js';
import { svgIcon } from '../../core/dom.js';
import { favoriteRepo, dictionaryRepo } from '../../db/repos.js';
import { dictionaryService } from '../../services/dictionaryService.js';
import { SRS } from '../../services/index.js';
import { AIService } from '../../services/aiService.js';
import { isOnline } from '../../services/connectivityService.js';
import { bus, EVENTS } from '../../core/events.js';
import { relTime } from '../../core/format.js';

export default async function homePage() {
  setTitle('Meu Dicionário', {
    back: false,
    actions: [iconBtn('download', { label: '资源中心', onClick: () => navigate('/resources') })]
  });

  const root = viewRoot();
  const searchInput = h('input', {
    class: 'search__input',
    type: 'search',
    placeholder: '搜索葡语或中文，例如 aproveitar、dar conta、应付',
    'aria-label': '搜索词典',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    enterkeyhint: 'search'
  });

  const suggestionBox = h('div', { class: 'search__suggestions' });
  const listHost = h('div', { class: 'stack' });

  const searchBox = h('form', { class: 'search', role: 'search' },
    h('div', { class: 'search__field' },
      h('span', { class: 'search__icon' }, svgIcon('search', 18)),
      searchInput,
      h('button', { class: 'search__clear', type: 'button', 'aria-label': '清空', text: '×', hidden: true })
    ),
    suggestionBox
  );

  const clearButton = searchBox.querySelector('.search__clear');
  clearButton.addEventListener('click', () => {
    searchInput.value = '';
    clearButton.hidden = true;
    replaceChildren(suggestionBox);
    searchInput.focus();
  });

  let suggestTimer = null;
  searchInput.addEventListener('input', () => {
    const value = searchInput.value.trim();
    clearButton.hidden = !value;
    clearTimeout(suggestTimer);
    if (!value) { replaceChildren(suggestionBox); return; }
    suggestTimer = setTimeout(async () => {
      const suggestions = await dictionaryService.suggest(value, 6);
      renderSuggestions(suggestionBox, suggestions, value);
    }, 200);
  });

  searchBox.addEventListener('submit', (event) => {
    event.preventDefault();
    const value = searchInput.value.trim();
    if (!value) { searchInput.focus(); return; }
    navigate(`/dict?q=${encodeURIComponent(value)}`);
  });

  root.replaceChildren(h('div', { class: 'page page--home' },
    h('section', { class: 'hero' },
      h('p', { class: 'hero__eyebrow', text: '我的个人巴西葡语语言数据库' }),
      searchBox,
      h('button', { class: 'quickadd', type: 'button', on: { click: () => navigate('/add') } },
        h('span', { class: 'quickadd__plus', text: '＋' }),
        h('span', {}, h('strong', { text: '添加新词' }), h('small', { text: '输入、粘贴或粘贴整句，AI 自动整理' }))
      )
    ),
    listHost
  ), h('div', { class: 'page__pad' }));

  async function refresh() {
    const [stats, all] = await Promise.all([SRS.stats(), favoriteRepo.allSorted()]);
    const dictionaryStats = dictionaryService.stats();
    const recent = all.slice(0, 5);
    const todayAdded = all.filter((f) => f.createdAt && Date.now() - f.createdAt < 86400000);
    const dueNow = all.filter((f) => !f.archived && (f.nextReviewAt || 0) <= Date.now());
    const aiStatus = AIService.status();

    replaceChildren(listHost,
      h('section', { class: 'stats-grid' },
        statTile('今日待复习', stats.dueNow, { tone: stats.dueNow ? 'warn' : 'default', onClick: () => navigate('/study?mode=due') }),
        statTile('今日新增', todayAdded.length, { onClick: () => navigate('/notebook') }),
        statTile('我的词汇', stats.total, { hint: '共收藏', onClick: () => navigate('/notebook') }),
        statTile('连续学习', `${stats.streakDays} 天`, { tone: stats.streakDays ? 'ok' : 'default' })
      ),

      !stats.total ? onboardingCard(aiStatus) : null,

      dueNow.length ? h('section', {},
        sectionTitle('今日待复习', { action: h('button', { class: 'linkbtn', type: 'button', text: '开始学习', on: { click: () => navigate('/study?mode=due') } }) }),
        h('div', { class: 'card card--list' }, dueNow.slice(0, 4).map((fav) => favoriteRow(fav)))
      ) : null,

      h('section', {},
        sectionTitle('最近收藏', { action: recent.length ? h('button', { class: 'linkbtn', type: 'button', text: '全部', on: { click: () => navigate('/notebook') } }) : null }),
        recent.length
          ? h('div', { class: 'card card--list' }, recent.map((fav) => favoriteRow(fav)))
          : emptyState('还没有收藏任何词', {
              message: '搜索一个词并点击 ⭐，或者用「＋ 添加新词」快速记录。',
              action: btn('搜索词典', { tone: 'ghost', icon: 'search', onClick: () => navigate('/dict') })
            })
      ),

      h('section', {},
        sectionTitle('学习统计'),
        h('div', { class: 'stats-grid stats-grid--small' },
          statTile('本週复习', stats.reviewsThisWeek, { hint: '次' }),
          statTile('正确率', `${stats.accuracy}%`, { hint: '累计' }),
          statTile('新词', stats.byLevel.new, { hint: '待开始' }),
          statTile('已掌握', stats.byLevel.mastered, { hint: '个' })
        ),
        h('div', { class: 'card' },
          levelBars(stats.byLevel, stats.total),
          h('p', { class: 'muted small', text: `词典收录 ${dictionaryStats.total} 条 · 词 ${dictionaryStats.byType.word || 0} · 词组 ${dictionaryStats.byType.phrase || 0} · 表达 ${dictionaryStats.byType.expression || 0}` })
        )
      ),

      h('section', {},
        h('div', { class: 'card card--action' },
          h('div', {},
            h('strong', { text: '资源中心' }),
            h('p', { class: 'muted small', text: '下载高频词表、搭配与语音资源包，下载后可离线使用。' })
          ),
          btn('打开', { tone: 'ghost', icon: 'download', onClick: () => navigate('/resources') })
        ),
        h('div', { class: 'card card--action' },
          h('div', {},
            h('strong', { text: '导入词库（Excel / CSV / TXT）' }),
            h('p', { class: 'muted small', text: '自动识别字段，确认后导入，自动去重。' })
          ),
          btn('导入', { tone: 'ghost', icon: 'upload', onClick: () => navigate('/import') })
        )
      ),

      !isOnline() ? h('p', { class: 'notice notice--warn', text: '当前离线：词典、我的词汇和已缓存的语音可正常使用；AI 功能需要联网。' }) : null
    );
  }

  function favoriteRow(fav) {
    return listRow({
      title: fav.headword || fav.customText,
      subtitle: fav.translation || (fav.meanings?.[0]?.definition ?? ''),
      badges: [typeBadge(fav.type), masteryBadge(fav.masteryLevel)],
      onClick: () => navigate(`/fav/${encodeURIComponent(fav.id)}`),
      right: audioButton(fav.headword || fav.customText, { compact: true })
    });
  }

  const offFavorites = bus.on(EVENTS.FAVORITES_CHANGED, () => { refresh().catch(() => {}); });
  const offDictionary = bus.on(EVENTS.DICTIONARY_CHANGED, () => { refresh().catch(() => {}); });
  await refresh();

  return {
    unmount() {
      offFavorites();
      offDictionary();
      clearTimeout(suggestTimer);
    }
  };
}

function renderSuggestions(host, suggestions, query) {
  replaceChildren(host, ...suggestions.map((s) => h('button', {
    class: 'suggestion',
    type: 'button',
    on: { click: () => navigate(`/dict?q=${encodeURIComponent(s.headword)}`) }
  },
  h('span', { class: 'suggestion__word', text: s.headword }),
  h('span', { class: 'suggestion__translation', text: s.translation || '' }),
  s.isPersonal ? badge('我的', 'amber') : typeBadge(s.type)
  )),
  h('button', {
    class: 'suggestion suggestion--action',
    type: 'button',
    on: { click: () => navigate(`/dict?q=${encodeURIComponent(query)}`) }
  }, h('span', { text: `在词典中搜索「${query}」` })));
}

function onboardingCard(aiStatus) {
  return h('section', { class: 'card card--highlight' },
    h('h2', { class: 'card__title', text: '3 步开始使用' }),
    h('ol', { class: 'steps' },
      h('li', {}, h('strong', { text: '搜索一个词' }), h('span', { text: '例如 aproveitar、dar conta，查看中文释义与例句。' })),
      h('li', {}, h('strong', { text: '点击 ⭐ 收藏' }), h('span', { text: '自动加入我的词汇并安排复习时间。' })),
      h('li', {}, h('strong', { text: '用「＋ 添加新词」记录真实场景' }), h('span', { text: '输入单词或整句，AI 整理后保存。' }))
    ),
    h('p', { class: 'muted small', text: aiStatus.provider === 'mock'
      ? '提示：AI 目前是「示例数据（非 AI）」模式，可在设置中配置真实 AI 服务。'
      : '提示：配置 AI 服务后可以自动生成释义、搭配与例句。' }),
    h('div', { class: 'row row--gap' },
      btn('配置 AI', { tone: 'ghost', size: 'sm', icon: 'sparkles', onClick: () => navigate('/settings?section=ai') }),
      btn('导入词库', { tone: 'ghost', size: 'sm', icon: 'upload', onClick: () => navigate('/import') })
    )
  );
}

function levelBars(byLevel, total) {
  const levels = [
    { id: 'new', label: '新词', cls: 'level--new' },
    { id: 'learning', label: '学习中', cls: 'level--learning' },
    { id: 'familiar', label: '熟悉', cls: 'level--familiar' },
    { id: 'mastered', label: '已掌握', cls: 'level--mastered' }
  ];
  const max = Math.max(1, ...levels.map((l) => byLevel[l.id] || 0));
  return h('div', { class: 'levelbars' }, levels.map((level) => h('div', { class: 'levelbar' },
    h('span', { class: 'levelbar__label', text: level.label }),
    h('div', { class: 'levelbar__track' },
      h('div', { class: `levelbar__fill ${level.cls}`, style: { width: `${Math.round(((byLevel[level.id] || 0) / max) * 100)}%` } })
    ),
    h('span', { class: 'levelbar__value', text: String(byLevel[level.id] || 0) })
  )));
}
