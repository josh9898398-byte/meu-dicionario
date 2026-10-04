#!/usr/bin/env node
/**
 * Static checks that run with zero dependencies:
 *   - every ES module parses (node --check equivalent via dynamic import graph)
 *   - every JSON file is valid
 *   - every import path referenced from src/ exists
 *   - manifest + service worker precache files exist
 *
 *   npm run check
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const errors = [];
const warnings = [];

async function walk(dir, filter) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full, filter));
    else if (filter(entry.name)) out.push(full);
  }
  return out;
}

async function checkJson(files) {
  for (const file of files) {
    try {
      JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      errors.push(`JSON 无效: ${file} — ${err.message}`);
    }
  }
}

async function checkModules(files) {
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    // 1. syntactic check through the JS parser (dynamic import of a data URL)
    try {
      await import(`data:text/javascript,${encodeURIComponent(source.replace(/^\uFEFF/, ''))}`);
    } catch (err) {
      const message = String(err?.message || err);
      // Import-time errors caused by missing browser globals are expected; we
      // only fail on genuine SyntaxErrors.
      if (err instanceof SyntaxError || /SyntaxError/.test(message)) {
        errors.push(`语法错误: ${file} — ${message}`);
      }
    }
    // 2. relative import targets must exist on disk
    const importRe = /(?:^|\n)\s*(?:import|export)[^'"\n]*from\s*['"](\.[^'"]+)['"]/g;
    let match;
    while ((match = importRe.exec(source))) {
      const spec = match[1];
      const target = resolve(dirname(file), spec);
      try {
        await stat(target);
      } catch {
        errors.push(`找不到模块: ${file} → ${spec}`);
      }
    }
    // 3. dynamic imports with a literal string
    const dynRe = /import\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    while ((match = dynRe.exec(source))) {
      const target = resolve(dirname(file), match[1]);
      try { await stat(target); } catch { errors.push(`找不到动态模块: ${file} → ${match[1]}`); }
    }
  }
}

async function checkServiceWorker() {
  const sw = await readFile(join(ROOT, 'sw.js'), 'utf8');
  const listMatch = sw.match(/const PRECACHE_URLS = \[([\s\S]*?)\];/);
  if (!listMatch) { warnings.push('sw.js 未找到 PRECACHE_URLS'); return; }
  const urls = listMatch[1].match(/'\.\/[^']+'/g) || [];
  for (const raw of urls) {
    const rel = raw.slice(2, -1);
    const target = join(ROOT, rel === '' ? 'index.html' : rel);
    try { await stat(target); } catch { errors.push(`Service Worker 预缓存文件不存在: ${rel}`); }
  }
}

async function checkManifest() {
  const manifestPath = join(ROOT, 'manifest.webmanifest');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const key of ['name', 'short_name', 'start_url', 'display', 'icons']) {
    if (!manifest[key]) errors.push(`manifest 缺少字段: ${key}`);
  }
  for (const icon of manifest.icons || []) {
    const target = join(ROOT, String(icon.src).replace(/^\.\//, ''));
    try { await stat(target); } catch { errors.push(`manifest 图标不存在: ${icon.src}`); }
  }
  const html = await readFile(join(ROOT, 'index.html'), 'utf8');
  for (const needle of ['manifest.webmanifest', 'apple-mobile-web-app-capable', 'viewport-fit=cover', 'sw.js']) {
    if (!html.includes(needle) && needle !== 'sw.js') errors.push(`index.html 缺少: ${needle}`);
  }
}

async function main() {
  const js = await walk(join(ROOT, 'src'), (n) => n.endsWith('.js'));
  const json = await walk(ROOT, (n) => n.endsWith('.json') || n.endsWith('.webmanifest'));
  const scripts = await walk(join(ROOT, 'scripts'), (n) => n.endsWith('.mjs'));
  const tests = await walk(join(ROOT, 'tests'), (n) => n.endsWith('.mjs'));
  const api = await walk(join(ROOT, 'api'), (n) => n.endsWith('.js'));

  await checkJson(json);
  await checkModules([...js, ...scripts, ...tests, ...api, join(ROOT, 'sw.js')]);
  await checkServiceWorker();
  await checkManifest();
  await checkCss();
  await checkNoSecrets();
  await checkDist();

  console.log(`\ncheck: ${js.length} modules, ${json.length} json files, ${scripts.length + tests.length} scripts`);
  for (const warning of warnings) console.log(`  ⚠ ${warning}`);
  if (errors.length) {
    for (const error of errors) console.error(`  ✗ ${error}`);
    console.error(`\n${errors.length} problem(s) found\n`);
    process.exit(1);
  }
  console.log('  ✓ all checks passed\n');
}

/**
 * SECURITY GUARD: the frontend must never contain an API key.
 *
 * Everything under src/, index.html and app-config.js is shipped to the browser,
 * so a key there would be public. Keys belong to the server (api/_handlers.js
 * reads them from process.env at request time).
 */
