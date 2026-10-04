/**
 * 设置 — 面向普通用户的极简结构。
 *
 * 用户可见：语音 / 学习 / 数据与备份 / 离线与安装 / 外观 / 使用帮助
 * 全部技术配置（AI 后端、语音引擎、诊断）收进「高级设置」，默认折叠，
 * 普通用户完全不需要打开它。
 */

import { viewRoot, setTitle, confirmDialog } from '../shell.js';
import {
  h, replaceChildren, btn, badge, field, textInput, select, toast, openSheet,
  listRow, navigate
} from '../components.js';
import { svgIcon } from '../../core/dom.js';
import { AIService } from '../../services/aiService.js';
import { TTSService } from '../../services/ttsService.js';
import { exportService } from '../../services/exportService.js';
import { diagnosticsService } from '../../services/diagnosticsService.js';
import { capabilityService } from '../../services/capabilityService.js';
import {
  audioRepo, settingsRepo, dictionaryRepo, favoriteRepo, resourceRepo,
  clearAllUserData, wipeDatabase
} from '../../db/repos.js';
import { isOnline } from '../../services/connectivityService.js';
import { APP_VERSION } from '../../config.js';
import { formatBytes, copyText, dateTime } from '../../core/format.js';
import { bus, EVENTS } from '../../core/events.js';

const SECTIONS = [
  { id: 'speech', label: '语音', icon: 'speaker' },
  { id: 'study', label: '学习', icon: 'cards' },
  { id: 'data', label: '数据与备份', icon: 'box' },
  { id: 'offline', label: '离线与安装', icon: 'download' },
  { id: 'appearance', label: '外观', icon: 'globe' },
  { id: 'help', label: '使用帮助', icon: 'info' },
  { id: 'advanced', label: '高级设置', icon: 'gear' }
];

