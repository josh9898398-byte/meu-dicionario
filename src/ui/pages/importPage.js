/** 导入词库 — file/paste → sheet select → field detection → confirm → import. */

import { viewRoot, setTitle, confirmDialog } from '../shell.js';
import {
  h, replaceChildren, btn, badge, field, textArea, select, listRow, emptyState,
  toast, openSheet, navigate, sectionTitle, spinner
} from '../components.js';
import { svgIcon } from '../../core/dom.js';
import { importService, FIELD_ROLES } from '../../services/importService.js';
import { importRepo } from '../../db/repos.js';
import { bus, EVENTS } from '../../core/events.js';
import { dateTime } from '../../core/format.js';

const ROLE_ORDER = ['portuguese', 'chinese', 'example', 'partOfSpeech', 'pronunciation', 'tags', 'notes'];

export default async function importPage() {
  setTitle('导入词库', { back: true });
  const root = viewRoot();

  const state = {
    source: null,
    sheetIndex: 0,
    detection: null,
    items: [],
    analysis: null,
    options: await importService.loadImportPreferences()
  };

  const workHost = h('div', { class: 'stack' });
  const historyHost = h('div', { class: 'stack' });

  root.replaceChildren(h('div', { class: 'page' },
    h('section', { class: 'card' },
      h('h2', { class: 'card__title', text: '选择文件' }),
      h('p', { class: 'muted small', text: '支持 Excel (.xlsx)、CSV、TXT；也可以直接粘贴文本。字段会自动识别，导入前你可以确认与修改。' }),
      h('div', { class: 'row row--wrap row--gap' },
        h('label', { class: 'btn btn--primary btn--md' },
          svgIcon('upload', 18),
          h('span', { text: '选择文件' }),
          h('input', {
            type: 'file',
            accept: '.xlsx,.csv,.tsv,.txt',
            class: 'visually-hidden',
            on: { change: (event) => handleFile(event.target.files?.[0]) }
          })
        ),
        btn('粘贴文本', { tone: 'ghost', icon: 'copy', onClick: openPasteSheet })
      ),
      h('p', { class: 'muted small', text: '旧版 .xls 请在 Excel / Numbers 中「另存为 .xlsx 或 CSV」。' })
    ),
    workHost,
    h('section', {}, sectionTitle('导入记录'), historyHost)
  ));

  async function refreshHistory() {
    const rows = await importRepo.all();
    replaceChildren(historyHost, rows.length
      ? h('div', { class: 'card card--list' }, rows.slice(0, 10).map((row) => listRow({
          title: row.fileName,
          subtitle: `${row.target === 'notebook' ? '我的词汇' : row.target === 'both' ? '我的词汇 + 词典' : '词典'} · 重复项策略：${row.strategy === 'update' ? '覆盖更新' : row.strategy === 'merge' ? '合并' : '跳过'}`,
          meta: `${dateTime(row.createdAt)} · 导入 ${row.importedRows ?? 0} 条 · 跳过 ${row.skippedRows ?? 0} 条`
        })))
      : emptyState('还没有导入记录', { message: '导入后这里会显示历史与去重结果。' }));
  }

  async function handleFile(file) {
    if (!file) return;
    replaceChildren(workHost, spinner('正在解析文件…'));
    try {
      state.source = await importService.loadFile(file);
      state.source.fileName = file.name;
      state.sheetIndex = 0;
      prepareSheet();
    } catch (err) {
      replaceChildren(workHost, h('div', { class: 'card card--error' },
        h('h2', { class: 'card__title', text: '解析失败' }),
        h('p', { text: err?.message || String(err) })
      ));
    }
  }

  function openPasteSheet() {
    const area = textArea({
      placeholder: '直接粘贴你的词表，例如：\naproveitar\t利用\naproveitar;好好利用\ndar conta | 应付',
      rows: 10
    });
    let sheetRef;
    sheetRef = openSheet({
      title: '粘贴文本',
      size: 'tall',
      content: h('div', { class: 'stack' }, area, h('p', { class: 'muted small', text: '支持制表符、逗号、分号、竖线分隔，或每行一个词。' })),
      actions: [
        h('button', { class: 'btn btn--ghost', type: 'button', text: '取消', on: { click: () => sheetRef.close() } }),
        h('button', {
          class: 'btn btn--primary', type: 'button', text: '解析',
          on: {
            click: async () => {
              try {
                state.source = await importService.loadPastedText(area.value);
                state.source.fileName = '（粘贴文本）';
                state.sheetIndex = 0;
                sheetRef.close();
                prepareSheet();
              } catch (err) {
                toast(err?.message || '解析失败', { tone: 'error' });
              }
            }
          }
        })
      ]
    });
  }

  function looksLikeHeader(row) {
    if (!row) return false;
    return row.filter((cell) => /单词|葡语|中文|意思|释义|例句|词性|word|portugu|meaning|example|exemplo|significado|palavra|tradu/i.test(String(cell || ''))).length >= 1;
  }

  function prepareSheet() {
    const sheet = state.source.sheets[state.sheetIndex];
    const headerRow = importService.detectHeaderRow(sheet.grid);
    const hasHeader = headerRow === 0 && looksLikeHeader(sheet.grid[0]);
    state.detection = importService.detectFields(sheet.grid, { hasHeader, headerRow });
    state.items = [];
    renderDetection();
  }

  function renderDetection() {
    const sheet = state.source.sheets[state.sheetIndex];
    const selection = new Map();
    for (const role of ROLE_ORDER) selection.set(role, state.detection.mapping[role] ?? -1);

    const mappingHost = h('div', { class: 'mapping' });
    const previewHost = h('div', { class: 'stack' });

    const columnOptions = [
      { value: '-1', label: '（不使用）' },
      ...state.detection.columns.map((col) => ({
        value: String(col.index),
        label: `第 ${col.index + 1} 列${col.header ? `：${col.header}` : ''}${col.samples[0] ? `（如 ${String(col.samples[0]).slice(0, 14)}）` : ''}`
      }))
    ];

    for (const role of ROLE_ORDER) {
      mappingHost.appendChild(h('div', { class: 'mapping__row' },
        h('span', { class: 'mapping__label', text: FIELD_ROLES[role] }),
        select(columnOptions, {
          value: String(selection.get(role)),
          onChange: (value) => { selection.set(role, Number(value)); updatePreview(); }
        })
      ));
    }

    const headerToggle = h('label', { class: 'switchrow' },
      h('input', {
        type: 'checkbox',
        checked: state.detection.hasHeader,
        on: { change: (e) => { state.detection.hasHeader = e.target.checked; updatePreview(); } }
      }),
      h('span', { text: '第一行是标题行（不含数据）' })
    );

    const strategySelect = select([
      { value: 'skip', label: '跳过重复（推荐）' },
      { value: 'merge', label: '合并（只补充标签）' },
      { value: 'update', label: '覆盖更新已有条目' }
    ], { value: state.options.strategy || 'skip', onChange: (v) => { state.options.strategy = v; updatePreview(); } });

    const targetSelect = select([
      { value: 'both', label: '我的词汇 + 词典（推荐）' },
      { value: 'notebook', label: '只导入我的词汇' },
      { value: 'dictionary', label: '只导入词典' }
    ], { value: state.options.target || 'both', onChange: (v) => { state.options.target = v; } });

    const tagsInput = h('input', { class: 'input', type: 'text', value: state.options.extraTags || '', placeholder: '为本次导入统一添加标签，例如：导入,工作' });
    const sourceInput = h('input', { class: 'input', type: 'text', value: state.source.fileName || '', placeholder: '数据来源名称（会记录在词典里）' });

    function currentMapping() {
      const mapping = {};
      for (const [role, index] of selection) if (index >= 0) mapping[role] = index;
      return mapping;
    }

    async function updatePreview() {
      state.detection.mapping = currentMapping();
      state.items = importService.buildItems(sheet.grid, state.detection, { limit: 3000 });
      state.analysis = await importService.analyzeDuplicates(state.items);
      const willWrite = state.analysis.fresh.length + (state.options.strategy === 'update' ? state.analysis.duplicates.length : 0);
      replaceChildren(previewHost,
        h('div', { class: 'card' },
          h('h3', { class: 'card__title', text: '预览与去重' }),
          h('div', { class: 'stats-grid stats-grid--small' },
            miniStat('检测到', state.analysis.total),
            miniStat('新词', state.analysis.fresh.length),
            miniStat('重复', state.analysis.duplicates.length)
          ),
          state.analysis.fresh.length
            ? h('div', { class: 'previewtable' },
                h('div', { class: 'previewtable__head' },
                  h('span', { text: '葡语' }), h('span', { text: '中文' }), h('span', { text: '例句' })
                ),
                state.analysis.fresh.slice(0, 12).map((item) => h('div', { class: 'previewtable__row' },
                  h('span', { text: item.headword }),
                  h('span', { text: item.translation || '—' }),
                  h('span', { text: (item.examples?.[0]?.sourceText || '—').slice(0, 40) })
                ))
              )
            : h('p', { class: 'muted', text: '没有可导入的新词。' }),
          state.analysis.duplicates.length
            ? h('p', { class: 'muted small', text: `重复项示例：${state.analysis.duplicates.slice(0, 6).map((d) => d.headword).join('、')}` })
            : null,
          h('div', { class: 'row row--gap' },
            btn(`确认导入 ${willWrite} 条`, {
              icon: 'check',
              disabled: willWrite === 0,
              onClick: () => commit(sourceInput.value.trim(), tagsInput.value)
            })
          )
        )
      );
    }

    replaceChildren(workHost,
      h('section', { class: 'card' },
        h('div', { class: 'row row--between' },
          h('h2', { class: 'card__title', text: '检测到以下字段' }),
          badge(String(state.source.kind).toUpperCase(), 'blue')
        ),
        state.source.sheets.length > 1
          ? h('div', { class: 'stack stack--tight' },
              h('span', { class: 'muted small', text: `文件包含 ${state.source.sheets.length} 个工作表，请选择要导入的` }),
              h('div', { class: 'chiprow' }, state.source.sheets.map((s, i) => h('button', {
                class: `chip${i === state.sheetIndex ? ' is-active' : ''}`,
                type: 'button',
                text: `${i + 1}. ${s.name}`,
                on: { click: () => { state.sheetIndex = i; prepareSheet(); } }
              })))
            )
          : null,
        headerToggle,
        mappingHost,
        h('p', { class: 'muted small', text: '请核对「葡语字段」（必填）与「中文字段」。自动识别不总是正确，确认后再导入。' })
      ),
      h('section', { class: 'card' },
        h('h2', { class: 'card__title', text: '导入选项' }),
        field('导入到', targetSelect),
        field('重复项处理', strategySelect),
        field('数据来源名称', sourceInput),
        field('统一添加标签', tagsInput)
      ),
      previewHost
    );

    updatePreview();
  }

  function miniStat(label, value) {
    return h('div', { class: 'stat stat--mini' },
      h('span', { class: 'stat__value', text: String(value) }),
      h('span', { class: 'stat__label', text: label })
    );
  }

  async function commit(sourceName, tagsRaw) {
    let sheetRef;
    sheetRef = openSheet({ title: '正在导入', content: h('p', { class: 'muted', text: '正在写入本地数据库…' }), dismissible: false });
    try {
      const extraTags = String(tagsRaw || '').split(/[,，]/).map((t) => t.trim()).filter(Boolean);
      const list = state.options.strategy === 'update'
        ? [...state.analysis.fresh, ...state.analysis.duplicates]
        : state.analysis.fresh;
      const result = await importService.commit(list, {
        target: state.options.target,
        strategy: state.options.strategy,
        sourceName,
        extraTags,
        mapping: state.detection.mapping
      });
      await importService.saveImportPreferences({ ...state.options, extraTags: String(tagsRaw || '') });
      sheetRef.close();
      bus.emit(EVENTS.FAVORITES_CHANGED, { action: 'import' });
      bus.emit(EVENTS.DICTIONARY_CHANGED, { action: 'import' });
      toast(`导入完成：我的词汇 ++${result.notebookAdded}，词典 +${result.dictionaryResult.added}`, { tone: 'ok', duration: 4200 });
      await refreshHistory();
      const goNow = await confirmDialog({
        title: '导入完成',
        message: `我的词汇新增 ${result.notebookAdded} 条，词典新增 ${result.dictionaryResult.added} 条，跳过 ${result.dictionaryResult.skipped + result.notebookSkipped} 条。要去我的词汇看看吗？`,
        confirmLabel: '去我的词汇'
      });
      if (goNow) navigate('/notebook');
    } catch (err) {
      sheetRef.close();
      toast(err?.message || '导入失败', { tone: 'error' });
    }
  }

  await refreshHistory();
  return {};
}
