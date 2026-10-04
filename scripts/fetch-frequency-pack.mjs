#!/usr/bin/env node
/**
 * Generates a high-frequency word pack from a legally redistributable source.
 *
 *   npm run packs -- --limit 3000 --out src/data/packs/frequency-3000.json
 *
 * Default source: FrequencyWords (Hermit Dave) — CC BY-SA 4.0, redistributable
 * with attribution. The script keeps that attribution inside the generated
 * pack so the app can display it in 资源中心.
 *
 * REQUIRES NETWORK. Without network it fails loudly with instructions instead
 * of writing an empty file.
 *
 * Options:
 *   --limit N     how many words (default 3000)
 *   --lang CODE   source language code (default pt)
 *   --source URL  override the frequency list URL
 *   --out PATH    output file (default src/data/packs/frequency-<limit>.json)
 *   --id ID       pack id (default frequency-<limit>)
 *   --glossary PATH  optional JSON {"word": "中文"} to attach translations
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const LIMIT = Number(arg('limit', 3000));
const LANG = arg('lang', 'pt');
const SOURCE = arg('source', `https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/${LANG}/${LANG}_50k.txt`);
const OUT = resolve(ROOT, arg('out', `src/data/packs/frequency-${LIMIT}.json`));
const ID = arg('id', `frequency-${LIMIT}`);
const GLOSSARY = arg('glossary', null);

async function main() {
  console.log(`\n· 生成高频词包：limit=${LIMIT} lang=${LANG}`);
  console.log(`· 数据源：${SOURCE}`);

  let raw;
  try {
    const res = await fetch(SOURCE);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.text();
  } catch (err) {
    console.error(`\n✗ 无法下载词频数据：${err.message}`);
    console.error('  这个脚本需要联网。请在能上网的电脑上运行，或手动准备词表后');
    console.error('  用应用内的「导入」功能导入 CSV / Excel。\n');
    process.exit(1);
  }

  let glossary = {};
  if (GLOSSARY) {
    try {
      glossary = JSON.parse(await readFile(resolve(ROOT, GLOSSARY), 'utf8'));
    } catch (err) {
      console.warn(`· 词表释义文件读取失败（将继续生成无中文释义的词表）：${err.message}`);
    }
  }

  const lines = raw.split(/\r?\n/).filter(Boolean);
  const entries = [];
  const seen = new Set();
  let rank = 0;

  for (const line of lines) {
    const [word] = line.split(/\s+/);
    if (!word) continue;
    const clean = word.trim();
    if (!/^[\p{L}][\p{L}'-]*$/u.test(clean)) continue;   // skip numbers/punctuation
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rank += 1;
    if (rank > LIMIT) break;

    const translation = glossary[key] || glossary[clean] || '';
    entries.push({
      headword: clean,
      type: 'word',
      translations: translation ? [translation] : [],
      meanings: translation ? [{ definition: translation, note: '' }] : [],
      frequencyRank: rank,
      tags: ['高频词'],
      source: {
        id: ID,
        name: `高频词 ${LIMIT}（FrequencyWords）`,
        license: 'CC BY-SA 4.0',
        version: 1
      },
      packId: ID
    });
  }

  if (!entries.length) {
    console.error('✗ 没有解析出任何词条，请检查数据源格式。');
    process.exit(1);
  }

  const pack = {
    id: ID,
    name: `高频词 ${entries.length}（FrequencyWords）`,
    version: 1,
    license: 'CC BY-SA 4.0',
    source: 'FrequencyWords by Hermit Dave — https://github.com/hermitdave/FrequencyWords',
    attribution: 'Word frequency data from FrequencyWords (Hermit Dave), licensed CC BY-SA 4.0. 修改后的词条由脚本生成。',
    generatedAt: new Date().toISOString(),
    entries
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(pack, null, 2), 'utf8');

  const withTranslation = entries.filter((e) => e.translations.length).length;
  console.log(`· 已写入 ${entries.length} 个词条（其中 ${withTranslation} 条带中文释义）`);
  console.log(`· 文件：${OUT}`);
  console.log('\n下一步：');
  console.log('  1. 在 src/data/packs/catalog.json 里登记该资源包的 license / source。');
  console.log('  2. 用户可在「资源中心」下载安装，安装后完全离线可用。');
  console.log('  3. 如需中文释义，用 --glossary 传入 {"palavra":"中文"} 形式的 JSON。\n');
}

main().catch((err) => { console.error(err); process.exit(1); });
