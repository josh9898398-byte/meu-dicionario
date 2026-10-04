# Meu Dicionário · 我的巴西葡语语言数据库

一个**可直接在 iPhone Safari 打开、添加到主屏幕、离线可用**的个人巴西葡语词典 + 生词本 + AI 学习工具。

不是 Demo：所有数据都写入本机 IndexedDB，离线可搜索、可复习、可播放已缓存的语音；AI 与神经网络语音在未配置时会**明确提示需要联网/未配置**，不会假装可用。

---

## 0. 分成两种读者

| 你是谁 | 看哪里 |
|---|---|
| **最终用户**（只想要「打开网址 → 添加到主屏幕 → 使用」） | [QUICKSTART.md](./QUICKSTART.md) — 里面没有任何开发者内容 |
| **部署者**（首次把应用放到公网、配置 AI/TTS 密钥） | 本文件，尤其第 1、5、6、7 节 |

最终用户永远不会接触到：GitHub / npm / Node.js / Python / .env / API Key / build / dist / 命令行。
这些只出现在「一次性部署」环节。

---

## 0.1 安全模型（重要）

```
iPhone PWA  →  你自己的后端 /api/ai/* · /api/tts/*  →  OpenAI / Azure / ElevenLabs …
                （密钥只存在服务器环境变量里）
```

* 前端代码里**没有**任何 API Key，`scripts/check.mjs` 里有自动扫描（发现 `sk-…`、`OPENAI_API_KEY`、`process.env` 出现在前端文件就会让构建失败）。
* 浏览器只调用你自己的 `/api/...`，密钥永不下发到浏览器。
* 导出备份**绝不包含**密钥（有测试覆盖）。
* 没配置后端时，App 依然完整可用，AI 显示「AI 功能暂未启用」。

---

## 目录

