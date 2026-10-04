/** 关于 — what this is, data policy, roadmap status (honest about what exists). */

import { viewRoot, setTitle } from '../shell.js';
import { h, btn, badge, listRow, sectionTitle, navigate, toast } from '../components.js';
import { APP_VERSION, deployConfig } from '../../config.js';
import { dictionaryService } from '../../services/dictionaryService.js';
import { AIService } from '../../services/aiService.js';
import { TTSService } from '../../services/ttsService.js';

const ROADMAP = [
  { id: 'P0', items: [
    { text: '手机端 PWA（添加到主屏幕、全屏运行）', done: true },
    { text: '搜索（葡语 / 中文 / 模糊拼写）', done: true },
    { text: '词典（单词、词组、表达、例句）', done: true },
    { text: '收藏 ⭐ 与我的词汇', done: true },
    { text: '添加新词（输入 / 粘贴 / 语音输入）', done: true },
    { text: 'TTS：在线生成 + 本地缓存', done: true },
    { text: 'IndexedDB 本地数据库（分层设计）', done: true },
    { text: 'Excel / CSV / TXT 导入（字段识别 + 去重）', done: true },
    { text: 'PWA manifest + Service Worker + 离线缓存', done: true }
  ] },
  { id: 'P1', items: [
    { text: 'AI 自动解释（结构化 JSON）', done: true, note: '需要配置 AI 服务' },
    { text: 'AI 例句 / 词组扩展', done: true, note: '需要配置 AI 服务' },
    { text: '复习系统（新词 / 学习中 / 熟悉 / 已掌握）', done: true },
    { text: '数据导出 / 恢复（JSON / CSV）', done: true },
    { text: '离线词典（资源包下载）', done: true },
    { text: '音频缓存（离线播放）', done: true }
  ] },
  { id: 'P2', items: [
    { text: 'OCR 拍照取词', done: false, note: '未实现（接口已预留位置，没有假按钮）' },
    { text: '视频字幕导入', done: false, note: '未实现' },
    { text: 'Anki 导入', done: false, note: '未实现（CSV 导入可替代）' },
    { text: '跟读评分', done: false, note: '未实现（需要语音评测服务）' },
    { text: 'AI 对话练习', done: false, note: '未实现' },
    { text: '更完整的学习统计图表', done: false, note: '基础统计已实现，图表待做' },
    { text: '真正的离线神经网络 TTS', done: false, note: '未实现（需本地模型，体积大；当前为在线生成 + 缓存）' }
  ] }
];

export default async function aboutPage() {
  setTitle('关于', { back: true });
  const root = viewRoot();
  const dictStats = dictionaryService.stats();
  const ai = AIService.status();
  const tts = TTSService.status();

  root.replaceChildren(h('div', { class: 'page' },
    h('section', { class: 'card card--highlight' },
      h('h1', { class: 'card__title', text: 'Meu Dicionário · 我的巴西葡语语言数据库' }),
      h('p', { text: '这不是普通的单词本：它是你的个人葡语数据库。来自 YouTube、TikTok、Instagram、电视剧、工作沟通、同事聊天、街上看到的文字——任何新词、词组、固定搭配、口语表达、句子、俚语，都可以快速记录、自动整理，并被反复复习。' }),
      h('p', { class: 'muted small', text: `版本 ${APP_VERSION} · 词典 ${dictStats.total} 条 · 我的词汇与学习记录保存在本机` })
    ),

    h('section', { class: 'card' },
      h('h2', { class: 'card__title', text: '当前状态（真实情况）' }),
      h('div', { class: 'statuslist' },
        row('AI 分析', ai.isMock ? '示例数据（非 AI）' : ai.configured ? `已配置（${ai.provider}）` : '未配置'),
        row('语音', tts.provider === 'device' ? '设备内置语音（普通音质）' : tts.configured ? `已配置（${tts.provider}）` : '未配置'),
        row('AI 代理地址', deployConfig.aiProxyUrl || '—'),
        row('TTS 代理地址', deployConfig.ttsProxyUrl || '—')
      ),
      h('div', { class: 'row row--gap' },
        btn('去配置', { onClick: () => navigate('/settings?section=ai') })
      )
    ),

    h('section', { class: 'card' },
      h('h2', { class: 'card__title', text: '数据政策' }),
      h('ul', { class: 'bulletlist' },
        h('li', { text: '词典层与个人层分离：词典数据可替换，你的收藏永远保留。' }),
        h('li', { text: '只提供可合法再分发的词典/词表；没有授权的商业词典不会伪装成可下载。' }),
        h('li', { text: '内置示例词典为作者原创内容（CC0）。' }),
        h('li', { text: 'AI 只有在联网且你主动触发时才发送文本。' }),
        h('li', { text: '离线时不会假装 AI 可用：会明确提示「需要联网使用 AI 功能」。' })
      )
    ),

    ...ROADMAP.map((phase) => h('section', {},
      sectionTitle(`路线图 ${phase.id}`),
      h('div', { class: 'card card--list' }, phase.items.map((item) => listRow({
        title: item.text,
        subtitle: item.note || '',
        badges: [badge(item.done ? '已完成' : '未完成', item.done ? 'green' : 'neutral')]
      })))
    )),

    h('section', { class: 'card card--muted' },
      h('h2', { class: 'card__title', text: '技术栈说明' }),
      h('p', { class: 'small', text: '本项目使用零依赖的原生 Web 技术：ES Modules + IndexedDB + 手写 Service Worker，不需要任何构建工具或 npm 依赖即可运行。原因：部署最简单（任意静态托管）、离线最可靠、没有框架升级负担，并且在没有 Node 环境的机器上也能直接修改和部署。' }),
      h('p', { class: 'small muted', text: '如果你希望改用 React + TypeScript + Vite，逻辑层（services/ 与 db/）已经是纯 JS 模块，可以整体迁移，无需重写数据结构。' })
    ),

    h('section', { class: 'stack' },
      btn('返回设置', { tone: 'ghost', block: true, onClick: () => navigate('/settings') })
    )
  ));

  function row(label, value) {
    return h('div', { class: 'statuslist__row' },
      h('span', { class: 'statuslist__label', text: label }),
      h('span', { class: 'statuslist__value', text: value })
    );
  }

  return {};
}
