/** 我的词汇 — search, filter, sort, bulk operations. */

import { viewRoot, setTitle, confirmDialog } from '../shell.js';
import {
  h, replaceChildren, btn, iconBtn, chip, listRow, emptyState, typeBadge,
  masteryBadge, badge, audioButton, navigate, toast, openSheet, sectionTitle
} from '../components.js';
import { svgIcon } from '../../core/dom.js';
import { favoriteRepo, tagRepo } from '../../db/repos.js';
import { dictionaryService } from '../../services/dictionaryService.js';
import { exportService } from '../../services/exportService.js';
import { SRS } from '../../services/index.js';
import { bus, EVENTS } from '../../core/events.js';
import { relTime } from '../../core/format.js';
import { MASTERY_LEVELS } from '../../db/schema.js';

const SORTS = [
  { id: 'updated', label: '最近更新' },
  { id: 'created', label: '添加时间' },
  { id: 'review', label: '复习时间' },
  { id: 'alpha', label: '字母顺序' },
  { id: 'mastery', label: '掌握程度' }
];

export default async function notebookPage(route) {
  setTitle('我的词汇', {
    back: false,
    actions: [
      iconBtn('upload', { label: '导入', onClick: () => navigate('/import') }),
      iconBtn('download', { label: '导出', onClick: () => exportMenu() })
    ]
  });

  const root = viewRoot();
  let query = route.query.q || '';
  let mastery = route.query.mastery || 'all';
  let tagFilter = route.query.tag || null;
  let sort = 'updated';
  let selecting = false;
  const selected = new Set();

  const searchInput = h('input', {
    class: 'search__input', type: 'search', value: query,
    placeholder: '搜索我的生词（葡语或中文）', enterkeyhint: 'search'
  });
  const filterRow = h('div', { class: 'chiprow' });
  const sortRow = h('div', { class: 'chiprow chiprow--muted' });
  const listHost = h('div', { class: 'stack' });
  const summaryHost = h('div', { class: 'card card--muted' });
  const actionBar = h('div', { class: 'actionbar' });

  root.replaceChildren(h('div', { class: 'page' },
    h('div', { class: 'page__pad sticky-search' },
      h('form', { class: 'search search--compact', role: 'search' },
        h('div', { class: 'search__field' },
          h('span', { class: 'search__icon' }, svgIcon('search', 18)),
          searchInput,
          h('button', { class: 'search__clear', type: 'button', 'aria-label': '清空', text: '×', hidden: !query })
        )
      ),
      filterRow,
      sortRow
    ),
    summaryHost,
    actionBar,
    listHost
  ));

  const clearBtn = root.querySelector('.search__clear');
  clearBtn.addEventListener('click', () => { searchInput.value = ''; query = ''; clearBtn.hidden = true; render(); });
  let timer = null;
  searchInput.addEventListener('input', () => {
    clearBtn.hidden = !searchInput.value;
    clearTimeout(timer);
    timer = setTimeout(() => { query = searchInput.value.trim(); render(); }, 180);
  });
  root.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); query = searchInput.value.trim(); render(); });

  async function render() {
    const [all, tags] = await Promise.all([favoriteRepo.all(), tagRepo.all()]);
    const filtered = applyFilters(all, { query, mastery, tagFilter, sort });
    const stats = await SRS.stats();

    replaceChildren(filterRow,
      chip('全部', { active: mastery === 'all', count: all.length, onClick: () => { mastery = 'all'; render(); } }),
      ...Object.values(MASTERY_LEVELS).map((level) => chip(level.label, {
        active: mastery === level.id,
        count: all.filter((f) => (f.masteryLevel || 'new') === level.id).length,
        onClick: () => { mastery = mastery === level.id ? 'all' : level.id; render(); }
      }))
    );

    replaceChildren(sortRow,
      h('span', { class: 'chiprow__label', text: '排序' }),
      ...SORTS.map((s) => chip(s.label, { active: sort === s.id, onClick: () => { sort = s.id; render(); } })),
      tags.length ? h('span', { class: 'chiprow__label', text: '标签' }) : null,
      ...tags.filter((t) => t.count > 0).slice(0, 12).map((tag) => chip(`#${tag.name}`, {
        active: tagFilter === tag.name,
        count: tag.count,
        color: tag.color,
        onClick: () => { tagFilter = tagFilter === tag.name ? null : tag.name; render(); }
      }))
    );

    replaceChildren(summaryHost,
      h('div', { class: 'row row--between' },
        h('span', { text: `共 ${all.length} 条 · 显示 ${filtered.length} 条` }),
        h('span', { class: 'muted small', text: `今日待复习 ${stats.dueNow} · 连续 ${stats.streakDays} 天` })
      )
    );

    replaceChildren(actionBar,
      btn(selecting ? '完成' : '批量操作', {
        tone: 'ghost', size: 'sm', icon: selecting ? 'check' : 'list',
        onClick: () => { selecting = !selecting; selected.clear(); render(); }
      }),
      selecting && selected.size ? h('span', { class: 'muted small', text: `已选 ${selected.size}` }) : null,
      selecting && selected.size ? btn('加标签', { tone: 'ghost', size: 'sm', icon: 'tag', onClick: bulkTag }) : null,
      selecting && selected.size ? btn('删除', { tone: 'danger', size: 'sm', icon: 'trash', onClick: bulkDelete }) : null,
      btn('开始学习', { tone: 'primary', size: 'sm', icon: 'cards', onClick: () => navigate('/study') })
    );

    if (!all.length) {
      replaceChildren(listHost, emptyState('我的词汇库还是空的', {
        message: '在词典里点击 ⭐ 收藏，或用「＋ 添加新词」记录在视频、聊天、工作里遇到的说法。',
        action: h('div', { class: 'row row--gap' },
          btn('搜索词典', { icon: 'search', onClick: () => navigate('/dict') }),
          btn('添加新词', { tone: 'ghost', icon: 'plus', onClick: () => navigate('/add') })
        )
      }));
      return;
    }

    if (!filtered.length) {
      replaceChildren(listHost, emptyState('没有符合条件的词', {
        message: '试试清除筛选或换个关键词。',
        action: btn('清除筛选', { tone: 'ghost', onClick: () => { query = ''; mastery = 'all'; tagFilter = null; searchInput.value = ''; clearBtn.hidden = true; render(); } })
      }));
      return;
    }

    replaceChildren(listHost, h('div', { class: 'card card--list' }, filtered.map((fav) => {
      const row = listRow({
        title: fav.headword || fav.customText,
        subtitle: fav.translation || fav.meanings?.[0]?.definition || '',
        badges: [typeBadge(fav.type), masteryBadge(fav.masteryLevel), ...(fav.tags || []).slice(0, 2).map((t) => badge(`#${t}`, 'neutral'))],
        meta: `${fav.source === 'ai' ? 'AI 添加' : fav.source === 'import' ? '导入' : fav.source === 'dictionary' ? '词典收藏' : '手动添加'} · ${
          fav.reviewCount ? `复习 ${fav.reviewCount} 次 · 下次 ${relTime(fav.nextReviewAt)}` : `添加于 ${relTime(fav.createdAt)}`}`,
        onClick: () => {
          if (selecting) {
            if (selected.has(fav.id)) selected.delete(fav.id); else selected.add(fav.id);
            render();
            return;
          }
          navigate(`/fav/${encodeURIComponent(fav.id)}`);
        },
        leading: selecting ? h('span', { class: `checkbox${selected.has(fav.id) ? ' is-checked' : ''}` }) : null,
        right: selecting ? null : audioButton(fav.headword || fav.customText, { compact: true })
      });
      return row;
    })));
  }

  function applyFilters(all, { query: q, mastery: m, tagFilter: tag, sort: s }) {
    let list = all.slice();
    if (m && m !== 'all') list = list.filter((f) => (f.masteryLevel || 'new') === m);
    if (tag) list = list.filter((f) => (f.tags || []).includes(tag));
    if (q) {
      const norm = q.toLowerCase();
      list = list.filter((f) => {
        const haystack = [
          f.headword, f.customText, f.translation, f.notes,
          ...(f.tags || []),
          ...(f.meanings || []).map((x) => x.definition || ''),
          ...(f.examples || []).map((x) => `${x.sourceText} ${x.translation}`)
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(norm);
      });
    }
    const sorters = {
      updated: (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
      created: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
      review: (a, b) => (a.nextReviewAt || 0) - (b.nextReviewAt || 0),
      alpha: (a, b) => String(a.headword || a.customText).localeCompare(String(b.headword || b.customText), 'pt-BR'),
      mastery: (a, b) => (MASTERY_LEVELS[a.masteryLevel]?.order ?? 0) - (MASTERY_LEVELS[b.masteryLevel]?.order ?? 0)
    };
    return list.sort(sorters[s] || sorters.updated);
  }

  async function bulkDelete() {
    const count = selected.size;
    if (!count) return;
    const ok = await confirmDialog({
      title: '删除收藏',
      message: `确定删除选中的 ${count} 条吗？词典数据不受影响。`,
      confirmLabel: '删除',
      tone: 'danger'
    });
    if (!ok) return;
    await favoriteRepo.removeMany(Array.from(selected));
    toast(`已删除 ${count} 条`, { tone: 'ok' });
    selected.clear();
    selecting = false;
    bus.emit(EVENTS.FAVORITES_CHANGED, { action: 'bulk-delete' });
    render();
  }

  async function bulkTag() {
    const input = h('input', { class: 'input', type: 'text', placeholder: '输入标签，例如 工作、口语', enterkeyhint: 'done' });
    let sheetRef;
    sheetRef = openSheet({
      title: `为 ${selected.size} 条添加标签`,
      content: h('div', { class: 'stack' }, input, h('p', { class: 'muted small', text: '标签会合并到已有标签，不会覆盖。' })),
      actions: [
        h('button', { class: 'btn btn--ghost', type: 'button', text: '取消', on: { click: () => sheetRef.close() } }),
        h('button', {
          class: 'btn btn--primary', type: 'button', text: '添加',
          on: {
            click: async () => {
              const tag = input.value.trim();
              if (!tag) return;
              for (const id of selected) {
                const fav = await favoriteRepo.get(id);
                if (!fav) continue;
                await favoriteRepo.update(id, { tags: Array.from(new Set([...(fav.tags || []), tag])) });
              }
              await tagRepo.recountTags([tag]);
              sheetRef.close();
              toast(`已为 ${selected.size} 条添加 #${tag}`, { tone: 'ok' });
              bus.emit(EVENTS.FAVORITES_CHANGED, { action: 'bulk-tag' });
              render();
            }
          }
        })
      ]
    });
  }

  function exportMenu() {
    openSheet({
      title: '导出我的数据',
      content: h('div', { class: 'stack' },
        h('p', { class: 'muted', text: '你的词汇库属于你自己。导出后可换设备恢复，也可以直接用 Excel 打开。' }),
        btn('导出 JSON 完整备份', { icon: 'download', block: true, onClick: async () => { const counts = await exportService.exportJson(); toast(`已导出 ${counts.favorites} 条收藏`, { tone: 'ok' }); } }),
        btn('导出 CSV（我的词汇）', { tone: 'ghost', icon: 'download', block: true, onClick: async () => { const n = await exportService.exportCsv(); toast(`已导出 ${n} 条`, { tone: 'ok' }); } }),
        btn('导出词典层 CSV', { tone: 'ghost', icon: 'download', block: true, onClick: async () => { const n = await exportService.exportDictionaryCsv(); toast(`已导出 ${n} 条词条`, { tone: 'ok' }); } })
      )
    });
  }

  await render();
  const off = bus.on(EVENTS.FAVORITES_CHANGED, () => render().catch(() => {}));
  return { unmount() { clearTimeout(timer); off(); } };
}
