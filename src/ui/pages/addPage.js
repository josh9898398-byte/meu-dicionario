/**
 * 添加新词 — 整个 App 最常用的入口。
 *
 * 粘贴一句葡语 → 「AI 分析」→ 看到：
 *   · 整句的翻译与语法说明
 *   · 「这句话里值得学的」列表（可勾选：dar conta de / sozinho / fazer isso…）
 * → 勾选后保存到「我的词汇」。
 *
 * 贴心的降级：AI 暂未启用时，页面会明确说明，并保留「只保存」——先把词记下来，
 * 之后再补充释义。绝不放一个点了没反应的假按钮。
 */

import { viewRoot, setTitle, confirmDialog } from '../shell.js';
import {
  h, replaceChildren, btn, badge, audioButton, exampleCard, chipBlock, kvBlock,
  toast, openSheet, field, textInput, textArea, select, navigate, typeBadge, sectionTitle
} from '../components.js';
import { svgIcon } from '../../core/dom.js';
import { AIService } from '../../services/aiService.js';
import { dictionaryService } from '../../services/dictionaryService.js';
import { favoriteRepo, tagRepo } from '../../db/repos.js';
import { TTSService } from '../../services/ttsService.js';
import { capabilityService } from '../../services/capabilityService.js';
import { isOnline } from '../../services/connectivityService.js';
import { bus, EVENTS } from '../../core/events.js';
import { detectType } from '../../services/normalizer.js';