async function checkNoSecrets() {
  const clientFiles = [
    join(ROOT, 'index.html'),
    join(ROOT, 'app-config.js'),
    join(ROOT, 'sw.js'),
    ...(await walk(join(ROOT, 'src'), (n) => n.endsWith('.js') || n.endsWith('.css')))
  ];
  // Also scan the built bundle when it exists (what actually reaches the browser).
  if (await exists(join(ROOT, 'dist'))) {
    for (const relativePath of ['index.html', 'app-config.js', 'sw.js']) {
      const file = join(ROOT, 'dist', relativePath);
      if (await exists(file)) clientFiles.push(file);
    }
    clientFiles.push(...(await walk(join(ROOT, 'dist', 'src'), (n) => n.endsWith('.js') || n.endsWith('.css'))));
  }
  const KEY_PATTERNS = [
    { re: /sk-[A-Za-z0-9_-]{20,}/, label: 'OpenAI 风格的密钥' },
    { re: /\b(OPENAI_API_KEY|AZURE_SPEECH_KEY|ELEVENLABS_API_KEY|GOOGLE_TTS_API_KEY)\b/, label: '服务端环境变量名' },
    { re: /process\.env/, label: 'process.env（前端不能读取服务器环境变量）' },
    { re: /\bAIza[0-9A-Za-z_-]{30,}/, label: 'Google API Key' }
  ];
  for (const file of clientFiles) {
    const text = await readFile(file, 'utf8');
    for (const { re, label } of KEY_PATTERNS) {
      if (re.test(text)) {
        errors.push(`前端代码中检测到疑似密钥/服务器变量（${label}）: ${relative(ROOT, file)}`);
      }
    }
  }
  const gitignore = await readFile(join(ROOT, '.gitignore'), 'utf8').catch(() => '');
  if (!/^\.env$/m.test(gitignore)) errors.push('.gitignore 必须忽略 .env（避免密钥被提交）');
  // The backend is allowed (and expected) to read keys from the environment.
  const handlers = await readFile(join(ROOT, 'api', '_handlers.js'), 'utf8');
  if (!/process\.env\.OPENAI_API_KEY/.test(handlers)) {
    warnings.push('api/_handlers.js 未从环境变量读取 OPENAI_API_KEY');
  }
}

/**
 * Cheap CSS sanity check: balanced braces, no stray characters before blocks,
 * and every `@media`/`@supports` followed by a block.
 */
async function checkCss() {
  const files = await walk(join(ROOT, 'src', 'styles'), (n) => n.endsWith('.css'));
  for (const file of files) {
    const css = await readFile(file, 'utf8');
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const opens = (withoutComments.match(/\{/g) || []).length;
    const closes = (withoutComments.match(/\}/g) || []).length;
    if (opens !== closes) errors.push(`CSS 花括号不匹配: ${file}（{ ${opens} vs } ${closes}）`);
    // selectors must not contain a literal '@media' mid-list (a common typo)
    const inlineAt = withoutComments.match(/[^}]\s*@media[^{]*\{[^}]*\}\s*[^{}]*\{/);
    if (inlineAt && /,\s*@media/.test(withoutComments)) {
      errors.push(`CSS 中出现选择器列表内嵌 @media: ${file}`);
    }
    if (/@media[^{]*\{\s*\}/.test(withoutComments)) {
      errors.push(`CSS 中有空的 @media 块: ${file}`);
    }
  }
}

/** If a build exists, verify the emitted dist/ is self-consistent. */
async function checkDist() {
  if (!(await exists(join(ROOT, 'dist')))) {
    warnings.push('dist/ 不存在（运行 npm run build 后会自动验证构建产物）');
    return;
  }
  const html = await readFile(join(ROOT, 'dist', 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:href|src)="(\.\/[^"]+)"/g)].map((m) => m[1]);
  for (const ref of refs) {
    if (!(await exists(join(ROOT, 'dist', ref.replace(/^\.\//, ''))))) {
      errors.push(`dist/index.html 引用了不存在的文件: ${ref}`);
    }
  }
  const manifestPath = join(ROOT, 'dist', 'build-manifest.json');
  if (!(await exists(manifestPath))) {
    errors.push('dist/build-manifest.json 缺失（Service Worker 需要它做完整预缓存）');
  } else {
    const files = JSON.parse(await readFile(manifestPath, 'utf8'));
    for (const file of files) {
      if (!(await exists(join(ROOT, 'dist', file.replace(/^\.\//, ''))))) {
        errors.push(`build-manifest 列出了不存在的文件: ${file}`);
      }
    }
    for (const required of ['./index.html', './sw.js', './manifest.webmanifest', './app-config.js']) {
      if (!files.includes(required)) errors.push(`build-manifest 缺少必要文件: ${required}`);
    }
  }
  const swVersion = (await readFile(join(ROOT, 'dist', 'sw.js'), 'utf8')).match(/const VERSION = '([^']+)'/)?.[1];
  const cfgVersion = (await readFile(join(ROOT, 'dist', 'app-config.js'), 'utf8')).match(/"version":\s*"([^"]+)"/)?.[1];
  if (swVersion !== cfgVersion) errors.push(`版本号不一致: sw.js=${swVersion} app-config.js=${cfgVersion}`);
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

main().catch((err) => {
  console.error('check failed:', err);
  process.exit(1);
});
