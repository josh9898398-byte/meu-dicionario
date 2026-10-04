/** 词典词条详情 — meanings, patterns, collocations, examples with playback. */

import { viewRoot, setTitle, scrollTop } from '../shell.js';
import {
  h, replaceChildren, btn, badge, typeBadge, audioButton, starButton, exampleCard,
  sectionTitle, chipBlock, kvBlock, emptyState, tagChips, metaLine, navigate, toast, openSheet
} from '../components.js';
import { svgIcon } from '../../core/dom.js';
import { dictionaryService } from '../../services/dictionaryService.js';
import { dictionaryRepo, favoriteRepo } from '../../db/repos.js';
import { AIService } from '../../services/aiService.js';
import { bus, EVENTS } from '../../core/events.js';
import { TTSService } from '../../services/ttsService.js';
import { capabilityService } from '../../services/capabilityService.js';

export default async function entryPage(route) {
  const id = route.params.id;
  const entry = await dictionaryRepo.get(id);

  if (!entry) {
    setTitle('词条', { back: true });
    viewRoot().replaceChildren(emptyState('未找到该词条', {
      message: '它可能来自已删除的资源包。',
      action: btn('返回词典', { onClick: () => navigate('/dict') })
    }));
    return {};
  }

  setTitle(entry.headword, { back: true });
  const root = viewRoot();
  const favorite = await favoriteRepo.findByEntryId(entry.id);

  const star = await starButton({ ...entry, isDictionaryEntry: true }, {
    block: true,
    onChange: () => bus.emit(EVENTS.FAVORITES_CHANGED, { action: 'toggle' })
  });

  const allExampleTexts = (entry.examples || []).map((ex) => ex.sourceText).filter(Boolean).slice(0, 6);

  const body = h('div', { class: 'page page--detail' },
    h('header', { class: 'entryhead' },
      h('div', { class: 'entryhead__badges' },
        typeBadge(entry.type),
        entry.partOfSpeech ? badge(entry.partOfSpeech, 'neutral') : null,
        entry.difficulty ? badge(entry.difficulty, 'blue') : null,
        entry.frequencyRank ? badge(`高频 ${entry.frequencyRank}`, 'purple') : null
      ),
      h('h1', { class: 'entryhead__word', text: entry.headword }),
      entry.pronunciation?.ipa ? h('p', { class: 'entryhead__ipa', text: `[${entry.pronunciation.ipa}]` }) : null,
      h('div', { class: 'row row--gap' },
        audioButton(entry.headword, { label: '播放发音' }),
        allExampleTexts.length ? h('button', {
          class: 'btn btn--ghost btn--md',
          type: 'button',
          on: { click: async () => {
            const texts = allExampleTexts.slice(0, 3);
            toast(`正在播放 ${texts.length} 条例句…`);
            for (const text of texts) {
              try { await TTSService.speak(text, { wait: true }); } catch (err) { toast(err.message, { tone: 'warn' }); return; }
            }
          } }
        }, svgIcon('list', 18), h('span', { text: '连续播放例句' })) : null
      )
    ),

    h('div', { class: 'stickybar' }, star,
      favorite ? btn('打开词汇条目', { tone: 'ghost', icon: 'star', onClick: () => navigate(`/fav/${encodeURIComponent(favorite.id)}`) }) : null
    ),

    entry.translations?.length ? h('section', { class: 'card' },
      h('h2', { class: 'card__title', text: '中文释义' }),
      h('p', { class: 'entryhead__translation', text: entry.translations.join('；') })
    ) : null,

    entry.meanings?.length ? h('section', { class: 'card' },
      h('h2', { class: 'card__title', text: '用法解释' }),
      h('ul', { class: 'meaninglist' }, entry.meanings.map((m) => h('li', {},
        h('span', { class: 'meaninglist__def', text: m.definition || '' }),
        m.note ? h('span', { class: 'meaninglist__note', text: m.note }) : null
      )))
    ) : null,

    entry.patterns?.length ? h('section', { class: 'card' }, kvBlock('常见结构', entry.patterns)) : null,
    entry.collocations?.length ? h('section', { class: 'card' }, chipBlock('常见搭配', entry.collocations)) : null,
    entry.relatedExpressions?.length ? h('section', { class: 'card' }, chipBlock('相关表达', entry.relatedExpressions)) : null,
    entry.usageNotes?.length ? h('section', { class: 'card' }, kvBlock('使用场景与注意', entry.usageNotes)) : null,
    entry.grammar ? h('section', { class: 'card' }, kvBlock('语法说明', [entry.grammar])) : null,

    h('section', {},
      sectionTitle(`例句 ${entry.examples?.length ? `(${entry.examples.length})` : ''}`, {
        action: capabilityService.isAIAvailable() ? h('button', {
          class: 'linkbtn',
          type: 'button',
          text: '用 AI 补充例句',
          on: { click: () => generateExamples(entry) }
        }) : h('span', { class: 'muted small', text: 'AI 暂未启用' })
      }),
      entry.examples?.length
        ? h('div', { class: 'card card--examples' }, entry.examples.map((ex) => exampleCard(ex)))
        : emptyState('这个词条还没有例句', { message: '可以用 AI 生成巴西葡语自然例句，或从导入数据补充。' })
    ),

    entry.tags?.length ? h('section', { class: 'card' }, h('h2', { class: 'card__title', text: '标签' }), tagChips(entry.tags)) : null,

    h('section', { class: 'card card--muted' },
      h('h2', { class: 'card__title', text: '数据来源' }),
      metaLine([
        entry.source?.name || entry.source?.id || '未知来源',
        entry.source?.license ? `许可：${entry.source.license}` : '',
        `更新 ${new Date(entry.updatedAt || Date.now()).toLocaleDateString('zh-CN')}`
      ]),
      h('p', { class: 'muted small', text: '词典数据与「我的词汇」是两个独立数据层。删除或更新词典不会影响你的收藏。' })
    )
  );

  root.replaceChildren(body);
  scrollTop();

  async function generateExamples(currentEntry) {
    const status = AIService.status();
    if (status.provider === 'none') {
      toast('AI 功能已关闭，可在设置中开启', { tone: 'warn' });
      return;
    }
    const sheet = openSheet({
      title: 'AI 生成例句',
      content: h('div', { class: 'stack' },
        status.isMock ? h('p', { class: 'notice notice--warn', text: '当前是「示例数据（非 AI）」模式，生成内容仅用于流程验证。' }) : null,
        h('p', { class: 'muted', text: `正在分析「${currentEntry.headword}」…` })
      )
    });
    try {
      const analysis = await AIService.analyzeVocabulary(currentEntry.headword, { context: '为词典词条补充更多巴西葡语例句' });
      const existing = new Set((currentEntry.examples || []).map((ex) => ex.sourceText));
      const fresh = (analysis.examples || []).filter((ex) => !existing.has(ex.sourceText));
      if (!fresh.length) {
        sheet.close();
        toast('没有新的例句可补充');
        return;
      }
      await dictionaryService.attachExamples(currentEntry.id, fresh.map((ex) => ({ ...ex, source: 'AI' })));
      sheet.close();
      toast(`已补充 ${fresh.length} 条例句`, { tone: 'ok' });
      bus.emit(EVENTS.DICTIONARY_CHANGED, { id: currentEntry.id });
      // Re-render through the router so the previous page's listeners unmount.
      navigate(`/entry/${encodeURIComponent(currentEntry.id)}?r=${Date.now()}`);
    } catch (err) {
      sheet.close();
      toast(err?.code === 'offline' ? '需要联网使用 AI 功能' : (err?.message || 'AI 生成失败'), { tone: 'warn' });
    }
  }

  const offFav = bus.on(EVENTS.FAVORITES_CHANGED, async () => {
    const current = await favoriteRepo.findByEntryId(entry.id);
    // keep the "open notebook entry" button in sync without a full re-render
    const bar = body.querySelector('.stickybar');
    if (!bar) return;
    const existing = bar.querySelector('.btn--ghost');
    if (current && !existing) {
      bar.appendChild(btn('打开词汇条目', { tone: 'ghost', icon: 'star', onClick: () => navigate(`/fav/${encodeURIComponent(current.id)}`) }));
    } else if (!current && existing) {
      existing.remove();
    }
  });

  return { unmount() { offFav(); } };
}