export default async function addPage(route) {
  setTitle('添加新词', {
    back: true,
    actions: [h('button', {
      class: 'iconbtn', type: 'button', 'aria-label': '导入文件',
      on: { click: () => navigate('/import') }
    }, svgIcon('upload', 20))]
  });

  const root = viewRoot();
  const capability = await capabilityService.refresh().catch(() => capabilityService.snapshot());
  const aiReady = capabilityService.isAIAvailable();

  const initialText = route.query.text || '';
  const skipAI = route.query.manual === '1';
  const state = {
    analysis: null,
    selectedKeys: new Set(),
    includeDictionary: false,
    busy: false
  };

  const input = textArea({
    value: initialText,
    placeholder: '粘贴或输入葡语：一个单词、一个短语、一整句话都可以。\n\n例如：\nficar de boa\nEu não dou conta de fazer isso sozinho.',
    rows: 4
  });
  const previewHost = h('div', { class: 'stack' });

  root.replaceChildren(h('div', { class: 'page page--add' },
    !aiReady ? h('div', { class: 'notice notice--warn' },
      h('strong', { text: 'AI 功能暂未启用' }),
      h('span', { text: capabilityService.aiUnavailableReason() }),
      h('span', { class: 'muted small', text: '其他功能不受影响：可以搜索词典、听发音、先用「只保存」记录词汇、导入导出与复习。' }),
      h('button', {
        class: 'linkbtn', type: 'button', text: '查看如何启用（部署者选项）',
        on: { click: () => navigate('/settings?section=advanced') }
      })
    ) : null,

    h('section', { class: 'card' },
      h('h2', { class: 'card__title', text: '要记录什么？' }),
      input,
      h('div', { class: 'row row--wrap row--gap' },
        btn(aiReady ? 'AI 分析' : 'AI 分析（暂未启用）', {
          icon: 'sparkles',
          onClick: aiReady ? runAI : showWhyNoAI
        }),
        btn('只保存', { tone: 'ghost', icon: 'star', onClick: quickSave }),
        supportsSpeech() ? btn('语音输入', { tone: 'ghost', icon: 'mic', onClick: startDictation }) : null
      ),
      h('p', { class: 'muted small', text: '提示：从 YouTube / TikTok / 聊天里直接粘贴整句即可，AI 会自动找出真正值得学的表达。' })
    ),

    previewHost,

    h('section', { class: 'card card--muted' },
      h('h2', { class: 'card__title', text: '小技巧' }),
      h('ul', { class: 'bulletlist' },
        h('li', { text: '整句粘贴 → 只收藏其中的固定搭配（例如 dar conta de）。' }),
        h('li', { text: '批量导入请用「导入」，支持 Excel / CSV / TXT。' }),
        h('li', { text: '不确定的句子先「只保存」，之后在「我的词汇」里补释义。' })
      )
    )
  ));

  setTimeout(() => input.focus(), 150);
  if (initialText && !skipAI && aiReady) runAI();

  function supportsSpeech() {
    return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  function startDictation() {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Ctor) { toast('此浏览器不支持语音输入', { tone: 'warn' }); return; }
    const recognition = new Ctor();
    recognition.lang = 'pt-BR';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    toast('请开始说葡萄牙语…');
    recognition.onresult = (event) => {
      const text = event.results?.[0]?.[0]?.transcript || '';
      if (text) {
        input.value = input.value ? `${input.value}\n${text}` : text;
        toast('语音已写入');
      }
    };
    recognition.onerror = () => toast('语音识别失败（iPhone 上需要系统听写支持）', { tone: 'warn' });
    try { recognition.start(); } catch { toast('无法启动语音识别', { tone: 'warn' }); }
  }

  function showWhyNoAI() {
    openSheet({
      title: 'AI 功能暂未启用',
      content: h('div', { class: 'stack' },
        h('p', { text: capabilityService.aiUnavailableReason() }),
        h('p', { class: 'muted small', text: '这说明后端还没有配置 AI 服务。词典、我的词汇、学习、导入导出、发音缓存都可以正常使用。' }),
        h('p', { class: 'muted small', text: '如果你就是部署者：在后端配置好 AI 服务密钥（只存在服务器，步骤见 README），然后在「设置 → 高级设置」点「重新检查」。' }),
        btn('现在先保存这个词', { icon: 'star', block: true, onClick: () => { close(); quickSave(); } })
      )
    });
    const close = () => document.querySelector('#sheet-host .sheet-backdrop')?.click();
  }

  async function runAI() {
    const text = input.value.trim();
    if (!text) { toast('请输入要分析的内容', { tone: 'warn' }); input.focus(); return; }
    if (state.busy) return;
    state.busy = true;
    replaceChildren(previewHost, h('div', { class: 'card' }, h('p', { class: 'muted', text: 'AI 正在分析…这可能需要几秒。' })));
    try {
      const analysis = await AIService.analyzeVocabulary(text);
      state.analysis = analysis;
      state.selectedKeys = new Set((analysis.keyExpressions || []).map((k) => k.text));
      renderPreview(analysis);
    } catch (err) {
      renderError(err);
    } finally {
      state.busy = false;
    }
  }

  function renderError(err) {
    const message = err?.code === 'offline'
      ? '需要联网使用 AI 功能'
      : (err?.message || 'AI 分析失败');
    replaceChildren(previewHost, h('div', { class: 'card card--error' },
      h('h2', { class: 'card__title', text: 'AI 分析没有完成' }),
      h('p', { text: message }),
      h('p', { class: 'muted small', text: '你仍然可以先把内容保存下来，稍后再补充释义。' }),
      h('div', { class: 'row row--gap' },
        btn('重试', { onClick: runAI }),
        btn('只保存', { tone: 'ghost', onClick: quickSave })
      )
    ));
  }

  function renderPreview(data) {
    const translationInput = textInput({ value: (data.translations || []).join('；'), placeholder: '中文意思' });
    const tagsInput = textInput({ value: (data.tags || []).join(', '), placeholder: '标签，例如：口语, 工作' });
    const posInput = textInput({ value: data.partOfSpeech || '', placeholder: '词性' });
    const typeSelect = select([
      { value: 'word', label: '单词' },
      { value: 'phrase', label: '短语' },
      { value: 'expression', label: '常用表达' },
      { value: 'sentence', label: '句子' }
    ], { value: data.type });

    const keySection = (data.keyExpressions || []).length ? keyExpressionSection(data) : null;

    replaceChildren(previewHost,
      h('section', { class: 'card' },
        h('div', { class: 'row row--between' },
          h('h2', { class: 'card__title', text: 'AI 分析结果' }),
          data.provider === 'mock' ? badge('示例数据（非 AI）', 'amber') : badge('AI 生成', 'green')
        ),
        h('div', { class: 'entryhead__badges' },
          typeBadge(data.type),
          data.partOfSpeech ? badge(data.partOfSpeech, 'neutral') : null,
          data.difficulty && data.difficulty !== 'unknown' ? badge(data.difficulty, 'blue') : null
        ),
        h('h3', { class: 'preview__headword', text: data.headword }),
        h('div', { class: 'row row--gap' }, audioButton(data.headword, { label: '试听' })),
        data.text && data.text !== data.headword
          ? h('div', { class: 'stack stack--tight' },
              h('span', { class: 'muted small', text: '原句' }),
              h('p', { class: 'preview__sentence', text: data.text })
            )
          : null,
        data.meanings?.length
          ? h('ul', { class: 'meaninglist' }, data.meanings.map((m) => h('li', {},
              h('span', { class: 'meaninglist__def', text: m.definition || '' }),
              m.note ? h('span', { class: 'meaninglist__note', text: m.note }) : null
            )))
          : null,
        data.grammar ? h('p', { class: 'muted small', text: `语法：${data.grammar}` }) : null
      ),

      keySection,

      data.patterns?.length ? h('section', { class: 'card' }, kvBlock('常见结构', data.patterns)) : null,
      data.collocations?.length ? h('section', { class: 'card' }, chipBlock('常见搭配', data.collocations)) : null,
      data.relatedExpressions?.length ? h('section', { class: 'card' }, chipBlock('相关表达', data.relatedExpressions)) : null,
      data.usageNotes?.length ? h('section', { class: 'card' }, kvBlock('使用场景', data.usageNotes)) : null,

      data.examples?.length
        ? h('section', {},
            sectionTitle(`例句 (${data.examples.length})`),
            h('div', { class: 'card card--examples' }, data.examples.map((ex) => exampleCard(ex)))
          )
        : null,

      h('section', { class: 'card' },
        h('h2', { class: 'card__title', text: '保存' }),
        field('中文意思', translationInput),
        field('词性', posInput),
        field('类型', typeSelect),
        field('标签', tagsInput, { hint: '用逗号分隔' }),
        h('label', { class: 'switchrow' },
          h('input', {
            type: 'checkbox',
            checked: state.includeDictionary,
            on: { change: (e) => { state.includeDictionary = e.target.checked; } }
          }),
          h('span', { text: '同时加入系统词典（一般不需要）' })
        ),
        h('div', { class: 'stack' },
          btn(saveLabel(), {
            block: true,
            icon: 'star',
            onClick: () => save({ translationInput, tagsInput, posInput, typeSelect, data })
          }),
          btn('只保存主词条', {
            tone: 'ghost',
            block: true,
            onClick: () => save({ translationInput, tagsInput, posInput, typeSelect, data, onlyMain: true })
          }),
          btn('重新分析', { tone: 'ghost', icon: 'refresh', onClick: runAI })
        )
      )
    );
    scrollTo(previewHost);
  }

  function saveLabel() {
    const count = state.selectedKeys.size;
    return count ? `保存主词条 + 选中的 ${count} 个表达` : '保存到我的词汇';
  }

  /**
   * 「这句话里值得学的」——用户可以只挑其中几个表达收藏。
   */
  function keyExpressionSection(data) {
    const host = h('section', { class: 'card card--highlight' });
    const listHost = h('div', { class: 'picklist' });

    const renderList = () => {
      const rows = data.keyExpressions.map((item) => {
        const checked = state.selectedKeys.has(item.text);
        return h('button', {
          class: `pickrow${checked ? ' is-checked' : ''}`,
          type: 'button',
          on: {
            click: () => {
              if (state.selectedKeys.has(item.text)) state.selectedKeys.delete(item.text);
              else state.selectedKeys.add(item.text);
              renderList();
              updateActions();
            }
          }
        },
        h('span', { class: `checkbox${checked ? ' is-checked' : ''}` }),
        h('span', { class: 'pickrow__content' },
          h('span', { class: 'pickrow__text', text: item.text }),
          item.translation ? h('span', { class: 'pickrow__translation', text: item.translation }) : null,
          item.note ? h('span', { class: 'pickrow__note', text: item.note }) : null
        ),
        audioButton(item.text, { compact: true })
        );
      });
      replaceChildren(listHost, ...rows);
    };

    const actionHost = h('div', { class: 'row row--wrap row--gap' });
    const updateActions = () => {
      replaceChildren(actionHost,
        btn('全选', {
          tone: 'ghost', size: 'sm',
          onClick: () => { for (const item of data.keyExpressions) state.selectedKeys.add(item.text); renderList(); updateActions(); }
        }),
        btn('全不选', {
          tone: 'ghost', size: 'sm',
          onClick: () => { state.selectedKeys.clear(); renderList(); updateActions(); }
        }),
        h('button', {
          class: 'linkbtn', type: 'button', text: '保存选中的表达',
          on: {
            click: () => saveSelectedExpressions(data, { translationInput: null })
          }
        })
      );
    };

    host.appendChild(h('h2', { class: 'card__title', text: '这句话里值得学的' }));
    host.appendChild(h('p', { class: 'muted small', text: '勾选你要学的部分（可以只留其中一个）。点任意一行还能听发音。' }));
    host.appendChild(listHost);
    host.appendChild(actionHost);
    renderList();
    updateActions();
    return host;
  }

  async function saveSelectedExpressions(data, { translationInput }) {
    const items = (data.keyExpressions || []).filter((item) => state.selectedKeys.has(item.text));
    if (!items.length) { toast('请先勾选要保存的表达', { tone: 'warn' }); return; }
    let saved = 0;
    for (const item of items) {
      const existing = await favoriteRepo.findByText(item.text);
      if (existing) continue;
      await favoriteRepo.create({
        customText: item.text,
        headword: item.text,
        type: item.type || detectType(item.text),
        translation: item.translation || '',
        meanings: item.translation ? [{ definition: item.translation, note: item.note || '' }] : [],
        notes: item.note || '',
        tags: ['AI 摘录'],
        source: 'ai',
        sourceRef: data.headword || ''
      });
      saved += 1;
    }
    await tagRepo.recountTags(['AI 摘录']);
    bus.emit(EVENTS.FAVORITES_CHANGED, { action: 'add-expressions' });
    toast(saved ? `已收藏 ${saved} 个表达` : '这些表达已经在我的词汇里了', { tone: 'ok' });
    if (saved) navigate('/notebook');
  }

  async function save({ translationInput, tagsInput, posInput, typeSelect, data, onlyMain = false }) {
    const tags = tagsInput.value.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
    const translation = translationInput.value.trim();
    const payload = {
      customText: data.headword,
      headword: data.headword,
      type: typeSelect.value,
      translation,
      meanings: data.meanings?.length ? data.meanings : (translation ? [{ definition: translation, note: '' }] : []),
      partOfSpeech: posInput.value.trim(),
      collocations: data.collocations || [],
      patterns: data.patterns || [],
      relatedExpressions: data.relatedExpressions || [],
      usageNotes: data.usageNotes || [],
      examples: data.examples || [],
      tags,
      difficulty: data.difficulty,
      pronunciation: data.pronunciation,
      notes: data.text && data.text !== data.headword ? `原句：${data.text}` : '',
      source: data.provider === 'mock' ? 'ai-mock' : 'ai'
    };

    const existing = await favoriteRepo.findByText(data.headword);
    let favorite;
    if (existing) {
      const keep = await confirmDialog({
        title: '已经收藏过了',
        message: `「${data.headword}」已经在我的词汇里，要更新它吗？`,
        confirmLabel: '更新'
      });
      favorite = keep ? await favoriteRepo.update(existing.id, payload) : existing;
    } else {
      favorite = await favoriteRepo.create(payload);
    }

    if (!onlyMain && state.selectedKeys.size) {
      await saveSelectedExpressions(data, { translationInput });
    }

    if (state.includeDictionary) {
      await dictionaryService.upsertEntries([dictionaryService.createEntryFromInput({
        headword: data.headword,
        type: typeSelect.value,
        partOfSpeech: posInput.value.trim(),
        translations: translation ? translation.split(/[；;，,]/).map((t) => t.trim()).filter(Boolean) : [],
        meanings: data.meanings || [],
        examples: data.examples || [],
        collocations: data.collocations || [],
        patterns: data.patterns || [],
        relatedExpressions: data.relatedExpressions || [],
        usageNotes: data.usageNotes || [],
        tags,
        difficulty: data.difficulty,
        pronunciation: data.pronunciation
      })], { onConflict: 'merge' });
    }

    await tagRepo.recountTags(tags);
    bus.emit(EVENTS.FAVORITES_CHANGED, { action: 'add-from-ai', id: favorite.id });
    toast('已保存到我的词汇 ⭐', { tone: 'ok' });
    navigate(`/fav/${encodeURIComponent(favorite.id)}`);
  }

  async function quickSave() {
    const text = input.value.trim();
    if (!text) { toast('请输入内容', { tone: 'warn' }); return; }
    const first = text.split(/\n|。|\.|；|;/).map((s) => s.trim()).filter(Boolean)[0] || text;
    const headword = first.length > 60 ? first.slice(0, 60) : first;
    const existing = await favoriteRepo.findByText(headword);
    if (existing) {
      toast('这个词已经在我的词汇里了');
      navigate(`/fav/${encodeURIComponent(existing.id)}`);
      return;
    }
    const favorite = await favoriteRepo.create({
      customText: headword,
      headword,
      type: detectType(headword),
      translation: '',
      notes: text !== headword ? `原句：${text}` : '',
      source: 'manual'
    });
    bus.emit(EVENTS.FAVORITES_CHANGED, { action: 'quick-add', id: favorite.id });
    toast('已保存（稍后可补充释义）', { tone: 'ok' });
    navigate(`/fav/${encodeURIComponent(favorite.id)}`);
  }

  function scrollTo(node) {
    setTimeout(() => node.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  }

  return {};
}
