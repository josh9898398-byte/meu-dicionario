/** 学习 — review session (葡语 → 中文), ratings feed the SRS scheduler. */

import { viewRoot, setTitle, scrollTop } from '../shell.js';
import {
  h, replaceChildren, btn, chip, emptyState, statTile, masteryBadge, badge, typeBadge,
  audioButton, exampleCard, navigate, toast, openSheet, sectionTitle, metaLine
} from '../components.js';
import { svgIcon } from '../../core/dom.js';
import { favoriteRepo, learningRepo, tagRepo } from '../../db/repos.js';
import * as SRS from '../../services/srsService.js';
import { TTSService } from '../../services/ttsService.js';
import { AIService } from '../../services/aiService.js';
import { bus, EVENTS } from '../../core/events.js';
import { relTime } from '../../core/format.js';

const MODES = [
  { id: 'all', label: '混合（推荐）' },
  { id: 'due', label: '仅待复习' },
  { id: 'new', label: '仅新词' },
  { id: 'struggling', label: '易错词' }
];

export default async function studyPage(route) {
  setTitle('学习', { back: false });
  const root = viewRoot();

  const state = {
    mode: route.query.mode || 'all',
    limit: Number(route.query.limit) || 20,
    tag: null,
    queue: [],
    index: 0,
    revealed: false,
    results: [],
    startedAt: 0,
    cardStartedAt: 0,
    autoPlay: true,
    selectMode: false,
    selected: new Set(),
    phase: 'setup'
  };

  async function render() {
    if (state.phase === 'session') return renderSession();
    if (state.phase === 'summary') return renderSummary();
    return renderSetup();
  }

  async function renderSetup() {
    const [stats, tags] = await Promise.all([SRS.stats(), tagRepo.all()]);
    const activeTags = tags.filter((t) => t.count > 0).slice(0, 10);

    root.replaceChildren(h('div', { class: 'page' },
      h('div', { class: 'stats-grid' },
        statTile('今日待复习', stats.dueNow, { tone: stats.dueNow ? 'warn' : 'default' }),
        statTile('新词', stats.byLevel.new, { hint: '未开始' }),
        statTile('学习中', stats.byLevel.learning + stats.byLevel.familiar, { hint: '进行中' }),
        statTile('已掌握', stats.byLevel.mastered, { tone: 'ok' })
      ),

      h('section', { class: 'card' },
        h('h2', { class: 'card__title', text: '复习范围' }),
        h('div', { class: 'chiprow' }, MODES.map((mode) => chip(mode.label, {
          active: state.mode === mode.id,
          onClick: () => { state.mode = mode.id; render(); }
        }))),
        activeTags.length ? h('div', { class: 'stack stack--tight' },
          h('span', { class: 'muted small', text: '按标签筛选（可选）' }),
          h('div', { class: 'chiprow' }, activeTags.map((tag) => chip(`#${tag.name}`, {
            active: state.tag === tag.name,
            count: tag.count,
            onClick: () => { state.tag = state.tag === tag.name ? null : tag.name; render(); }
          })))
        ) : null,
        h('div', { class: 'stack stack--tight' },
          h('span', { class: 'muted small', text: '本次卡片数量' }),
          h('div', { class: 'chiprow' }, [10, 20, 30, 50].map((n) => chip(String(n), {
            active: state.limit === n,
            onClick: () => { state.limit = n; render(); }
          })))
        )
      ),

      h('section', { class: 'card' },
        h('h2', { class: 'card__title', text: '复习方式' }),
        h('p', { class: 'muted small', text: '先看葡语并听发音 → 自己回忆 → 点开答案对照 → 选择「认识 / 模糊 / 不认识」，系统据此安排下次复习时间。' }),
        h('label', { class: 'switchrow' },
          h('input', { type: 'checkbox', checked: state.autoPlay, on: { change: (e) => { state.autoPlay = e.target.checked; } } }),
          h('span', { text: '卡片出现时自动播放发音' })
        ),
        TTSService.status().provider === 'device'
          ? h('p', { class: 'notice notice--warn', text: `当前语音：${TTSService.DEVICE_PROVIDER_NOTE}` })
          : null
      ),

      h('section', { class: 'stack' },
        btn('开始学习', { block: true, icon: 'cards', onClick: start }),
        btn('缓存本次卡片音频（需联网）', {
          tone: 'ghost', block: true, icon: 'download',
          onClick: () => prefetchQueue()
        }),
        stats.total === 0 ? h('p', { class: 'notice', text: '我的词汇库为空。先去词典收藏几个词吧。' }) : null
      ),

      h('section', { class: 'card card--muted' },
        h('h2', { class: 'card__title', text: '累计统计' }),
        metaLine([
          `总复习 ${stats.totalReviews} 次`,
          `正确率 ${stats.accuracy}%`,
          `本周 ${stats.reviewsThisWeek} 次`,
          `连续 ${stats.streakDays} 天`
        ])
      )
    ));
  }

  async function start() {
    const queue = await SRS.buildQueue({ limit: state.limit, mode: state.mode, tag: state.tag });
    if (!queue.length) {
      toast('没有符合条件的卡片', { tone: 'warn' });
      return;
    }
    state.queue = queue;
    state.index = 0;
    state.results = [];
    state.revealed = false;
    state.phase = 'session';
    state.startedAt = Date.now();
    state.cardStartedAt = Date.now();
    render();
  }

  async function prefetchQueue() {
    try {
      const queue = await SRS.buildQueue({ limit: state.limit, mode: state.mode, tag: state.tag });
      const texts = queue.flatMap((f) => [f.headword || f.customText, ...(f.examples || []).slice(0, 1).map((e) => e.sourceText)]);
      const sheetRef = openSheet({
        title: '缓存音频',
        content: h('p', { class: 'muted', text: `准备缓存 ${texts.length} 段语音…` })
      });
      const result = await TTSService.prefetch(texts, {
        onProgress: ({ done, total }) => { sheetRef.panel.querySelector('.sheet__body').textContent = `缓存中 ${done}/${total}`; }
      });
      sheetRef.close();
      toast(`已缓存 ${result.generated} 段新音频${result.failures.length ? `，失败 ${result.failures.length}` : ''}`, { tone: result.failures.length ? 'warn' : 'ok' });
    } catch (err) {
      toast(err?.message || '缓存失败', { tone: 'warn' });
    }
  }

  async function renderSession() {
    const card = state.queue[state.index];
    if (!card) { state.phase = 'summary'; return renderSummary(); }

    const headword = card.headword || card.customText;
    const examples = (card.examples || []).slice(0, 3);
    const progress = Math.round((state.index / state.queue.length) * 100);

    root.replaceChildren(h('div', { class: 'page page--study' },
      h('div', { class: 'studyprogress' },
        h('div', { class: 'studyprogress__bar' }, h('div', { class: 'studyprogress__fill', style: { width: `${progress}%` } })),
        h('span', { class: 'studyprogress__label', text: `${state.index + 1} / ${state.queue.length}` })
      ),

      h('div', { class: 'studycard' },
        h('div', { class: 'studycard__badges' }, typeBadge(card.type), masteryBadge(card.masteryLevel), badge(`${card.reviewCount || 0} 次复习`, 'neutral')),
        h('h1', { class: 'studycard__word', text: headword }),
        card.pronunciation?.ipa ? h('p', { class: 'muted', text: `[${card.pronunciation.ipa}]` }) : null,
        h('div', { class: 'row row--center row--gap' },
          audioButton(headword, { label: '播放发音' }),
          !state.revealed ? btn('显示答案', { icon: 'check', onClick: () => reveal() }) : null
        ),

        state.revealed ? h('div', { class: 'studycard__answer' },
          h('p', { class: 'studycard__translation', text: card.translation || card.meanings?.[0]?.definition || '（没有释义）' }),
          card.partOfSpeech ? h('p', { class: 'muted small', text: card.partOfSpeech }) : null,
          card.meanings?.length > 1 ? h('ul', { class: 'meaninglist' }, card.meanings.slice(1, 4).map((m) => h('li', {}, h('span', { class: 'meaninglist__def', text: m.definition || '' })))) : null,
          card.collocations?.length ? h('div', { class: 'row row--wrap row--gap-sm' }, card.collocations.slice(0, 4).map((c) => h('span', { class: 'phrasechip phrasechip--static', text: typeof c === 'string' ? c : c.text }))) : null,
          examples.length ? h('div', { class: 'stack stack--tight' }, examples.map((ex) => exampleCard(ex))) : null,
          h('div', { class: 'row row--gap' },
            h('button', { class: 'linkbtn', type: 'button', text: '打开完整条目', on: { click: () => navigate(`/fav/${encodeURIComponent(card.id)}`) } }),
            h('button', { class: 'linkbtn', type: 'button', text: '继续播放', on: { click: () => TTSService.speak(headword).catch((err) => toast(err.message, { tone: 'warn' })) } })
          )
        ) : h('p', { class: 'muted studycard__hint', text: '先自己回忆意思，再点「显示答案」。' })
      ),

      state.revealed ? h('div', { class: 'ratingrow' },
        ...Object.values(SRS.RATINGS).map((rating) => h('button', {
          class: `ratingbtn ratingbtn--${rating.tone}`,
          type: 'button',
          on: { click: () => rate(rating.id) }
        }, h('span', { class: 'ratingbtn__label', text: rating.label }), h('span', { class: 'ratingbtn__hint', text: rating.hint })))
      ) : h('div', { class: 'row row--gap' },
        btn('显示答案', { block: true, icon: 'check', onClick: () => reveal() })
      ),

      h('div', { class: 'row row--between row--gap' },
        h('button', { class: 'linkbtn', type: 'button', text: '结束本次学习', on: { click: () => { state.phase = 'summary'; render(); } } }),
        h('button', { class: 'linkbtn', type: 'button', text: '跳过 →', on: { click: () => next() } })
      )
    ));

    if (state.autoPlay) {
      TTSService.speak(headword).catch(() => {});
    }
    state.cardStartedAt = Date.now();
  }

  function reveal() {
    state.revealed = true;
    renderSession();
    const card = state.queue[state.index];
    const first = (card.examples || [])[0];
    if (first?.sourceText) TTSService.speak(first.sourceText).catch(() => {});
  }

  async function rate(rating) {
    const card = state.queue[state.index];
    try {
      const updated = await SRS.review(card.id, rating, {
        durationMs: Date.now() - state.cardStartedAt,
        mode: 'study'
      });
      state.results.push({ card, rating, updated });
      bus.emit(EVENTS.FAVORITES_CHANGED, { action: 'review', id: card.id });
      next();
    } catch (err) {
      toast(err?.message || '保存失败', { tone: 'error' });
    }
  }

  function next() {
    state.index += 1;
    state.revealed = false;
    if (state.index >= state.queue.length) {
      state.phase = 'summary';
      render();
      return;
    }
    renderSession();
  }

  function renderSummary() {
    const total = state.results.length;
    const good = state.results.filter((r) => r.rating === 'good').length;
    const hard = state.results.filter((r) => r.rating === 'hard').length;
    const again = state.results.filter((r) => r.rating === 'again').length;
    const duration = state.startedAt ? Date.now() - state.startedAt : 0;
    const accuracy = total ? Math.round((good / total) * 100) : 0;

    root.replaceChildren(h('div', { class: 'page' },
      h('div', { class: 'card card--highlight' },
        h('h2', { class: 'card__title', text: total ? '本次学习完成 🎉' : '本次学习已结束' }),
        h('div', { class: 'stats-grid stats-grid--small' },
          statTile('卡片', total),
          statTile('认识', good, { tone: 'ok' }),
          statTile('模糊', hard, { tone: 'warn' }),
          statTile('不认识', again, { tone: 'danger' })
        ),
        h('p', { class: 'muted small', text: `正确率 ${accuracy}% · 用时 ${Math.max(1, Math.round(duration / 60000))} 分钟` })
      ),

      state.results.some((r) => r.rating !== 'good') ? h('section', {},
        sectionTitle('需要再看看'),
        h('div', { class: 'card card--list' }, state.results.filter((r) => r.rating !== 'good').map((r) => h('button', {
          class: 'listrow listrow--clickable',
          type: 'button',
          on: { click: () => navigate(`/fav/${encodeURIComponent(r.card.id)}`) }
        },
        h('span', { class: 'listrow__title', text: r.card.headword || r.card.customText }),
        h('span', { class: 'listrow__right', text: r.rating === 'again' ? '不认识' : '模糊' })
        )))
      ) : null,

      h('section', { class: 'stack' },
        btn('再来一组', { block: true, icon: 'refresh', onClick: () => { state.phase = 'setup'; render(); } }),
        btn('返回首页', { tone: 'ghost', block: true, onClick: () => navigate('/home') })
      )
    ));
  }

  function onKey(event) {
    if (state.phase !== 'session') return;
    if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); if (!state.revealed) reveal(); return; }
    if (!state.revealed) return;
    if (event.key === '1') rate('again');
    if (event.key === '2') rate('hard');
    if (event.key === '3') rate('good');
  }
  document.addEventListener('keydown', onKey);

  await render();
  return { unmount() { document.removeEventListener('keydown', onKey); TTSService.stop(); } };
}
