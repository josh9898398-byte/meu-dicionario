/**
 * Dependency-free delimited-text and XLSX parsing.
 *
 * CSV/TXT  : RFC4180-ish parser with delimiter sniffing and encoding fallback.
 * XLSX     : real Office Open XML reader — ZIP (stored/deflated) + XML, using
 *            the browser's own `DecompressionStream('deflate-raw')`.
 *            No SheetJS, no bundle, works offline on iOS 16.4+.
 * XLS      : the legacy binary format is NOT supported (see parseSpreadsheet).
 */

/* ------------------------------------------------------------------ text */

const DELIMITERS = [',', ';', '\t', '|'];

export function sniffDelimiter(text) {
  const sample = String(text).slice(0, 8000).split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
  if (!sample.length) return ',';
  let best = { delimiter: ',', score: -1 };
  for (const delimiter of DELIMITERS) {
    const counts = sample.map((line) => splitLine(line, delimiter).length);
    const first = counts[0] || 1;
    if (first < 2) continue;
    const consistent = counts.filter((c) => c === first).length / counts.length;
    const score = consistent * 10 + Math.min(first, 8);
    if (score > best.score) best = { delimiter, score };
  }
  return best.score < 0 ? ',' : best.delimiter;
}

function splitLine(line, delimiter) {
  const out = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { current += '"'; i += 1; } else inQuotes = false;
      } else current += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      out.push(current); current = '';
    } else current += ch;
  }
  out.push(current);
  return out;
}

/** Parse delimited text into a grid (# handles quoted newlines). */
export function parseDelimited(text, { delimiter = null } = {}) {
  const clean = String(text).replace(/^\ufeff/, '');
  const delim = delimiter || sniffDelimiter(clean);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === delim) { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (ch === '\r') continue;
    field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return { grid: rows.map((r) => r.map((c) => c.trim())), delimiter: delim };
}

/**
 * Plain text lists. Understands:
 *   palavra<TAB>significado
 *   palavra - significado / palavra – significado / palavra = significado
 *   palavra; significado
 *   1. palavra — significado
 *   palavra        (meaning left empty, will be AI-analyzed later)
 */
export function parsePlainLines(text) {
  const lines = String(text).replace(/^\ufeff/, '').split(/\r?\n/);
  const rows = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const cleaned = line.replace(/^\s*\d+[.)、]\s*/, '');
    const parts = cleaned.split(/\t|\s+[–—\-=]\s+|;|\s\|\s/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) rows.push([parts[0], parts.slice(1).join(' ')]);
    else rows.push([cleaned, '']);
  }
  return { grid: rows, delimiter: 'auto' };
}

/* ------------------------------------------------------------------ xlsx */

const SIG_EOCD = 0x06054b50;

export function canReadXlsx() {
  return typeof DecompressionStream !== 'undefined' && typeof DOMParser !== 'undefined';
}

export async function parseXlsx(arrayBuffer) {
  if (!canReadXlsx()) {
    throw new Error('此浏览器不支持解析 Excel（需要 Safari 16.4+）。请改用 CSV 导入。');
  }
  const files = await readZip(new Uint8Array(arrayBuffer));
  const decoder = new TextDecoder('utf-8');

  const workbookXml = files.get('xl/workbook.xml');
  if (!workbookXml) throw new Error('文件不是有效的 .xlsx（缺少 workbook.xml）');
  const relsXml = files.get('xl/_rels/workbook.xml.rels');
  const sharedXml = files.get('xl/sharedStrings.xml');

  const workbook = new DOMParser().parseFromString(decoder.decode(workbookXml), 'application/xml');
  const rels = relsXml ? parseRels(decoder.decode(relsXml)) : {};
  const sharedStrings = sharedXml ? parseSharedStrings(decoder.decode(sharedXml)) : [];

  const sheets = [];
  // <sheets> wraps the <sheet> elements, so search descendants (real Excel
  // files look exactly like this).
  const sheetNodes = descendantsByLocalName(workbook.documentElement, 'sheet');
  for (const node of sheetNodes) {
    const name = node.getAttribute('name') || `Sheet${sheets.length + 1}`;
    const relId = node.getAttribute('r:id') || node.getAttribute('id') || node.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    const target = rels[relId];
    const path = normalizeTarget(target || `xl/worksheets/sheet${sheets.length + 1}.xml`);
    const xml = files.get(path);
    if (!xml) continue;
    const doc = new DOMParser().parseFromString(decoder.decode(xml), 'application/xml');
    sheets.push({ name, grid: parseSheet(doc, sharedStrings) });
  }
  if (!sheets.length) throw new Error('未在 Excel 文件中找到工作表');
  return { sheets };
}

function normalizeTarget(target) {
  if (!target) return target;
  if (target.startsWith('/')) return target.slice(1);
  if (target.startsWith('xl/')) return target;
  return `xl/${target.replace(/^\.\//, '')}`;
}

