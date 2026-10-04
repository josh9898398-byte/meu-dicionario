/** 我的词汇 · 条目详情 — edit, review history, examples, mastery, delete. */

import { viewRoot, setTitle, scrollTop, confirmDialog } from '../shell.js';
import {
  h, replaceChildren, btn, badge, typeBadge, masteryBadge, audioButton, exampleCard,
  sectionTitle, chipBlock, kvBlock, emptyState, tagChips, metaLine, navigate, toast, openSheet,
  textInput, textArea, select, field
} from '../components.js';
import { svgIcon } from '../../core/dom.js';
import { favoriteRepo, learningRepo, tagRepo, dictionaryRepo } from '../../db/repos.js';
import { dictionaryService } from '../../services/dictionaryService.js';
import { AIService } from '../../services/aiService.js';
import { SRS } from '../../services/index.js';
import { bus, EVENTS } from '../../core/events.js';
import { capabilityService } from '../../services/capabilityService.js';
import { relTime, dateTime } from '../../core/format.js';
import { MASTERY_LEVELS } from '../../db/schema.js';

export default async function favoritePage(route) {
  const id = route.params.id;
  const favorite = await favoriteRepo.get(id);

  if (!favorite) {
    setTitle('生词条目', { back: true });
    viewRoot().replaceChildren(emptyState('未找到该条目', {
      message: '它可能已被删除。',
      action: btn('返回我的词汇', { onClick: () => navigate('/notebook') })
    }));
    return {};
  }

  setTitle(favorite.headword || favorite.customText, { back: true });
  const root = viewRoot();
  const history = await learningRepo.forFavorite(id);
  const linkedEntry = favorite.dictionaryEntryId ? await dictionaryRepo.get(favorite.dictionaryEntryId) : null;

  const body = h('div', { class: 'page page--detail' },
    h('header', { class: 'entryhead' },
      h('div', { class: 'entryhead__badges' },
        typeBadge(favorite.type),
        masteryBadge(favorite.masteryLevel),
        favorite.partOfSpeech ? badge(favorite.partOfSpeech, 'neutral') : null,
        favorite.difficulty ? badge(favorite.difficulty, 'blue') : null
      ),
      h('h1', { class: 'entryhead__word', text: favorite.headword || favorite.customText }),
      h('div', { class: 'row row--gap' },
        audioButton(favorite.headword || favorite.customText, { label: '播放' }),
        btn('编辑', { tone: 'ghost', icon: 'edit', onClick: () => openEditor() })
      )
    ),

    h('section', { class: 'card' },
      h('h2', { class: 'card__title', text: '中文释义' }),
      h('p', { class: 'entryhead__translation', text: favorite.translation || favorite.meanings?.[0]?.definition || '（还没有释义）' }),
      favorite.meanings?.length > 1 ? h('ul', { class: 'meaninglist' }, favorite.meanings.slice(1).map((m) => h('li', {},
        h('span', { class: 'meaninglist__def', text: m.definition || '' }),
        m.note ? h('span', { class: 'meaninglist__note', text: m.note }) : null
      ))) : null,
      favorite.notes ? h('p', { class: 'muted', text: `备注：${favorite.notes}` }) : null
    ),

    h('section', { class: 'card' },
      h('h2', { class: 'card__title', text: '复习状态' }),
      metaLine([
        MASTERY_LEVELS[favorite.masteryLevel]?.label,
        `复习 ${favorite.reviewCount || 0} 次`,
        `记住 ${favorite.correctCount || 0} 次`,
        `间隔 ${favorite.intervalDays || 0} 天`
      ]),
      h('p', { class: 'muted small', text: `下次复习：${relTime(favorite.nextReviewAt)}（${dateTime(favorite.nextReviewAt)}）` }),
      h('div', { class: 'row row--wrap row--gap' },
        ...Object.values(MASTERY_LEVELS).map((level) => btn(level.label, {
          tone: favorite.masteryLevel === level.id ? 'primary' : 'ghost',
          size: 'sm',
          onClick: async () => {
            await favoriteRepo.update(id, { masteryLevel: level.id });
            toast(`已标记为「${level.label}」`, { tone: 'ok' });
            bus.emit(EVENTS.FAVORITES_CHANGED, { action: 'mastery' });
            navigate(`/fav/${encodeURIComponent(id)}?r=${Date.now()}`);
          }
        })),
        btn('重置进度', { tone: 'ghost', size: 'sm', icon: 'refresh', onClick: async () => {
          await SRS.resetProgress(id);
          toast('复习进度已重置');
          navigate(`/fav/${encodeURIComponent(id)}?r=${Date.now()}`);
        } })
      )
    ),

    favorite.patterns?.length ? h('section', { class: 'card' }, kvBlock('常见结构', favorite.patterns)) : null,
    favorite.collocations?.length ? h('section', { class: 'card' }, chipBlock('常见搭配', favorite.collocations)) : null,
    favorite.relatedExpressions?.length ? h('section', { class: 'card' }, chipBlock('相关表达', favorite.relatedExpressions)) : null,
    favorite.usageNotes?.length ? h('section', { class: 'card' }, kvBlock('使用场景', favorite.usageNotes)) : null,

    h('section', {},
      sectionTitle(`例句 (${favorite.examples?.length || 0})`, {
        action: h('button', { class: 'btn btn--ghost btn--sm', type: 'button', on: { click: () => addExample() } }, svgIcon('plus', 16), h('span', { text: '添加例句' }))
      }),
      favorite.examples?.length
        ? h('div', { class: 'card card--examples' }, favorite.examples.map((ex, index) => h('div', { class: 'example-wrap' },
            exampleCard(ex),
            h('div', { class: 'row row--gap-sm' },
              h('button', { class: 'linkbtn', type: 'button', text: '编辑', on: { click: () => editExample(index) } }),
              h('button', { class: 'linkbtn linkbtn--danger', type: 'button', text: '删除', on: { click: () => removeExample(index) } })
            )
          )))
        : emptyState('还没有例句', {
            message: '你可以手动添加，或用 AI 生成语境例句。',
            action: h('div', { class: 'row row--gap' },
              btn('添加例句', { tone: 'ghost', icon: 'plus', onClick: () => addExample() }),
              btn('AI 生成例句', { icon: 'sparkles', onClick: () => aiEnrich() })
            )
          })
    ),

    favorite.tags?.length ? h('section', { class: 'card' }, h('h2', { class: 'card__title', text: '标签' }), tagChips(favorite.tags, {
      onRemove: async (tag) => {
        await favoriteRepo.update(id, { tags: (favorite.tags || []).filter((t) => t !== tag) });
        toast(`已移除 #${tag}`);
        navigate(`/fav/${encodeURIComponent(id)}?r=${Date.now()}`);
      }
    })) : null,

    history.length ? h('section', { class: 'card' },
      h('h2', { class: 'card__title', text: `复习记录 (${history.length})` }),
      h('ul', { class: 'historylist' }, history.slice(0, 20).map((rec) => h('li', {},
        h('span', { text: rec.rating === 'good' ? '✓ 认识' : rec.rating === 'hard' ? '~ 模糊' : '✗ 不认识' }),
        h('span', { class: 'muted small', text: dateTime(rec.reviewedAt) })
      )))
    ) : null,

    h('section', { class: 'card card--muted' },
      h('h2', { class: 'card__title', text: '数据来源' }),
      metaLine([
        favorite.source === 'ai' ? 'AI 生成' : favorite.source === 'import' ? '导入' : favorite.source === 'dictionary' ? `词典收藏${favorite.sourceRef ? ` · ${favorite.sourceRef}` : ''}` : '手动添加',
        `添加于 ${dateTime(favorite.createdAt)}`
      ]),
      linkedEntry ? btn('查看词典词条', { tone: 'ghost', icon: 'book', onClick: () => navigate(`/entry/${encodeURIComponent(linkedEntry.id)}`) }) : null
    ),

    h('section', { class: 'stack' },
      capabilityService.isAIAvailable()
        ? btn('AI 重新整理（释义/搭配/例句）', { tone: 'ghost', icon: 'sparkles', block: true, onClick: () => aiEnrich() })
        : btn('AI 暂未启用 · 查看说明', {
            tone: 'ghost',
            icon: 'info',
            block: true,
            onClick: () => toast(capabilityService.aiUnavailableReason(), { tone: 'warn', duration: 4200 })
          }),
      btn('删除这个收藏', { tone: 'danger', icon: 'trash', block: true, onClick: async () => {
        const ok = await confirmDialog({ title: '删除收藏', message: `确定删除「${favorite.headword}」吗？此操作不可撤销。`, confirmLabel: '删除', tone: 'danger' });
        if (!ok) return;
        await favoriteRepo.remove(id);
        toast('已删除');
        bus.emit(EVENTS.FAVORITES_CHANGED, { action: 'delete' });
        navigate('/notebook');
      } })
    )
  );

  root.replaceChildren(body);
  scrollTop();

  function openEditor() {
    const headword = textInput({ value: favorite.headword || favorite.customText, placeholder: '葡语原文' });
    const translation = textInput({ value: favorite.translation || '', placeholder: '中文解释' });
    const pos = textInput({ value: favorite.partOfSpeech || '', placeholder: '词性，例如 verbo' });
    const type = select([
      { value: 'word', label: '单词' },
      { value: 'phrase', label: '词组' },
      { value: 'expression', label: '表达' },
      { value: 'sentence', label: '句子' }
    ], { value: favorite.type || 'word' });
    const tags = textInput({ value: (favorite.tags || []).join(', '), placeholder: '标签，用逗号分隔' });
    const notes = textArea({ value: favorite.notes || '', placeholder: '备注、来源、使用场景…', rows: 3 });

    let sheetRef;
    sheetRef = openSheet({
      title: '编辑条目',
      size: 'tall',
      content: h('div', { class: 'stack' },
        field('葡语原文', headword),
        field('中文解释', translation),
        field('词性', pos),
        field('类型', type),
        field('标签', tags, { hint: '用逗号分隔，例如：工作, 口语' }),
        field('备注', notes)
      ),
      actions: [
        h('button', { class: 'btn btn--ghost', type: 'button', text: '取消', on: { click: () => sheetRef.close() } }),
        h('button', {
          class: 'btn btn--primary', type: 'button', text: '保存',
          on: {
            click: async () => {
              const newTags = tags.value.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
              await favoriteRepo.update(id, {
                customText: headword.value.trim(),
                headword: headword.value.trim(),
                translation: translation.value.trim(),
                partOfSpeech: pos.value.trim(),
                type: type.value,
                tags: newTags,
                notes: notes.value.trim()
              });
              await tagRepo.recountTags(newTags);
              sheetRef.close();
              toast('已保存', { tone: 'ok' });
              bus.emit(EVENTS.FAVORITES_CHANGED, { action: 'update' });
              navigate(`/fav/${encodeURIComponent(id)}?r=${Date.now()}`);
            }
          }
        })
      ]
    });
  }

  function addExample() {
    const pt = textArea({ placeholder: '葡语例句', rows: 2 });
    const zh = textInput({ placeholder: '中文翻译（可留空）' });
    const sheetRef = openSheet({
      title: '添加例句',
      content: h('div', { class: 'stack' }, field('葡语例句', pt), field('中文翻译', zh)),
      actions: [
        h('button', { class: 'btn btn--ghost', type: 'button', text: '取消', on: { click: () => sheetRef.close() } }),
        h('button', { class: 'btn btn--primary', type: 'button', text: '保存', on: { click: async () => {
          const text = pt.value.trim();
          if (!text) return;
          const examples = [...(favorite.examples || []), { sourceText: text, translation: zh.value.trim(), source: 'manual' }];
          await favoriteRepo.update(id, { examples });
          sheetRef.close();
          toast('已添加例句', { tone: 'ok' });
          navigate(`/fav/${encodeURIComponent(id)}?r=${Date.now()}`);
        } } })
      ]
    });
  }

  function editExample(index) {
    const current = (favorite.examples || [])[index];
    const pt = textArea({ value: current.sourceText || '', rows: 2 });
    const zh = textInput({ value: current.translation || '' });
    const sheetRef = openSheet({
      title: '编辑例句',
      content: h('div', { class: 'stack' }, field('葡语例句', pt), field('中文翻译', zh)),
      actions: [
        h('button', { class: 'btn btn--ghost', type: 'button', text: '取消', on: { click: () => sheetRef.close() } }),
        h('button', { class: 'btn btn--primary', type: 'button', text: '保存', on: { click: async () => {
          const examples = (favorite.examples || []).slice();
          examples[index] = { ...current, sourceText: pt.value.trim(), translation: zh.value.trim() };
          await favoriteRepo.update(id, { examples });
          sheetRef.close();
          navigate(`/fav/${encodeURIComponent(id)}?r=${Date.now()}`);
        } } })
      ]
    });
  }

  async function removeExample(index) {
    const ok = await confirmDialog({ title: '删除例句', message: '确定删除这条例句吗？', confirmLabel: '删除', tone: 'danger' });
    if (!ok) return;
    const examples = (favorite.examples || []).filter((_, i) => i !== index);
    await favoriteRepo.update(id, { examples });
    toast('已删除');
    navigate(`/fav/${encodeURIComponent(id)}?r=${Date.now()}`);
  }

  async function aiEnrich() {
    const text = favorite.headword || favorite.customText;
    if (!capabilityService.isAIAvailable()) {
      toast(capabilityService.aiUnavailableReason(), { tone: 'warn', duration: 4200 });
      return;
    }
    const sheetRef = openSheet({
      title: 'AI 重新整理',
      content: h('div', { class: 'stack' },
        AIService.status().isMock ? h('p', { class: 'notice notice--warn', text: '当前为「示例数据（非 AI）」模式。' }) : null,
        h('p', { class: 'muted', text: `正在分析「${text}」…` })
      )
    });
    try {
      const analysis = await AIService.analyzeVocabulary(text, { context: favorite.notes || '' });
      const existing = new Set((favorite.examples || []).map((ex) => ex.sourceText));
      const fresh = (analysis.examples || []).filter((ex) => !existing.has(ex.sourceText));
      await favoriteRepo.update(id, {
        translation: analysis.translations?.[0] || favorite.translation,
        partOfSpeech: analysis.partOfSpeech || favorite.partOfSpeech,
        type: analysis.type || favorite.type,
        meanings: analysis.meanings?.length ? analysis.meanings : favorite.meanings,
        patterns: analysis.patterns?.length ? analysis.patterns : favorite.patterns,
        collocations: analysis.collocations?.length ? analysis.collocations : favorite.collocations,
        relatedExpressions: analysis.relatedExpressions?.length ? analysis.relatedExpressions : favorite.relatedExpressions,
        usageNotes: analysis.usageNotes?.length ? analysis.usageNotes : favorite.usageNotes,
        difficulty: analysis.difficulty || favorite.difficulty,
        pronunciation: analysis.pronunciation || favorite.pronunciation,
        tags: Array.from(new Set([...(favorite.tags || []), ...(analysis.tags || [])])),
        examples: [...(favorite.examples || []), ...fresh.map((ex) => ({ ...ex, source: 'AI' }))]
      });
      sheetRef.close();
      toast(`已更新（新增 ${fresh.length} 条例句）`, { tone: 'ok' });
      bus.emit(EVENTS.FAVORITES_CHANGED, { action: 'ai-enrich' });
      navigate(`/fav/${encodeURIComponent(id)}?r=${Date.now()}`);
    } catch (err) {
      sheetRef.close();
      toast(err?.code === 'offline' ? '需要联网使用 AI 功能' : (err?.message || 'AI 处理失败'), { tone: 'warn' });
    }
  }

  return {};
}