export default async function settingsPage(route) {
  setTitle('设置', { back: false });
  const root = viewRoot();
  let section = route.query.section || 'speech';
  // legacy deep links (settings?section=ai|tts|diagnostics|pwa) map to the new layout
  if (['ai', 'tts', 'diagnostics'].includes(section)) section = 'advanced';
  if (section === 'pwa') section = 'offline';

  async function render() {
    const capability = await capabilityService.refresh().catch(() => capabilityService.snapshot());

    const nav = h('div', { class: 'settingsnav' }, SECTIONS.map((s) => h('button', {
      class: `settingsnav__item${section === s.id ? ' is-active' : ''}`,
      type: 'button',
      on: { click: () => { section = s.id; render(); } }
    }, svgIcon(s.icon, 18), h('span', { text: s.label }))));

    const body = h('div', { class: 'stack' });
    if (section === 'speech') await renderSpeech(body, capability);
    if (section === 'study') await renderStudy(body);
    if (section === 'data') await renderData(body);
    if (section === 'offline') await renderOffline(body, capability);
    if (section === 'appearance') await renderAppearance(body);
    if (section === 'help') renderHelp(body);
    if (section === 'advanced') await renderAdvanced(body, capability);

    root.replaceChildren(h('div', { class: 'page page--settings' },
      h('div', { class: 'page__pad' },
        h('p', { class: 'muted small', text: `Meu Dicionário v${APP_VERSION} · 巴西葡语个人词典 + 我的词汇库` })
      ),
      nav,
      body
    ));
  }

  /* --------------------------------------------------------------- 语音 */
  async function renderSpeech(host, capability) {
    await TTSService.init();
    const cache = await TTSService.cacheStats();
    const voices = TTSService.listPtVoices();
    const neuralReady = capability.tts.configured;
    const settings = TTSService.getSettings();

    host.appendChild(h('section', { class: 'card' },
      h('div', { class: 'row row--between' },
        h('h2', { class: 'card__title', text: '巴西葡语发音' }),
        neuralReady ? badge('神经网络语音', 'green') : badge('设备语音', 'amber')
      ),
      h('p', { class: 'muted small', text: neuralReady
        ? '当前使用后端提供的巴西葡语（pt-BR）神经网络语音。听过的内容会自动保存到本机，之后离线也能播放。'
        : '当前使用 iPhone 内置的葡萄牙语（巴西）语音：完全离线可用，但音质较普通。听过的内容会保存到本机。' }),
      btn('试听一句巴西葡语', {
        icon: 'play',
        onClick: async () => {
          try {
            await TTSService.unlock();
            const result = await TTSService.speak('Oi! Tudo bem? Vamos praticar português do Brasil.');
            if (result.fallback) toast('后端语音未启用，正在用设备语音播放', { tone: 'warn' });
          } catch (err) {
            toast(err?.message || '播放失败', { tone: 'warn' });
          }
        }
      }),
      voices.length
        ? h('p', { class: 'muted small', text: `检测到 ${voices.length} 个葡语系统语音：${voices.map((v) => v.name).slice(0, 3).join('、')}${voices.length > 3 ? '…' : ''}` })
        : h('p', { class: 'notice notice--warn', text: '没有检测到葡语系统语音。可在 iPhone：设置 → 辅助功能 → 朗读内容 → 语音 → 添加「葡萄牙语（巴西）」。' })
    ));

    host.appendChild(h('section', { class: 'card' },
      h('h2', { class: 'card__title', text: '离线语音' }),
      h('ul', { class: 'bulletlist' },
        h('li', { text: `已保存音频：${cache.count} 段（${formatBytes(cache.bytes)}）` }),
        h('li', { text: '已保存的音频完全离线可播放。' }),
        h('li', { text: '没有保存过的句子，离线时会提示需要联网。' })
      ),
      btn('清空已保存音频', {
        tone: 'ghost', size: 'sm', icon: 'trash',
        onClick: async () => {
          const ok = await confirmDialog({ title: '清空音频', message: '将删除所有已保存的发音，之后需要联网或使用设备语音重新生成。', confirmLabel: '清空', tone: 'danger' });
          if (!ok) return;
          await audioRepo.clear();
          toast('已清空');
          render();
        }
      }),
      h('label', { class: 'switchrow' },
        h('input', {
          type: 'checkbox',
          checked: Boolean(settings.prefetchOnSave),
          on: {
            change: async (e) => {
              await TTSService.configure({ prefetchOnSave: e.target.checked });
              toast(e.target.checked ? '收藏新词时会自动保存发音（需联网）' : '已关闭自动保存发音');
            }
          }
        }),
        h('span', { text: '收藏新词时自动保存发音（联网时）' })
      )
    ));
  }

  /* --------------------------------------------------------------- 学习 */
  async function renderStudy(host) {
    const dailyGoal = await settingsRepo.get('study.dailyGoal', 20);
    const autoPlay = await settingsRepo.get('study.autoPlay', true);
    const goalInput = textInput({ value: String(dailyGoal), inputmode: 'numeric' });

    host.appendChild(h('section', { class: 'card' },
      h('h2', { class: 'card__title', text: '学习设置' }),
      field('每日目标（张卡片）', goalInput),
      h('label', { class: 'switchrow' },
        h('input', {
          type: 'checkbox',
          checked: autoPlay,
          on: { change: async (e) => { await settingsRepo.set('study.autoPlay', e.target.checked); toast('已保存'); } }
        }),
        h('span', { text: '卡片出现时自动播放发音' })
      ),
      btn('保存', {
        onClick: async () => {
          await settingsRepo.set('study.dailyGoal', Number(goalInput.value) || 20);
          toast('已保存', { tone: 'ok' });
        }
      })
    ));
  }

  /* --------------------------------------------------------- 数据与备份 */
  async function renderData(host) {
    const [favorites, entries, resources] = await Promise.all([
      favoriteRepo.count(), dictionaryRepo.count(), resourceRepo.all()
    ]);
    const estimate = await (await import('../../db/idb.js')).estimateStorage();

    host.appendChild(h('section', { class: 'card' },
      h('h2', { class: 'card__title', text: '本机数据' }),
      h('ul', { class: 'bulletlist' },
        h('li', { text: `我的词汇库：${favorites} 条` }),
        h('li', { text: `系统词典：${entries} 个词条` }),
        h('li', { text: `已下载资源：${resources.length} 个` }),
        estimate ? h('li', { text: `存储占用：约 ${formatBytes(estimate.usage)}` }) : null
      )
    ));

    host.appendChild(h('section', { class: 'card card--highlight' },
      h('h2', { class: 'card__title', text: '导出我的词汇库（换手机用这个）' }),
      h('p', { class: 'muted small', text: '只包含你自己的数据：收藏、例句、标签、学习记录。不含系统词典，也不含任何密钥。' }),
      h('div', { class: 'stack' },
        btn('导出我的词汇库（JSON）', {
          block: true,
          icon: 'download',
          onClick: async () => {
            const counts = await exportService.exportPersonalJson();
            toast(`已导出 ${counts.favorites} 条词汇`, { tone: 'ok' });
          }
        }),
        btn('导出我的词汇库（CSV / Excel）', {
          tone: 'ghost',
          block: true,
          icon: 'download',
          onClick: async () => {
            const n = await exportService.exportCsv();
            toast(`已导出 ${n} 条`, { tone: 'ok' });
          }
        })
      )
    ));

    host.appendChild(h('section', { class: 'card' },
      h('h2', { class: 'card__title', text: '导入 / 恢复' }),
      h('p', { class: 'muted small', text: '支持本应用导出的 JSON 备份（自动识别「我的词汇库」或「系统词典」），也支持 Excel / CSV 词表。' }),
      h('div', { class: 'stack' },
        h('label', { class: 'btn btn--primary btn--md btn--block' },
          svgIcon('upload', 18),
          h('span', { text: '选择文件导入' }),
          h('input', {
            type: 'file',
            accept: '.json,.csv,.tsv,.txt,.xlsx',
            class: 'visually-hidden',
            on: { change: (event) => handleImportFile(event.target.files?.[0]) }
          })
        ),
        btn('表格导入向导（Excel / CSV / 粘贴）', { tone: 'ghost', block: true, icon: 'list', onClick: () => navigate('/import') })
      )
    ));

    host.appendChild(h('section', { class: 'card' },
      h('h2', { class: 'card__title', text: '备份系统词典资源' }),
      h('p', { class: 'muted small', text: '系统词典与我的词汇库分开备份：换设备时通常只需要上面那份「我的词汇库」。' }),
      btn('导出系统词典（JSON）', {
        tone: 'ghost',
        block: true,
        icon: 'download',
        onClick: async () => {
          const counts = await exportService.exportDictionaryJson();
          toast(`已导出 ${counts.dictionaryEntries} 个词条`, { tone: 'ok' });
        }
      })
    ));

    host.appendChild(h('section', { class: 'card card--danger' },
      h('h2', { class: 'card__title', text: '删除数据' }),
      h('div', { class: 'stack' },
        btn('清空我的词汇库', {
          tone: 'danger',
          block: true,
          onClick: async () => {
            const ok = await confirmDialog({ title: '清空我的词汇库', message: '将删除所有收藏与学习记录（系统词典保留）。建议先导出备份。', confirmLabel: '清空', tone: 'danger' });
            if (!ok) return;
            await clearAllUserData();
            toast('已清空');
            bus.emit(EVENTS.FAVORITES_CHANGED, { action: 'clear' });
            render();
          }
        }),
        btn('重置应用（删除全部本地数据）', {
          tone: 'danger',
          block: true,
          onClick: async () => {
            const ok = await confirmDialog({ title: '重置应用', message: '将删除所有本地数据并重新安装内置词典。建议先导出备份。', confirmLabel: '全部删除', tone: 'danger' });
            if (!ok) return;
            await wipeDatabase();
            try {
              const caches = await caches.keys();
              await Promise.all(caches.map((c) => caches.delete(c)));
            } catch { /* ignore */ }
            toast('已重置，正在重新加载…', { tone: 'ok' });
            setTimeout(() => window.location.reload(), 900);
          }
        })
      )
    ));
  }

  async function handleImportFile(file) {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.json')) {
      navigate('/import');
      toast('请在导入向导中选择这个文件');
      return;
    }
    const sheetRef = openSheet({ title: '正在恢复', content: h('p', { class: 'muted', text: '正在读取备份…' }), dismissible: false });
    try {
      const json = JSON.parse(await file.text());
      const result = await exportService.importBackup(json);
      sheetRef.close();
      const label = result.kind === 'dictionary' ? '系统词典' : result.kind === 'full' ? '完整备份' : '我的词汇库';
      toast(`已恢复${label}：词汇 ${result.favorites} 条、词典 ${result.entries} 条`, { tone: 'ok', duration: 4200 });
      bus.emit(EVENTS.FAVORITES_CHANGED, { action: 'restore' });
      bus.emit(EVENTS.DICTIONARY_CHANGED, { action: 'restore' });
      render();
    } catch (err) {
      sheetRef.close();
      toast(err?.message || '恢复失败', { tone: 'error' });
    }
  }

  /* --------------------------------------------------------- 离线与安装 */
  async function renderOffline(host, capability) {
    const env = diagnosticsService.environment();
    const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
    const cache = await TTSService.cacheStats();

    host.appendChild(h('section', { class: 'card card--highlight' },
      h('h2', { class: 'card__title', text: '把这个应用装到主屏幕' }),
      h('ol', { class: 'steps' },
        h('li', {}, h('strong', { text: '① 用 Safari 打开本应用网址' }), h('span', { text: '必须是 Safari（Chrome 在 iPhone 上不支持）。' })),
        h('li', {}, h('strong', { text: '② 点击底部「分享」按钮' }), h('span', { text: '就是方块 + 向上箭头那个图标。' })),
        h('li', {}, h('strong', { text: '③ 选择「添加到主屏幕」' }), h('span', { text: '可以改名字，然后点「添加」。' })),
        h('li', {}, h('strong', { text: '④ 从桌面图标打开' }), h('span', { text: '以后就是全屏 App，不用再输网址。' }))
      ),
      env.standalone
        ? h('p', { class: 'notice', text: '✅ 你正在以独立 App 模式使用（已添加到主屏幕）。' })
        : h('p', { class: 'notice', text: '当前是浏览器标签页模式。按上面 4 步添加后即可全屏使用。' })
    ));

    host.appendChild(h('section', { class: 'card' },
      h('h2', { class: 'card__title', text: '离线能做什么' }),
      h('div', { class: 'statuslist' },
        statusRow('✅ 打开应用', env.hasServiceWorker && reg?.active ? '已就绪' : '需要联网打开一次'),
        statusRow('✅ 搜索已下载词典', '可用'),
        statusRow('✅ 我的词汇库 / 收藏 / 标签', '可用'),
        statusRow('✅ 学习与复习记录', '可用'),
        statusRow('✅ 已保存的发音', `${cache.count} 段可播放`),
        statusRow('✅ 导入 / 导出', '可用'),
        statusRow('⚠️ AI 分析', capability.ai.configured ? '需要联网' : '后端未启用'),
        statusRow('⚠️ 未保存过的新句子发音', '需要联网')
      )
    ));

    host.appendChild(h('section', { class: 'card' },
      h('h2', { class: 'card__title', text: '状态' }),
      h('div', { class: 'statuslist' },
        statusRow('网络', env.online ? '在线' : '离线'),
        statusRow('离线缓存', reg?.active ? '已启用' : '未启用（需用 https 打开一次）'),
        statusRow('本机数据库', env.hasIndexedDB ? '正常' : '不可用（无痕模式？）'),
        statusRow('运行模式', env.standalone ? '独立 App' : '浏览器标签页')
      ),
      h('div', { class: 'row row--wrap row--gap' },
        btn('检查更新', { tone: 'ghost', size: 'sm', icon: 'refresh', onClick: checkForUpdate }),
        btn('复制应用网址', {
          tone: 'ghost', size: 'sm', icon: 'copy',
          onClick: async () => { await copyText(window.location.href.split('#')[0]); toast('已复制', { tone: 'ok' }); }
        }),
        btn('资源中心', { tone: 'ghost', size: 'sm', icon: 'download', onClick: () => navigate('/resources') })
      )
    ));
  }

  async function checkForUpdate() {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (!reg) { toast('还没有离线缓存（需要用 https 打开一次）', { tone: 'warn' }); return; }
      await reg.update();
      toast('已检查更新', { tone: 'ok' });
    } catch (err) {
      toast(err?.message || '检查失败', { tone: 'warn' });
    }
  }

  function statusRow(label, value) {
    return h('div', { class: 'statuslist__row' },
      h('span', { class: 'statuslist__label', text: label }),
      h('span', { class: 'statuslist__value', text: value })
    );
  }

  /* --------------------------------------------------------------- 外观 */
  async function renderAppearance(host) {
    const theme = await settingsRepo.get('ui.theme', 'auto');
    host.appendChild(h('section', { class: 'card' },
      h('h2', { class: 'card__title', text: '外观' }),
      field('主题', select([
        { value: 'auto', label: '跟随系统（推荐）' },
        { value: 'light', label: '浅色' },
        { value: 'dark', label: '深色' }
      ], {
        value: theme,
        onChange: async (v) => {
          await settingsRepo.set('ui.theme', v);
          document.documentElement.dataset.theme = v;
          toast('已切换');
        }
      }))
    ));
  }

  /* ----------------------------------------------------------- 使用帮助 */
  function renderHelp(host) {
    host.appendChild(h('section', { class: 'card' },
      h('h2', { class: 'card__title', text: '查单词' }),
      h('ol', { class: 'steps' },
        h('li', {}, h('strong', { text: '① 底部点「词典」，或直接在首页搜索框输入' })),
        h('li', {}, h('strong', { text: '② 输入葡语（dar conta）或中文（应付）都可以' })),
        h('li', {}, h('strong', { text: '③ 看释义、搭配、例句；点 🔊 听发音；点例句里的任意单词也能查' })),
        h('li', {}, h('strong', { text: '④ 点 ⭐ 收藏 → 自动进入「我的词汇」' }))
      )
    ));
    host.appendChild(h('section', { class: 'card' },
      h('h2', { class: 'card__title', text: '添加新词（最常用）' }),
      h('ol', { class: 'steps' },
        h('li', {}, h('strong', { text: '① 在 YouTube / TikTok / 聊天里复制一句葡语' })),
        h('li', {}, h('strong', { text: '② 打开 App → 首页「＋ 添加新词」→ 粘贴' })),
        h('li', {}, h('strong', { text: '③ 点「AI 分析」：自动给出中文意思、词性、搭配、例句' })),
        h('li', {}, h('strong', { text: '④ 勾选想学的部分（整句里只留 dar conta de、sozinho…）→ 保存' }))
      ),
      h('p', { class: 'muted small', text: 'AI 暂未启用时也能用：点「只保存」先把词记下来，之后再加释义。' })
    ));
    host.appendChild(h('section', { class: 'card' },
      h('h2', { class: 'card__title', text: '其他' }),
      h('div', { class: 'statuslist' },
        statusRow('我的词汇', '底部「我的词汇」：搜索、修改、加标签、删除'),
        statusRow('学习', '底部「学习」：认识 / 模糊 / 不认识，系统自动安排复习'),
        statusRow('离线', '词典、我的词汇、学习记录、已保存发音都能离线用'),
        statusRow('换手机', '旧手机导出备份 → 新手机「数据与备份」导入')
      )
    ));
  }

  /* ----------------------------------------------------------- 高级设置 */
  async function renderAdvanced(host, capability) {
    const [aiSettings, ttsSettings] = await Promise.all([AIService.getSettings(), TTSService.getSettings()]);
    host.appendChild(h('p', { class: 'notice', text: '这里是给部署者用的配置。普通使用完全不需要改动。' }));

    const providerSelect = select([
      { value: 'auto', label: '使用我的后端（推荐）' },
      { value: 'proxy', label: '指定后端地址' },
      { value: 'mock', label: '示例数据（非 AI，仅测试流程）' },
      { value: 'none', label: '关闭 AI' }
    ], { value: aiSettings.provider, onChange: async (v) => { await AIService.configure({ provider: v }); render(); } });

    host.appendChild(h('section', { class: 'card' },
      h('div', { class: 'row row--between' },
        h('h2', { class: 'card__title', text: 'AI 后端' }),
        capability.ai.configured ? badge('已启用', 'green') : badge('暂未启用', 'neutral')
      ),
      field('提供方式', providerSelect),
      field('后端地址', textInput({
        value: aiSettings.proxyUrl,
        placeholder: '/api/ai',
        onInput: (v) => { aiSettings.proxyUrl = v; }
      }), { hint: '默认 /api/ai（项目自带 /api/ai/analyze、/api/ai/explain、/api/ai/examples）。密钥只存在服务器。' }),
      h('p', { class: 'muted small', text: capability.ai.message || '' }),
      capability.ai.configured
        ? null
        : h('p', { class: 'notice notice--warn', text: '启用方法：在后端配置好 AI 服务密钥（只存在服务器，不会进入手机端），然后回到这里点「重新检查」。详见 README 第 6、7 节。' }),
      h('div', { class: 'row row--gap' },
        btn('保存', {
          onClick: async () => {
            await AIService.configure({ proxyUrl: aiSettings.proxyUrl.trim() });
            await capabilityService.refresh({ force: true });
            toast('已保存', { tone: 'ok' });
            render();
          }
        }),
        btn('重新检查', {
          tone: 'ghost',
          icon: 'refresh',
          onClick: async () => {
            const state = await capabilityService.refresh({ force: true });
            toast(state.ai.configured ? 'AI 已就绪' : (state.ai.message || 'AI 暂未启用'), { tone: state.ai.configured ? 'ok' : 'warn', duration: 4200 });
            render();
          }
        })
      ),
      h('details', { class: 'details' },
        h('summary', { text: '使用我自己的 API Key（不推荐，仅供个人自用）' }),
        h('div', { class: 'stack' },
          h('p', { class: 'notice notice--warn', text: '这个模式下浏览器会直接访问 AI 服务，Key 会保存在本机浏览器中。只在你自己的设备上使用；正式部署请用上面的后端方式。' }),
          field('API Key', textInput({ value: aiSettings.apiKey, placeholder: 'sk-…', onInput: (v) => { aiSettings.apiKey = v; } })),
          field('接口地址', textInput({ value: aiSettings.baseUrl, onInput: (v) => { aiSettings.baseUrl = v; } })),
          field('模型', textInput({ value: aiSettings.model, onInput: (v) => { aiSettings.model = v; } })),
          btn('保存并切换到自带 Key 模式', {
            tone: 'ghost',
            onClick: async () => {
              await AIService.configure({
                provider: 'openai',
                apiKey: aiSettings.apiKey.trim(),
                baseUrl: aiSettings.baseUrl.trim(),
                model: aiSettings.model.trim()
              });
              toast('已切换', { tone: 'ok' });
              render();
            }
          })
        )
      )
    ));

    const ttsProvider = select([
      { value: 'auto', label: '自动（后端优先，缺失时用设备语音）' },
      { value: 'proxy', label: '只用后端神经网络语音' },
      { value: 'device', label: '只用设备内置语音' },
      { value: 'none', label: '关闭语音' }
    ], { value: ttsSettings.provider, onChange: async (v) => { await TTSService.configure({ provider: v }); render(); } });

    host.appendChild(h('section', { class: 'card' },
      h('div', { class: 'row row--between' },
        h('h2', { class: 'card__title', text: '语音引擎' }),
        capability.tts.configured ? badge('神经网络语音', 'green') : badge('设备语音', 'amber')
      ),
      field('提供方式', ttsProvider),
      field('后端地址', textInput({
        value: ttsSettings.proxyUrl,
        placeholder: '/api/tts',
        onInput: (v) => { ttsSettings.proxyUrl = v; }
      }), { hint: '默认 /api/tts（/api/tts/speak）。后端支持 OpenAI / Azure / ElevenLabs / Google 的 pt-BR 语音。' }),
      h('p', { class: 'muted small', text: capability.tts.message || '' }),
      h('label', { class: 'switchrow' },
        h('input', {
          type: 'checkbox',
          checked: Boolean(ttsSettings.allowDeviceFallback),
          on: { change: async (e) => { await TTSService.configure({ allowDeviceFallback: e.target.checked }); toast('已保存'); } }
        }),
        h('span', { text: '后端不可用时自动改用设备内置语音（保证发音始终可用）' })
      ),
      h('div', { class: 'row row--gap' },
        btn('保存', {
          onClick: async () => {
            await TTSService.configure({ proxyUrl: ttsSettings.proxyUrl.trim() });
            await capabilityService.refresh({ force: true });
            toast('已保存', { tone: 'ok' });
            render();
          }
        }),
        btn('试听', {
          tone: 'ghost',
          icon: 'play',
          onClick: async () => {
            try { await TTSService.speak('Eu não estou dando conta desse trabalho.'); } catch (err) { toast(err.message, { tone: 'warn' }); }
          }
        })
      ),
      h('details', { class: 'details' },
        h('summary', { text: '使用我自己的 TTS Key（不推荐）' }),
        h('div', { class: 'stack' },
          h('p', { class: 'notice notice--warn', text: '同样会把 Key 保存在本机浏览器，仅适合个人自用。' }),
          field('OpenAI Key', textInput({ value: ttsSettings.openaiKey, onInput: (v) => { ttsSettings.openaiKey = v; } })),
          field('模型', textInput({ value: ttsSettings.openaiModel, onInput: (v) => { ttsSettings.openaiModel = v; } })),
          field('音色', textInput({ value: ttsSettings.openaiVoice, onInput: (v) => { ttsSettings.openaiVoice = v; } })),
          btn('保存并只用自带 Key', {
            tone: 'ghost',
            onClick: async () => {
              await TTSService.configure({
                provider: 'openai',
                openaiKey: ttsSettings.openaiKey.trim(),
                openaiModel: ttsSettings.openaiModel.trim(),
                openaiVoice: ttsSettings.openaiVoice.trim()
              });
              toast('已切换', { tone: 'ok' });
              render();
            }
          })
        )
      )
    ));

    const resultHost = h('div', { class: 'stack' });
    const env = diagnosticsService.environment();
    host.appendChild(h('section', { class: 'card' },
      h('h2', { class: 'card__title', text: '诊断与自检' }),
      h('div', { class: 'statuslist' },
        statusRow('版本', APP_VERSION),
        statusRow('设备', env.isIOS ? 'iOS / iPadOS' : '其他'),
        statusRow('浏览器', env.isSafari ? 'Safari' : '其他'),
        statusRow('运行模式', env.standalone ? '独立 App' : '浏览器标签页'),
        statusRow('在线', env.online ? '是' : '否'),
        statusRow('IndexedDB', env.hasIndexedDB ? '可用' : '不可用'),
        statusRow('Service Worker', env.hasServiceWorker ? '支持' : '不支持'),
        statusRow('Excel 解析', env.hasDecompressionStream ? '支持 .xlsx' : '仅 CSV')
      ),
      btn('运行自检', {
        icon: 'check',
        onClick: async () => {
          replaceChildren(resultHost, h('p', { class: 'muted', text: '运行中…' }));
          const report = await diagnosticsService.runSelfTest();
          replaceChildren(resultHost,
            h('div', { class: 'card card--muted' },
              h('p', { text: `通过 ${report.summary.passed} · 提示 ${report.summary.warned} · 失败 ${report.summary.failed}` }),
              h('p', { class: 'muted small', text: dateTime(report.ranAt) })
            ),
            h('div', { class: 'card card--list' }, report.results.map((r) => listRow({
              title: r.label,
              subtitle: r.detail,
              badges: [badge(r.status === 'pass' ? '通过' : r.status === 'warn' ? '提示' : '失败', r.status === 'pass' ? 'green' : r.status === 'warn' ? 'amber' : 'danger')]
            })))
          );
        }
      }),
      resultHost,
      h('p', { class: 'muted small', text: env.userAgent })
    ));

    host.appendChild(h('section', { class: 'stack' },
      btn('关于本应用 · 数据政策 · 路线图', { tone: 'ghost', icon: 'info', block: true, onClick: () => navigate('/about') }),
      btn('资源中心', { tone: 'ghost', icon: 'download', block: true, onClick: () => navigate('/resources') })
    ));
  }

  await render();
  return {};
}
