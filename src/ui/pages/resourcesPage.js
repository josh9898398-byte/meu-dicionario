/**
 * 资源中心 — 一键下载。
 *
 * 每个资源都是一个按钮：点「下载」就会真正下载并安装到本机数据库，
 * 装完即可离线使用（高频词 3000/5000 需要联网下载一次，之后完全离线）。
 *
 * 内置的示例词典随应用提供，点击即为「安装」，不需要联网。
 */

import { viewRoot, setTitle, confirmDialog } from '../shell.js';
import {
  h, replaceChildren, btn, badge, toast, openSheet, sectionTitle, navigate, spinner
} from '../components.js';
import { svgIcon } from '../../core/dom.js';
import { resourceService } from '../../services/resourceService.js';
import { dictionaryService } from '../../services/dictionaryService.js';
import { audioRepo } from '../../db/repos.js';
import { TTSService } from '../../services/ttsService.js';
import { capabilityService } from '../../services/capabilityService.js';
import { bus, EVENTS } from '../../core/events.js';
import { formatBytes, relTime } from '../../core/format.js';
import { isOnline } from '../../services/connectivityService.js';

const ORDER = [
  'core-words',
  'frequency-3000',
  'frequency-5000',
  'colloquial-br',
  'collocations-br',
  'top-verbs',
  'frequency-sample',
  'audio-core',
  'commercial-dictionary'
];