function parseRels(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const map = {};
  for (const node of childrenByLocalName(doc.documentElement, 'Relationship')) {
    const id = node.getAttribute('Id');
    const target = node.getAttribute('Target');
    if (id && target) map[id] = target;
  }
  return map;
}

function parseSharedStrings(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const out = [];
  for (const si of childrenByLocalName(doc.documentElement, 'si')) {
    out.push(textOf(si));
  }
  return out;
}

function textOf(node) {
  let text = '';
  for (const t of descendantsByLocalName(node, 't')) text += t.textContent || '';
  return text;
}

function parseSheet(doc, sharedStrings) {
  const grid = [];
  const sheetData = descendantsByLocalName(doc.documentElement, 'sheetData')[0] || doc.documentElement;
  for (const rowNode of childrenByLocalName(sheetData, 'row')) {
    const rowIndex = Number(rowNode.getAttribute('r') || grid.length + 1) - 1;
    const row = grid[rowIndex] || (grid[rowIndex] = []);
    for (const cell of childrenByLocalName(rowNode, 'c')) {
      const ref = cell.getAttribute('r') || '';
      const type = cell.getAttribute('t') || 'n';
      const colIndex = ref ? columnIndex(ref.replace(/\d+/g, '')) : row.length;
      let value = '';
      if (type === 'inlineStr') {
        value = textOf(cell);
      } else {
        const v = descendantsByLocalName(cell, 'v')[0];
        const raw = v ? v.textContent : '';
        if (type === 's') value = sharedStrings[Number(raw)] ?? '';
        else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
        else value = raw ?? '';
      }
      row[colIndex] = String(value ?? '').trim();
    }
  }
  return grid.map((row) => (row || []).map((c) => (c ?? '').trim()));
}

export function columnIndex(letters) {
  let n = 0;
  for (const ch of String(letters).toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) continue;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

function childrenByLocalName(node, localName) {
  const out = [];
  if (!node) return out;
  for (const child of node.childNodes) {
    if (child.nodeType === 1 && child.localName === localName) out.push(child);
  }
  return out;
}

function descendantsByLocalName(node, localName) {
  const out = [];
  if (!node) return out;
  const walk = (n) => {
    for (const child of n.childNodes) {
      if (child.nodeType !== 1) continue;
      if (child.localName === localName) out.push(child);
      walk(child);
    }
  };
  walk(node);
  return out;
}

/* ------------------------------------------------------------------- zip */

async function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);
  if (eocd < 0) throw new Error('压缩包结构异常（未找到目录结尾）');
  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const files = new Map();

  for (let i = 0; i < entryCount; i += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue;
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(dataStart, dataStart + compressedSize);
    files.set(name, await inflate(data, method));
  }
  return files;
}

function findEocd(view) {
  const max = Math.min(view.byteLength, 66000);
  for (let i = view.byteLength - 22; i >= view.byteLength - max; i -= 1) {
    if (i < 0) break;
    if (view.getUint32(i, true) === SIG_EOCD) return i;
  }
  return -1;
}

async function inflate(data, method) {
  if (method === 0) return data;
  if (method !== 8) throw new Error(`不支持的压缩方式（method=${method}）`);
  if (typeof DecompressionStream === 'undefined') throw new Error('当前环境不支持解压缩');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* -------------------------------------------------------------- dispatch */

export function detectFileKind(file) {
  const name = String(file?.name || '').toLowerCase();
  const type = String(file?.type || '');
  if (name.endsWith('.xlsx') || type.includes('spreadsheetml')) return 'xlsx';
  if (name.endsWith('.xls') || type.includes('ms-excel')) return 'xls-legacy';
  if (name.endsWith('.csv')) return 'csv';
  if (name.endsWith('.tsv') || name.endsWith('.txt')) return 'txt';
  if (name.endsWith('.json')) return 'json';
  return 'txt';
}

export async function parseSpreadsheet(file) {
  const kind = detectFileKind(file);
  if (kind === 'xls-legacy') {
    throw new Error('不支持旧版 .xls 二进制格式。请在 Excel / Numbers 中「另存为 .xlsx 或 CSV」后重新导入。');
  }
  if (kind === 'xlsx') {
    const buffer = await file.arrayBuffer();
    const { sheets } = await parseXlsx(buffer);
    return { kind, sheets };
  }
  const text = await readAsText(file);
  const parsed = kind === 'csv' ? parseDelimited(text) : parsePlainLines(text);
  return { kind, sheets: [{ name: '文本', grid: parsed.grid }], delimiter: parsed.delimiter };
}

/** Decode with UTF-8 first, then fall back to Windows-1252 (common in Excel exports). */
export async function readAsText(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('windows-1252').decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }
}