1. [技术栈与设计理由](#1-技术栈与设计理由)
2. [项目目录结构](#2-项目目录结构)
3. [本地开发方式](#3-本地开发方式)
4. [构建方式](#4-构建方式)
5. [部署方式](#5-部署方式)
6. [环境变量说明](#6-环境变量说明)
7. [API 配置说明（AI / TTS）](#7-api-配置说明ai--tts)
8. [数据库结构说明](#8-数据库结构说明)
9. [如何添加词典数据](#9-如何添加词典数据)
10. [如何添加 / 更换 TTS](#10-如何添加--更换-tts)
11. [如何部署到公网](#11-如何部署到公网)
12. [如何在 iPhone 添加到主屏幕](#12-如何在-iphone-添加到主屏幕)
13. [测试结果](#13-测试结果)
14. [当前已完成的功能](#14-当前已完成的功能)
15. [尚未完成的功能（诚实清单）](#15-尚未完成的功能诚实清单)

---

## 1. 技术栈与设计理由

| 层 | 选型 | 说明 |
|---|---|---|
| UI | 原生 ES Modules + CSS（零依赖） | 无构建步骤也能直接跑 |
| 数据 | IndexedDB（分层：词典层 / 个人层） | 大量词库不放 localStorage |
| 离线 | 手写 Service Worker + manifest | App Shell + 资源包 + 音频缓存 |
| 语音 | TTSService（可替换提供方） | 在线生成 + 本地缓存，支持后续离线包 |
| AI | AIService（严格结构化 JSON） | 前端永不依赖一大段纯文本 |
| 路由 | Hash 路由 | 任何静态托管都能用，无需重写规则 |
| 导入 | 自研 CSV / XLSX 解析 | 不依赖 SheetJS，离线可用 |

### 为什么不是 React + TypeScript + Vite？

原需求建议 React + TS + Vite。我改成了**零依赖原生方案**，理由是它更符合你列出的硬约束：

1. **部署最简单**：`dist/` 或整个目录扔到任意静态托管即可，不需要 Node 环境、不需要 `npm install`。
2. **离线最可靠**：没有打包器/hashing/运行时注入，Service Worker 的预缓存清单就是文件本身。
3. **零维护成本**：不存在框架大版本升级、依赖漏洞、锁文件冲突。
4. **可继续开发**：`src/services/*` 与 `src/db/*` 是纯 JS 模块，若将来想迁移到 React + TS，可以逐个搬过去，数据结构（`src/db/schema.js`）无需改动。
5. **本机构建环境限制**：开发环境无法访问 npm registry 与网络，React 工具链无法安装；零依赖方案是本环境下唯一能被真实验证（`npm test` + `npm run build` 均实跑通过）的方案。

TypeScript 的收益（类型安全）用三层替代：JSDoc 注释契约、`src/db/schema.js` 的显式字段声明、以及 81 个真实运行的行为测试。

---

## 2. 项目目录结构

```
.
├─ index.html                  # 应用外壳（含 iOS PWA meta、安全区域、启动画面）
├─ offline.html                # Service Worker 的离线兜底页
├─ manifest.webmanifest        # PWA manifest（图标、快捷方式、standalone）
├─ sw.js                       # Service Worker（预缓存 + 离线策略）
├─ app-config.js               # 运行时配置（可手改；构建时由环境变量覆盖）
├─ package.json                # 脚本：dev / build / test / check / icons / packs
├─ vercel.json                 # Vercel 部署 + 缓存与安全响应头
├─ netlify.toml                # Netlify 部署
├─ .env.example                # 环境变量示例
├─ LICENSE-DATA.md             # 数据来源与版权政策
│
├─ api/                        # 可选的服务器端代理（不部署也能用 App）
│  ├─ ai.js                    # POST /api/ai  结构化分析（OpenAI 兼容）
│  ├─ tts.js                   # POST /api/tts 神经网络语音（4 家 provider）
│  ├─ _shared.js               # 共用工具与系统提示词
│  ├─ cloudflare-worker.js     # Cloudflare Workers 入口
│  └─ netlify/ai.js            # Netlify Functions 适配器
├─ netlify/functions/          # Netlify ESM 函数入口
│
├─ src/
│  ├─ main.js                  # 启动流程、路由注册、Service Worker 注册
│  ├─ config.js                # 默认配置与限额
│  ├─ core/                    # 基础设施
│  │  ├─ dom.js                # 安全 DOM 构造（全程 textContent，天然防 XSS）
│  │  ├─ router.js             # hash 路由
│  │  ├─ events.js             # 轻量事件总线
│  │  └─ format.js             # 时间/容量/CSV 转义/下载等工具
│  ├─ db/
│  │  ├─ schema.js             # IndexedDB 表结构与版本（词典层 / 个人层）
│  │  ├─ idb.js                # Promise 化封装（含 Safari 事务竞态修复）
│  │  └─ repos.js              # 所有仓储（唯一直接访问数据库的地方）
│  ├─ services/
│  │  ├─ dictionaryService.js  # 搜索排序、词形还原、词组匹配、索引
│  │  ├─ normalizer.js         # pt-BR 归一化 / 分词 / 去重键
│  │  ├─ srsService.js         # 复习调度（新词→学习中→熟悉→已掌握）
│  │  ├─ aiService.js          # AIService.analyzeVocabulary() 结构化输出
│  │  ├─ ttsService.js         # TTSService.speak() 多提供方 + 缓存
│  │  ├─ importService.js      # 字段识别 → 预览 → 去重 → 导入
│  │  ├─ csvParser.js          # 自研 CSV / TXT / XLSX(ZIP+XML) 解析
│  │  ├─ exportService.js      # JSON 备份 / CSV 导出 / 备份恢复
│  │  ├─ resourceService.js    # 资源中心（下载/安装/删除）
│  │  ├─ connectivityService.js# 在线/离线
│  │  ├─ diagnosticsService.js # 设备自检（在真机上验证）
│  │  └─ bootstrap.js          # 首次启动安装内置词典
│  ├─ ui/
│  │  ├─ shell.js              # 顶栏 / 底部导航 / 面板 / toast
│  │  ├─ components.js         # 播放按钮、⭐收藏按钮、可点击句子等
│  │  └─ pages/                # 11 个页面
│  │     ├─ homePage.js        # 首页（搜索框 + 快速添加 + 待复习 + 统计）
│  │     ├─ dictionaryPage.js  # 词典搜索
│  │     ├─ entryPage.js       # 词条详情
│  │     ├─ notebookPage.js    # 我的生词本（筛选/排序/批量）
│  │     ├─ favoritePage.js    # 生词条目详情与编辑
│  │     ├─ studyPage.js       # 复习卡片流程
│  │     ├─ addPage.js         # 添加新词 + AI 整理
│  │     ├─ importPage.js      # Excel / CSV / TXT 导入向导
│  │     ├─ resourcesPage.js   # 资源中心
│  │     ├─ settingsPage.js    # 设置（AI/语音/数据/PWA/诊断）
│  │     └─ aboutPage.js       # 关于 + 数据政策 + 路线图
│  ├─ data/packs/             # 内置词典数据（JSON 资源包）
│  └─ styles/                  # app.css（设计系统）+ pages.css
│
├─ assets/icons/              # PWA 图标（PNG 由脚本生成）
├─ scripts/                   # 零依赖 Node 脚本
│  ├─ serve.mjs               # 本地开发服务器
│  ├─ build.mjs               # 构建 dist/ + 生成 build-manifest.json
│  ├─ check.mjs               # 静态检查（语法/JSON/引用/manifest/SW）
│  ├─ make-icons.mjs          # 生成 PNG 图标（自研 PNG 编码器）
│  └─ fetch-frequency-pack.mjs# 生成 3000/5000 高频词包（需联网）
└─ tests/                     # 81 个测试（含内存版 IndexedDB 与 XLSX 夹具）
```

---

## 3. 本地开发方式

需要：Node.js ≥ 18（仅本地开发用；**iPhone 上不需要任何运行环境**）。

```bash
# 不需要 npm install（零依赖）
npm run dev          # → http://localhost:5173
npm run dev -- --port 8080
```

也可以直接用任意静态服务器（Python / VS Code Live Server 皆可）：

```bash
python3 -m http.server 5173
```

> Service Worker（离线能力）只在 **https** 或 **localhost** 下生效，这是浏览器安全策略，不是本项目限制。

---

## 4. 构建方式

```bash
npm run build        # 生成 dist/ + build-manifest.json，并把环境变量写入 app-config.js
npm run check        # 静态检查：语法、JSON、相对引用、manifest 图标、SW 预缓存
npm test             # 81 个行为测试
npm run verify       # check + test
npm run icons        # 重新生成 PWA 图标
```

构建产物 `dist/` 约 513 KB / 53 个文件（未压缩，含内置词典数据），可以部署到任何静态托管。

**也可以完全跳过构建**：直接把仓库根目录当作静态站点部署（`index.html` 在根目录）。构建的作用是生成完整预缓存清单与写入环境变量。

---

## 5. 部署方式

| 平台 | 构建命令 | 发布目录 | 备注 |
|---|---|---|---|
| Vercel | `npm run build` | `dist` | `vercel.json` 已包含缓存与安全响应头 |
| Netlify | `npm run build` | `dist` | `netlify.toml` 已配置；函数在 `netlify/functions` |
| Cloudflare Pages | `npm run build` | `dist` | 函数：`api/cloudflare-worker.js` |
| GitHub Pages | 无需构建 | `/`（仓库根） | 纯静态，见下方 workflow |
| 任意共享主机 / 对象存储 | 无需构建 | 上传目录 | 需支持 https 才能用离线 |

**GitHub Pages 最简流程**

```bash
git init && git add . && git commit -m "meu dicionário pt-BR"
git remote add origin https://github.com/<你>/<仓库>.git
git push -u origin main
```

然后在仓库 **Settings → Pages** 选择分支 `main` / 目录 `/ (root)`，网址形如
`https://<你>.github.io/<仓库>/`。

> 本项目全部使用相对路径 + hash 路由，所以**子目录部署无需任何额外配置**。

---

## 6. 环境变量说明

全部可选。不配置时应用仍可离线使用；AI 会显示「示例数据（非 AI）」，语音回落到设备内置 pt-BR 语音。

### 构建期（写入 `dist/app-config.js`）

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PLP_VERSION` | `package.json` 的 version | 版本号与缓存名 |
| `PLP_AI_PROXY_URL` | `/api/ai` | AI 代理地址 |
| `PLP_TTS_PROXY_URL` | `/api/tts` | TTS 代理地址 |
| `PLP_AI_TRANSPORT` | `auto` | `auto`/`proxy`/`openai`/`mock`/`none` |
| `PLP_TTS_TRANSPORT` | `auto` | `auto`/`proxy`/`openai`/`device`/`none` |
| `PLP_RESOURCE_CATALOG` | 空 | 远端资源目录 JSON 地址 |
| `PLP_ALLOW_MOCK_AI` | `true` | 是否显示「示例数据（非 AI）」模式 |

### 运行时（服务端，`api/ai.js`）

| 变量 | 必需 | 说明 |
|---|---|---|
| `OPENAI_API_KEY` | ✅ | AI 服务密钥（任何 OpenAI 兼容服务） |
| `AI_MODEL` | — | 默认 `gpt-4o-mini` |
| `AI_BASE_URL` | — | 默认 `https://api.openai.com/v1`（可指向 Azure / OpenRouter / DeepSeek / Ollama） |
| `AI_SHARED_SECRET` | — | 设置后客户端必须带 `x-app-secret` |

### 运行时（服务端，`api/tts.js`）

| 变量 | 说明 |
|---|---|
| `TTS_PROVIDER` | `openai` / `elevenlabs` / `azure` / `google` |
| `OPENAI_API_KEY`、`TTS_MODEL`、`TTS_VOICE` | OpenAI TTS（默认 `gpt-4o-mini-tts` + `marin`） |
| `ELEVENLABS_API_KEY`、`ELEVENLABS_VOICE_ID`、`ELEVENLABS_MODEL` | ElevenLabs |
| `AZURE_SPEECH_KEY`、`AZURE_SPEECH_REGION` | Azure 神经网络语音（默认 `pt-BR-FranciscaNeural`） |
| `GOOGLE_TTS_API_KEY` | Google Cloud TTS（默认 `pt-BR-Neural2-A`） |

复制 `.env.example` 为 `.env` 即可（`.env` 已被 `.gitignore` 忽略）。

---

## 7. API 配置说明（AI / TTS）

### 7.0 路由总览

| 路由 | 方法 | 说明 |
|---|---|---|
| `/api/ai/analyze` | POST | 单词 / 短语 / 句子的结构化分析（含「值得学的表达」列表） |
| `/api/ai/explain` | POST | 解释整句（翻译 + 语法 + 句中值得学的表达） |
| `/api/ai/examples` | POST | 为已有词条生成更多巴西葡语例句 |
| `/api/ai/status` | GET | 仅返回 `{configured, model}`，供前端显示「AI 已启用 / 暂未启用」 |
| `/api/tts/speak` | POST | 返回 `audio/mpeg` 字节（巴西葡语） |
| `/api/tts/status` | GET | 返回 `{configured, provider, voice}` |
| `/api/ai`、`/api/tts` | 兼容 | 旧地址仍然可用（前端在 404 时会自动回退） |

本地开发时 `npm run dev` 只提供静态文件，不执行 `/api/*`（Vercel / Netlify / Cloudflare 才跑 Functions）。因此**默认情况下本地也是「AI 暂未启用」**，这与线上未配置时的表现一致。

### 7.1 AI 能力探测（前端如何知道 AI 能不能用）

启动时前端会 `GET /api/ai/status`：

| 后端返回 | App 的表现 |
|---|---|
| `{configured: true}` | 「AI 分析」按钮可用 |
| `{configured: false}` / 501 | 显示「AI 功能暂未启用」并说明原因；其他功能全部正常 |
| 404（纯静态部署，没有 api/ 目录） | 同上，文案提示「后端未部署」 |
| 离线 | 「需要联网使用 AI 功能」 |

「示例数据（非 AI）」必须由部署者/用户在「设置 → 高级设置」里显式选择，**不会**自动启用——避免看起来像 AI、实际是占位数据。

### AI（`AIService.analyzeVocabulary`）

```js
const result = await AIService.analyzeVocabulary('dar conta', { context: '来自同事聊天' });
// → 严格结构（永远不是一段纯文本）：
// { text, language:'pt-BR', type, headword, partOfSpeech,
//   translations[], meanings[{definition,note}], patterns[], collocations[],
//   examples[{sourceText,translation,note}], relatedExpressions[],
//   usageNotes[], difficulty, tags[], pronunciation{ipa,syllables}, grammar }
```

三种模式：

1. **代理（推荐）**：部署 `api/ai.js`，Key 只存在服务器。应用里保持「自动 / 服务器代理」。
2. **自带 Key**：设置 → AI → 「OpenAI 兼容接口」，Key 只存在本机 IndexedDB（直连会暴露在客户端，仅建议自用）。
3. **示例数据（非 AI）**：未配置时用于验证流程，界面会用黄色标签明确标注「示例数据（非 AI）」。

> 位置变更：2 和 3 现在都收在「设置 → 高级设置」里，普通用户界面不再出现这些选项。

离线时 `analyzeVocabulary` 抛出 `AIError('offline')`，界面显示「需要联网使用 AI 功能」——**不会假装 AI 可用**。

### TTS（`TTSService.speak`）

```js
await TTSService.speak('Eu não estou dando conta disso.', { locale: 'pt-BR' });
await TTSService.prefetch([...例句]);   // 批量生成并缓存，之后离线可播
```

优先级：**已缓存音频 → 在线生成 → 失败即明确报错**。

| Provider | 音质 | 离线 |
|---|---|---|
| `proxy`（`api/tts.js`） | 神经网络（OpenAI/Azure/ElevenLabs/Google） | 生成后离线可播（缓存） |
| `openai` | 神经网络 | 同上 |
| `device`（iOS 内置 pt-BR） | 普通，非神经网络 | ✅ 完全离线 |
| `none` | 关闭 | — |

设备内置语音在界面上被明确标注为「普通音质，非神经网络语音」，绝不冒充高质量巴葡语音。

---

## 8. 数据库结构说明

数据库：`plp-db`（IndexedDB v1）。**两层严格分离**：

### 词典层（可替换、可删除）

| Store | key | 主要索引 | 说明 |
|---|---|---|---|
| `dictionaryEntries` | `id` | `norm`, `head`, `type`, `sourceId`, `packId`, `freq`, `tags` | 完整词条（单词/词组/表达/句子） |
| `words` | `id` | `norm`, `entryId`, `freq` | 单词速查索引 |
| `phrases` | `id` | `norm`, `first`, `entryId` | 多词表达速查索引 |
| `examples` | `id` | `entryId`, `favoriteId`, `norm` | 所有例句（词典/AI/导入/用户） |
| `resources` | `id` | `kind`, `installedAt` | 已安装资源包与版本 |

### 个人层（用户所有，永不被词典更新覆盖）

| Store | key | 主要索引 | 说明 |
|---|---|---|---|
| `favorites` | `id` | `norm`, `entryId`, `mastery`, `nextReviewAt`, `tags`… | 生词本（含内容快照） |
| `learningRecords` | `id` | `favoriteId`, `day`, `rating` | 每次复习记录 |
| `audioCache` | `id` | `createdAt`, `lastUsedAt` | 已生成音频（Blob） |
| `tags` | `id` | `name`, `count` | 标签与使用次数 |
| `imports` | `id` | `createdAt`, `status` | 导入历史与去重结果 |
| `settings` | `key` | — | 设置（AI/TTS/主题等） |

**关键设计**：`Favorite` 保存自己的 `customText / translation / meanings / examples / tags` **快照**，并对词典词条只保留一个可选引用 `dictionaryEntryId`。因此：

* 删除或更换词典资源包 → 生词本内容完好（已有测试覆盖）。
* 未来导入商业词典或切换数据源 → 不影响用户收藏。

主要字段（与原需求一致）：`DictionaryEntry{id, word, normalizedWord, language, partOfSpeech, meanings, examples, collocations, pronunciation, source, version}`、`Favorite{id, dictionaryEntryId, customText, translation, notes, tags, createdAt, updatedAt, masteryLevel, reviewCount, lastReviewedAt, nextReviewAt}`、`Example{id, sourceText, translation, source, audioUrl, cachedAudio}`。

---

## 9. 如何添加词典数据

三种方式，任选其一：

### A. 用户导入（不需要写代码）

应用内 **设置 → 数据与备份 → 导入** 或 **资源中心 → 导入**：支持 `.xlsx` / `.csv` / `.tsv` / `.txt` / 直接粘贴。
系统会显示「检测到以下字段」，由你确认葡语列、中文列、例句列后再导入，并自动去重。

### B. 添加一个内置资源包（写 JSON）

1. 新建 `src/data/packs/meu-pacote.json`：

```json
{
  "id": "meu-pacote",
  "name": "我的词库",
  "version": 1,
  "license": "CC0-1.0",
  "source": "我自己的整理",
  "entries": [
    {
      "headword": "dar conta",
      "type": "phrase",
      "partOfSpeech": "locução verbal",
      "translations": ["应付", "处理"],
      "meanings": [{ "definition": "有能力处理", "note": "常用否定式" }],
      "patterns": ["dar conta de algo"],
      "collocations": ["dar conta do recado"],
      "examples": [
        { "sourceText": "Eu não dou conta disso.", "translation": "这个我应付不过来。", "note": "口语" }
      ],
      "relatedExpressions": ["se virar"],
      "usageNotes": ["口语高频"],
      "difficulty": "B1",
      "tags": ["口语", "工作"]
    }
  ]
}
```

2. 在 `src/data/packs/catalog.json` 里加一条（`bundled: true, autoInstall: false` 表示用户手动下载）。
3. `npm test && npm run build`。

### C. 生成 3000 / 5000 高频词包（需联网，在电脑上跑一次）

```bash
npm run packs -- --limit 3000 --out src/data/packs/frequency-3000.json
```

脚本默认使用 **FrequencyWords**（CC BY-SA 4.0，可再分发）作为词频数据源，并**不会**抓取版权不明的商业词典。生成后把文件放进 `src/data/packs/` 并在 catalog 中登记即可离线使用。

> 版权提醒：Houaiss、Michaelis、Aulete 等商业词典不可再分发，本项目不打包、不伪装下载入口。若你有合法授权数据，请走上面的「导入」流程。

---

## 10. 如何添加 / 更换 TTS

整个应用只通过 `TTSService` 说话，替换提供方只需实现一个对象：

```js
import { TTSService } from './src/services/ttsService.js';

TTSService.registerProvider('meu-tts', {
  cacheable: true,                       // false 表示无法缓存（如设备语音）
  label: '我的神经网络语音',
  async speak(text, { locale, voice, rate }) {
    const res = await fetch('https://my-tts.example/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, locale, voice, rate })
    });
    if (!res.ok) throw new Error(`TTS ${res.status}`);
    return res.blob();                   // 返回音频 Blob 即可
  }
});
```

然后在设置页把 provider 设为 `meu-tts`（或扩展选择器）。返回的 Blob 会自动按 `provider|voice|locale|text` 写入 IndexedDB，之后离线也能播放。

**真正的离线神经网络 TTS**：需要把模型（如 VITS / Piper 的 pt-BR 模型，通常几十 MB）随资源包下载，并用 WebAssembly/WebGPU 推理。当前版本**没有实现**，界面上也明确这样写；架构上只需要新增一个 `cacheable:false, offline:true` 的 provider 即可接入。

---

## 11. 如何部署到公网

### Vercel

```bash
npx vercel --prod
# 环境变量：OPENAI_API_KEY / AI_MODEL / TTS_PROVIDER ...
# 或在 Vercel 后台 Settings → Environment Variables 里添加
```

### Netlify

```bash
npx netlify deploy --prod --dir=dist
# 函数会自动使用 netlify/functions/*
```

### Cloudflare Pages

1. 连接仓库，构建命令 `npm run build`，输出目录 `dist`。
2. 在 `wrangler.toml` 或后台设置环境变量（Secrets）。
3. 代理函数入口：`api/cloudflare-worker.js`。

### 最短路径（不需要命令行）

1. 在 GitHub 建仓库 → 上传本目录全部文件。
2. Settings → Pages → Deploy from branch → `main` / `/ (root)`。
3. 得到 `https://<用户名>.github.io/<仓库>/`。

**必须使用 HTTPS**：Service Worker、添加到主屏幕、麦克风（语音输入）都要求安全上下文。Vercel / Netlify / Cloudflare / GitHub Pages 默认自带 https。

---

## 12. 如何在 iPhone 添加到主屏幕

1. 用 **Safari**（必须是 Safari，Chrome 在 iOS 上不支持添加到主屏幕）打开你的网址。
2. 点击底部中间的 **分享** 按钮（方块 + 向上箭头）。
3. 向下滑，选择 **添加到主屏幕**。
4. 名称可改成「Meu Dicionário」，点 **添加**。
5. 从主屏幕图标打开：全屏 standalone 运行，没有浏览器地址栏，支持安全区域与深色模式。

**首次建议做的三件事**

1. 连网打开一次（让 Service Worker 缓存应用外壳）。
2. 设置 → 安装与离线 → 检查状态；设置 → 诊断 → 运行自检。
3. 若要语音：设置 → 语音 → 配置 TTS（服务器代理或自带 Key），或在 iOS 里添加巴西葡语系统语音（设置 → 辅助功能 → 朗读内容 → 语音 → 葡萄牙语（巴西））。

---

## 13. 测试结果

全部通过（`npm run verify`）：

```
check: 36 个模块, 9 个 JSON, 18 个脚本
  ✓ 语法、JSON、相对引用、manifest 图标、Service Worker 预缓存全部存在
  ✓ dist/ 构建产物完整性（引用文件、预缓存清单、版本号一致性）
  ✓ 前端密钥扫描（前端出现 sk-… / OPENAI_API_KEY / process.env 即失败）+ .env 已在 .gitignore

118/118 tests passed
```

测试覆盖（`tests/`，含内存版 IndexedDB 与真实 XLSX 夹具）：

| 套件 | 数量 | 覆盖内容 |
|---|---|---|
| `app.test.mjs` | 20 | 首次启动安装内置包、关键示例词可搜（aproveitar / dar conta / ficar de boa / saudade…）、中文反查、每条核心词条都有释义+搭配+例句、点句中的「dou」能跳到「dar conta」、收藏→复习→历史、取消收藏不影响词典、JSON/CSV 导出、**个人备份不含系统词典与密钥**、系统词典单独备份、**高频词 3000 一键下载**（解析→3000 条→带排名与许可→可搜索）、音频缓存上限清理、UI 模块可加载、不可用资源有明确原因 |
| `render.test.mjs` | 22 | **真实执行每个页面**（DOM shim）：外壳 5 个底部标签、首页、词典搜索、词条详情（收藏/播放按钮、可点击单词）、点单词弹层、⭐收藏与取消、我的词汇、条目详情、学习流程（显示答案→三个评分按钮）、添加新词（含「这句话里值得学的」勾选列表）、AI mock 必须标注「示例数据（非 AI）」、导入全流程（粘贴→识别→预览→落库）、资源中心、7 个设置分区、自检、关于页、未知 id 空状态、**离线 AI 明确提示** |
| `capability.test.mjs` | 9 | 后端已配置→AI 就绪；后端 501→「AI 功能暂未启用」；后端 404（纯静态部署）→正确降级且提示其他功能不受影响；离线→「需要联网」；显式 mock→可用（界面标注非 AI）；关闭 AI→明确不可用；设备语音不冒充神经网络语音；探测失败不抛错；**后端地址跟随部署位置（子目录部署）** |
| `dictionary.test.mjs` | 14 | 精确/忽略重音/前缀/模糊/中文匹配、词组整体匹配、去重、词形还原、merge 不覆盖例句、删包不动收藏 |
| `import.test.mjs` | 18 | CSV 引号与分隔符嗅探、TXT 多种朴素格式、葡/中/英标题识别、无标题按内容推断、词性列不误判、去重、commit 三种策略、.xls 明确报错 |
| `spreadsheet.test.mjs` | 4 | 真实 `.xlsx`：ZIP(stored + deflate) + sharedStrings + 多工作表 + 稀疏行 |
| `srs.test.mjs` | 11 | 三个按钮的调度结果、间隔阶梯、ease 边界、365 天上限、队列优先级、连续天数、统计 |
| `ai.test.mjs` | 11 | markdown 包裹的 JSON、字符串例句归一化、缺失字段补全、例句上限、mock 明确标记、provider=none 拒绝、网络/JSON/离线错误码 |
| `normalizer.test.mjs` | 10 | 去重键、连字符、中文/葡语判定、不规则动词还原、类型判定、分词、相似度、ID 稳定性 |

**必须在真机上验证的部分**（Node 无法覆盖）：iPhone Safari 的添加到主屏幕、离线启动、系统 pt-BR 语音可用性、音频解锁。为此应用内置了 **设置 → 诊断 → 运行自检**：它会在这台设备上实际检查 IndexedDB 读写、Service Worker、manifest、语音、AI 配置、Excel 解析能力、复习算法，并显示通过/警告/失败。请在 iPhone 上点一次，把结果作为真机验收证据。

---

## 14. 当前已完成的功能

**P0（全部完成）**

- ✅ 手机端 PWA：manifest、standalone、iOS 安全区域、深色模式、底部导航、大按钮、单手操作、无横向滚动
- ✅ 搜索：葡语精确/前缀/模糊（容错拼写）/中文反向查询/我的收藏
- ✅ 词典：单词、词组、表达、句子；词性、释义、结构、搭配、相关表达、使用场景、难度
- ✅ 收藏 ⭐：任意位置一键收藏/取消，状态即时同步（词典、例句、AI 结果、生词本）
- ✅ 我的生词本：搜索、标签、筛选、排序、批量加标签、批量删除、编辑、删除、复习记录
- ✅ 添加新词：输入 / 粘贴 / 语音输入（Web Speech，可用时）；快速保存或 AI 整理
- ✅ TTS：统一 `TTSService`，在线生成 + 本地缓存，已缓存音频完全离线可播；未缓存时明确提示需联网
- ✅ IndexedDB：11 张表，词典层与个人层分离，Safari 事务竞态已处理，超大批量分块写入
- ✅ Excel/CSV/TXT 导入：分隔符嗅探、编码回退（UTF-8 → Windows-1252）、多工作表选择、字段自动识别 + 人工确认、去重、导入记录
- ✅ PWA 安装与离线：Service Worker 预缓存 App Shell，离线兜底页，缓存版本管理，手动检查更新

**P1（全部完成）**

- ✅ AI 自动解释（严格结构化 JSON，含校验与一次自动修复重试）
- ✅ AI 例句与词组扩展（补充到词条或生词本）
- ✅ 复习系统：新词 / 学习中 / 熟悉 / 已掌握，认识 / 模糊 / 不认识，间隔阶梯 + ease 调整
- ✅ 数据导出 / 恢复：JSON 完整备份、生词本 CSV、词典层 CSV、备份恢复（合并，不静默覆盖）
- ✅ 离线词典：资源中心下载/删除，内置 4 个示例包随首次启动自动安装
- ✅ 音频缓存：按 provider+voice+文本 键值缓存，容量上限自动清理（220MB / 4000 条）
- ✅ 诊断自检页、设备环境信息、数据来源与许可展示

**本轮「简化 + 安全」改造（第二轮）**

- ✅ **后端代理**：`/api/ai/analyze|explain|examples|status`、`/api/tts/speak|status`，密钥只存在服务器
- ✅ **密钥安全护栏**：`npm run check` 自动扫描前端文件与 `dist/`，发现 `sk-…`、`OPENAI_API_KEY`、`process.env` 立即失败；`.env` 已被 `.gitignore` 忽略
- ✅ **能力探测**：启动时查询后端状态，未配置时显示「AI 功能暂未启用」，App 其余功能照常可用（不再自动切换 mock）
- ✅ **设置极简化**：普通用户只看到 语音 / 学习 / 数据与备份 / 离线与安装 / 外观 / 使用帮助；AI 后端、语音引擎、诊断全部收进「高级设置」
- ✅ **快速添加升级**：整句粘贴后 AI 返回「这句话里值得学的」列表，可勾选（dar conta de / sozinho / fazer isso）后单独收藏
- ✅ **资源中心一键下载**：基础词典、口语、搭配、动词、高频词 150 内置秒装；**高频词 3000 / 5000 一键联网下载**（FrequencyWords，CC BY-SA 4.0，保留署名）；发音资源可批量缓存；每个资源显示体积、条数、许可
- ✅ **备份分离**：导出「我的词汇库」（JSON / CSV）与导出「系统词典」（JSON）分开，导入时自动识别；备份永不含密钥
- ✅ **iPhone 细节**：键盘弹起时自动隐藏底部导航，输入框不再被遮挡；长句粘贴、加入主屏幕步骤内置在 App 里
- ✅ **术语统一**：界面统一为「我的词汇」，并明确「系统词典 / 我的词汇库」两层分离

**额外完成**

- ✅ 点句中任意单词 → 速查弹层（先匹配多词表达，再回落到单词，支持词形还原）
- ✅ 连续播放例句、例句级播放、播放状态可视化
- ✅ 资源中心明确区分「可下载」「需自行提供数据」「版权不可用」

---

## 15. 尚未完成的功能（诚实清单）

| 功能 | 状态 | 说明 |
|---|---|---|
| OCR 拍照取词 | ❌ 未实现 | 需要 OCR 引擎/服务；界面未放置假按钮，仅在本清单与「关于」页标注 |
| 视频字幕导入 | ❌ 未实现 | 需要字幕解析与时间轴对齐 |
| Anki 导入 | ❌ 未实现 | 可用 CSV 导入替代（导出 `.apkg` 为 SQLite，需要额外解析器） |
| 跟读评分 | ❌ 未实现 | 需要语音评测服务（发音打分），不能本地伪造 |
| AI 对话练习 | ❌ 未实现 | 需要多轮会话与音频流式能力 |
| 完整学习统计图表 | ⏳ 基础版 | 已完成今日待复习、新增、连续天数、正确率、等级分布；趋势图表待做 |
| 真正的离线神经网络 TTS | ❌ 未实现 | 必须随包下载几十 MB 模型 + WASM 推理；架构已留出 provider 接口，界面上明确说明 |
| 完整 3000/5000 高频词表 | ⏳ 需一次性生成 | 内置「前 150」示例；完整表用 `npm run packs -- --limit 3000` 生成（数据源 CC BY-SA 4.0），或导入你自己的词表 |
| 商业词典数据 | ❌ 不提供 | 版权限制；资源中心明确标注「不提供下载」并说明原因 |
| 云同步（多设备） | ❌ 未实现 | 默认本地优先、不上传用户词库；目前用导出/恢复完成换机 |

**需要你配置才能启用的能力**：AI 分析（AI Key 或代理）、神经网络 TTS（TTS provider）。未配置时应用会明确提示，不会假装完成。

---

## 许可与数据

* 应用代码：你可以自由使用与修改。
* 内置示例词典数据：CC0-1.0（作者原创）。
* 详见 [LICENSE-DATA.md](./LICENSE-DATA.md)。
