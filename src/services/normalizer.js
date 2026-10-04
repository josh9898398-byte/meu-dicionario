/**
 * Text normalization for pt-BR + Chinese lookups and de-duplication.
 *
 * Kept dependency-free and pure so it is fully unit-tested.
 */

/** Lowercase, strip accents, collapse spaces, drop most punctuation. */
export function normalizeText(input) {
  if (input === null || input === undefined) return '';
  let s = String(input).normalize('NFD');
  // strip combining diacritics but keep the base letters (á -> a, ç -> c)
  s = s.replace(/[\u0300-\u036f]/g, '');
  // remove zero width + smart quotes
  s = s.replace(/[\u200b-\u200d\ufeff]/g, '').replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
  s = s.toLowerCase();
  // keep letters (incl. accented already stripped), digits, spaces, hyphen, apostrophe
  s = s.replace(/[^\p{L}\p{N}\s\-']/gu, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** Normalized key that ignores hyphen/apostrophe differences ("dar-se" == "darse"). */
export function normalizeKey(input) {
  return normalizeText(input).replace(/[-']/g, '').replace(/\s+/g, ' ').trim();
}

/** Heuristic: does this string contain CJK characters? */
export function hasChinese(input) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(String(input || ''));
}

/** Heuristic: is this probably Portuguese (not Chinese)? */
export function isPortugueseLike(input) {
  const s = String(input || '').trim();
  if (!s) return false;
  if (hasChinese(s)) return false;
  return /[A-Za-zÀ-ÿ]/.test(s);
}

export function tokenize(text) {
  const s = String(text || '');
  const matches = s.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]+|\s+/gu);
  return matches || [];
}

/** Content tokens only (no punctuation/space), preserving order. */
export function wordTokens(text) {
  return tokenize(text).filter((t) => /[\p{L}\p{N}]/u.test(t));
}

const PT_CLITIC_SUFFIXES = ['-se', '-me', '-te', '-lhe', '-lhes', '-nos', '-vos', '-o', '-a', '-os', '-as', '-lo', '-la', '-los', '-las'];

const PT_IRREGULAR_FORMS = {
  sou: 'ser', é: 'ser', eh: 'ser', sao: 'ser', são: 'ser', era: 'ser', foi: 'ser', foi: 'ser', fui: 'ser',
  estou: 'estar', esta: 'estar', está: 'estar', estao: 'estar', estão: 'estar', estava: 'estar', estive: 'estar',
  tenho: 'ter', tem: 'ter', temos: 'ter', tinha: 'ter', tive: 'ter',
  vou: 'ir', vai: 'ir', vamos: 'ir', fui: 'ir', ia: 'ir',
  faco: 'fazer', faço: 'fazer', faz: 'fazer', fiz: 'fazer', fez: 'fazer',
  dou: 'dar', da: 'dar', dá: 'dar', dao: 'dar', dão: 'dar', dei: 'dar', deu: 'dar', dando: 'dar', dado: 'dar',
  fico: 'ficar', fica: 'ficar', fiquei: 'ficar', ficou: 'ficar', ficando: 'ficar', ficado: 'ficar',
  consigo: 'conseguir', consegue: 'conseguir', consegui: 'conseguir', conseguindo: 'conseguir',
  quero: 'querer', quer: 'querer', quis: 'querer', querendo: 'querer',
  posso: 'poder', pode: 'poder', podemos: 'poder', pude: 'poder', podia: 'poder',
  sei: 'saber', sabe: 'saber', sabemos: 'saber', soube: 'saber',
  vejo: 'ver', ve: 'ver', vê: 'ver', viu: 'ver', vi: 'ver', vendo: 'ver', visto: 'ver',
  venho: 'vir', vem: 'vir', veio: 'vir', vim: 'vir',
  digo: 'dizer', diz: 'dizer', disse: 'dizer', falou: 'falar', falo: 'falar',
  estou: 'estar'
};

/**
 * Very small lemma guesser for pt-BR. It is intentionally conservative:
 * when unsure it returns the token unchanged, so lookups fall back to the
 * exact form instead of showing a wrong headword.
 */
export function guessLemmaForm(token) {
  const raw = String(token || '').trim();
  if (!raw) return raw;
  const lower = raw.toLowerCase();
  const key = normalizeKey(lower);
  if (PT_IRREGULAR_FORMS[key]) return PT_IRREGULAR_FORMS[key];
  if (PT_IRREGULAR_FORMS[normalizeKey(raw)]) return PT_IRREGULAR_FORMS[normalizeKey(raw)];

  if (lower.endsWith('ando') && lower.length > 6) return lower.slice(0, -4) + 'ar';
  if (lower.endsWith('endo') && lower.length > 6) return lower.slice(0, -4) + 'er';
  if (lower.endsWith('indo') && lower.length > 6) return lower.slice(0, -4) + 'ir';
  if (lower.endsWith('ado') && lower.length > 5) return lower.slice(0, -3) + 'ar';
  if (lower.endsWith('ido') && lower.length > 5) return lower.slice(0, -3) + 'er';
  if (lower.endsWith('ava') && lower.length > 5) return lower.slice(0, -3) + 'ar';
  if (lower.endsWith('ia') && lower.length > 4) return lower.slice(0, -2) + 'er';

  for (const suffix of PT_CLITIC_SUFFIXES) {
    if (lower.endsWith(suffix) && lower.length > suffix.length + 3) {
      return guessLemmaForm(lower.slice(0, -suffix.length));
    }
  }
  return raw;
}

/** Levenshtein distance with early exit (fuzzy search + typo tolerance). */
export function levenshtein(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = new Array(t.length + 1);
  let curr = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j += 1) prev[j] = j;
  for (let i = 1; i <= s.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= t.length; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[t.length];
}

export function similarity(a, b) {
  const s = normalizeKey(a);
  const t = normalizeKey(b);
  const max = Math.max(s.length, t.length);
  if (!max) return 1;
  return 1 - levenshtein(s, t) / max;
}

/** Detect the entry type from the raw text. */
export function detectType(text) {
  const tokens = wordTokens(text);
  if (tokens.length === 0) return 'unknown';
  if (tokens.length === 1) return 'word';
  const endsLikeSentence = /[.!?。！？]$/.test(String(text).trim());
  if (tokens.length >= 6 || (endsLikeSentence && tokens.length >= 4)) return 'sentence';
  if (tokens.length >= 4) return 'expression';
  return 'phrase';
}

export function makeEntryId(normalizedWord, sourceId = 'core') {
  return `dict:${sourceId}:${normalizeKey(normalizedWord)}`;
}

export function makeFavoriteId(normalizedText) {
  return `fav:${normalizeKey(normalizedText)}`;
}

export function makeAudioCacheId({ text, voice, provider, locale = 'pt-BR' }) {
  return `audio:${locale}:${provider}:${voice}:${normalizeKey(text)}`;
}

export function slugify(input) {
  return normalizeKey(input).replace(/\s+/g, '-');
}