export default async function resourcesPage() {
  setTitle('资源中心', {
    back: true,
    actions: [h('button', {
      class: 'iconbtn', type: 'button', 'aria-label': '导入我的词表',
      on: { click: () => navigate('/import') }
    }, svgIcon('upload', 20))]
  });

  const root = viewRoot();
  await capabilityService.refresh().catch(() => {});
  const listHost = h('div', { class: 'stack' });
  const footerHost = h('div', { class: 'card card--muted' });
  root.replaceChildren(h('div', { class: 'page' },
    h('p', { class: 'notice', text: '下载后保存在本机，之后离线也能搜索和播放。' }),
    listHost,
    footerHost
  ));

  function sortPacks(packs) {
    return packs.slice().sort((a, b) => {
      const ia = ORDER.indexOf(a.id);
      const ib = ORDER.indexOf(b.id);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  }

  function packCard(pack) {
    if (pack.unavailable) {
      return h('div', { class: 'card card--muted' },
        h('div', { class: 'row row--between' },
          h('strong', { text: pack.name }),
          badge('不提供下载', 'neutral')
        ),
        h('p', { class: 'muted small', text: pack.unavailableReason || pack.description }),
        h('p', { class: 'muted small', text: '如果你有合法授权数据，可以用「导入」页面导入 CSV / Excel。' })
      );
    }

    const size = pack.sizeBytes ? `约 ${formatBytes(pack.sizeBytes)}` : '';
    const count = pack.entryCount ? `${pack.entryCount} 条` : '';
    const isAudio = pack.generator === 'tts';
    const needsNetwork = Boolean(pack.requiresNetwork) && !pack.installed;
    const canDownload = !needsNetwork || isOnline();

    const action = pack.installed
      ? h('div', { class: 'row row--gap-sm' },
          badge('已下载', 'green'),
          h('button', {
            class: 'linkbtn linkbtn--danger', type: 'button', text: '删除',
            on: { click: () => removePack(pack) }
          })
        )
      : btn('下载', {
          size: 'sm',
          disabled: !canDownload,
          onClick: () => installPack(pack)
        });

    const meta = [size, count, needsNetwork ? '需要联网一次' : '内置，立即可用'].filter(Boolean).join(' · ');

    return h('div', { class: 'card' },
      h('div', { class: 'row row--between row--gap' },
        h('div', { class: 'stack stack--tight' },
          h('strong', { text: pack.name }),
          h('span', { class: 'muted small', text: meta })
        ),
        action
      ),
      h('p', { class: 'muted small', text: pack.description }),
      pack.license?.name
        ? h('p', { class: 'muted small', text: `许可：${pack.license.name}${pack.license.url ? ` · ${pack.source?.name || ''}` : ''}` })
        : null,
      pack.installedRecord?.installedAt
        ? h('p', { class: 'muted small', text: `安装于 ${relTime(pack.installedRecord.installedAt)}${pack.installedRecord.itemCount ? ` · ${pack.installedRecord.itemCount} 条` : ''}` })
        : null,
      isAudio && !capabilityService.ttsBackendReady()
        ? h('p', { class: 'notice notice--warn', text: '生成发音需要后端已启用神经网络语音。未启用时可以正常使用设备内置语音（普通音质）。' })
        : null,
      needsNetwork && !canDownload
        ? h('p', { class: 'notice notice--warn', text: '当前处于离线状态，下载需要联网。连上网络后回到这里再点一次即可。' })
        : null
    );
  }

  async function refresh() {
    replaceChildren(listHost, spinner('正在读取资源列表…'));
    try {
      const packs = sortPacks(await resourceService.listPacks());
      const dictPacks = packs.filter((p) => p.kind === 'dictionary' || p.kind === 'frequency');
      const audioPacks = packs.filter((p) => p.kind === 'audio');

      replaceChildren(listHost,
        h('section', {}, sectionTitle('词典与词表'), h('div', { class: 'stack' }, dictPacks.map(packCard))),
        audioPacks.length ? h('section', {}, sectionTitle('发音'), h('div', { class: 'stack' }, audioPacks.map(packCard))) : null,
        h('p', { class: 'muted small', text: '数据说明：内置词典为作者原创示例数据（CC0-1.0）；高频词表来自开源项目 FrequencyWords（CC BY-SA 4.0）。商业词典受版权保护，不提供下载。' })
      );
    } catch (err) {
      replaceChildren(listHost, h('div', { class: 'card card--error' },
        h('strong', { text: '无法读取资源列表' }),
        h('p', { class: 'muted small', text: err?.message || String(err) }),
        btn('重试', { onClick: refresh })
      ));
    }
    await refreshFooter();
  }

  async function refreshFooter() {
    const audio = await audioRepo.stats();
    const stats = dictionaryService.stats();
    replaceChildren(footerHost,
      h('h2', { class: 'card__title', text: '本机存储' }),
      h('ul', { class: 'bulletlist' },
        h('li', { text: `系统词典：${stats.total} 个词条` }),
        h('li', { text: `已保存发音：${audio.count} 段（${formatBytes(audio.bytes)}）` })
      ),
      h('div', { class: 'row row--wrap row--gap' },
        btn('清空发音缓存', {
          tone: 'ghost', size: 'sm', icon: 'trash',
          onClick: async () => {
            const ok = await confirmDialog({ title: '清空发音', message: '将删除所有已保存的音频。', confirmLabel: '清空', tone: 'danger' });
            if (!ok) return;
            await audioRepo.clear();
            toast('已清空');
            refreshFooter();
          }
        }),
        btn('导入我自己的词表', { tone: 'ghost', size: 'sm', icon: 'upload', onClick: () => navigate('/import') })
      )
    );
  }

  async function installPack(pack) {
    const progress = h('div', { class: 'stack' },
      h('p', { class: 'muted', text: '准备下载…' }),
      h('div', { class: 'progress' }, h('div', { class: 'progress__fill', style: { width: '6%' } }))
    );
    const sheetRef = openSheet({ title: `下载：${pack.name}`, content: progress, dismissible: false });
    try {
      const result = await resourceService.install(pack, {
        onProgress: ({ phase, percent, done, total }) => {
          const labels = {
            download: '正在下载', parse: '正在解析', write: '正在保存到本机',
            index: '正在建立索引', tts: '正在生成发音', done: '完成'
          };
          const p = Math.max(6, Math.min(100, Number(percent) || 0));
          progress.querySelector('p').textContent = `${labels[phase] || phase}… ${p}%${total ? `（${done || 0}/${total}）` : ''}`;
          progress.querySelector('.progress__fill').style.width = `${p}%`;
        }
      });
      sheetRef.close();
      toast(`${pack.name} 已下载：${result.itemCount} 条${result.failures?.length ? `，失败 ${result.failures.length}` : ''}`, { tone: 'ok', duration: 3600 });
      bus.emit(EVENTS.RESOURCES_CHANGED, { packId: pack.id });
      bus.emit(EVENTS.DICTIONARY_CHANGED, { packId: pack.id });
      await capabilityService.refresh({ force: true }).catch(() => {});
      refresh();
    } catch (err) {
      sheetRef.close();
      toast(err?.message || '下载失败', { tone: 'error', duration: 4800 });
    }
  }

  async function removePack(pack) {
    const ok = await confirmDialog({
      title: '删除资源',
      message: `确定删除「${pack.name}」吗？来自它的词条会被移除，但你收藏到「我的词汇」的内容不受影响。`,
      confirmLabel: '删除',
      tone: 'danger'
    });
    if (!ok) return;
    const result = await resourceService.remove(pack.id);
    toast(`已删除（移除 ${result.removed} 个词条）`);
    bus.emit(EVENTS.DICTIONARY_CHANGED, { packId: pack.id });
    refresh();
  }

  const off = bus.on(EVENTS.RESOURCES_CHANGED, () => refresh().catch(() => {}));
  await refresh();
  return { unmount() { off(); } };
}
