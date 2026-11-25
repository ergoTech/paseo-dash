/**
 * The text side of search: words as search compares
 * them, their stems, typo distance, the other keyboard layout and the forms a task id is typed in.
 * Pure: no plan, no I/O.
 */

/** One word of a text: as compared (`norm`, `stem`) and where it stands in the text as written. */
export interface Token {
  norm: string;
  stem: string;
  start: number;
  end: number;
}

/** A run of letters and digits, with apostrophes inside it (пам'ять, don't) kept as one word. */
const WORD = /[\p{L}\p{N}]+(?:['’ʼ`][\p{L}\p{N}]+)*/gu;

/** Lowercase, apostrophes dropped, ё as е, accents of Latin letters dropped (é → e); й and ї stay. */
export function normalizeWord(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/['’ʼ`]/g, "")
    .replace(/ё/g, "е")
    .normalize("NFD")
    .replace(/(?<=[a-z])\p{M}+/gu, "")
    .normalize("NFC");
}

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(WORD)) {
    const norm = normalizeWord(match[0]);
    if (!norm) continue;
    tokens.push({ norm, stem: stem(norm), start: match.index, end: match.index + match[0].length });
  }
  return tokens;
}

/** The words of a query, each once, in the order typed. */
export function queryWords(text: string): string[] {
  return [...new Set(tokenize(text).map((t) => t.norm))];
}

// ---------------------------------------------------------------- stems

/**
 * Inflectional endings of Ukrainian and Russian, longest first. One is cut, and only when at least
 * three letters stay, so «логіну» and «логіном» share «логін», «задачі» and «задачу» share «задач».
 * Noun and adjective endings only: verb endings (-ти, -ть, -ла, -ет) end nouns too (оплати,
 * память, школа, бюджет); a verb's other forms still match by their beginning.
 */
const CYRILLIC_ENDINGS = [
  "ами", "ями", "ові", "еві", "єві", "ого", "ому", "ими", "іми", "ыми", "его", "ему", "ють",
  "ам", "ям", "ах", "ях", "ів", "їв", "ей", "ой", "ий", "ій", "ый", "ая", "яя", "ое", "ее", "ые", "ие", "их", "іх", "ых", "ую", "юю", "ом", "ем", "ою", "ею", "єю", "ов", "ев",
  "а", "я", "о", "е", "є", "и", "і", "ї", "у", "ю", "ь", "й", "ы",
]

const MIN_STEM = 3;

function cut(word: string, ending: string): string | undefined {
  return word.endsWith(ending) && word.length - ending.length >= MIN_STEM ? word.slice(0, -ending.length) : undefined;
}

/** A light English stem: plurals, -ing, -ed and a final e (logs, logging → log; cached, cache → cach). */
function stemEnglish(word: string): string {
  let out = cut(word, "ies") !== undefined ? `${word.slice(0, -3)}y` : word;
  if (out === word) {
    for (const ending of ["sses", "ing", "ed", "es", "s"]) {
      if (ending === "s" && /(ss|us|is)$/.test(word)) continue;
      const rest = cut(word, ending);
      if (rest === undefined) continue;
      out = ending === "sses" ? `${rest}ss` : rest;
      // logging → logg → log: a doubled last consonant left by -ing or -ed is one.
      if ((ending === "ing" || ending === "ed") && /([b-df-hj-np-tv-z])\1$/.test(out)) out = out.slice(0, -1);
      break;
    }
  }
  return cut(out, "e") ?? out;
}

export function stem(word: string): string {
  if (/[\p{N}]/u.test(word)) return word;
  if (/^[a-z]+$/.test(word)) return stemEnglish(word);
  if (/^[\p{Script=Cyrillic}]+$/u.test(word)) {
    for (const ending of CYRILLIC_ENDINGS) {
      const rest = cut(word, ending);
      if (rest !== undefined) return rest;
    }
  }
  return word;
}

// ---------------------------------------------------------------- typos

/** Edits a typo may take: none under four letters, one up to seven, two from eight. */
export function typoBudget(word: string): number {
  if (/[\p{N}]/u.test(word)) return 0;
  return word.length < 4 ? 0 : word.length < 8 ? 1 : 2;
}

/**
 * Optimal string alignment distance (insert, delete, change, swap of neighbours); anything over
 * `max` answers `max + 1`, so long words stop early.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let before: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      const change = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + change);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, before[j - 2]! + 1);
      current.push(value);
      best = Math.min(best, value);
    }
    if (best > max) return max + 1;
    before = previous;
    previous = current;
  }
  return Math.min(previous[b.length]!, max + 1);
}

// ---------------------------------------------------------------- keyboard layouts

const QWERTY = "`qwertyuiop[]asdfghjkl;'zxcvbnm,./";
const UKRAINIAN = "'йцукенгшщзхїфівапролджєячсмитьбю.";
const RUSSIAN = "ёйцукенгшщзхъфывапролджэячсмитьбю.";

function mapper(from: string, to: string): (text: string) => string {
  const map = new Map([...from].map((char, i) => [char, to[i]!]));
  return (text) => [...text.toLowerCase()].map((char) => map.get(char) ?? char).join("");
}

const LAYOUTS = [mapper(QWERTY, UKRAINIAN), mapper(QWERTY, RUSSIAN), mapper(UKRAINIAN, QWERTY), mapper(RUSSIAN, QWERTY)];

/**
 * The query as it reads typed on another layout: Latin letters as the Ukrainian and Russian keys
 * they share (kjusy → логін), Cyrillic as the English ones (дщпшт → login). Only the swaps that
 * change something and still have letters.
 */
export function otherLayouts(text: string): string[] {
  const lower = text.toLowerCase();
  const out = new Set<string>();
  for (const swap of LAYOUTS) {
    const swapped = swap(lower);
    if (swapped !== lower && /[\p{L}]/u.test(swapped)) out.add(swapped);
  }
  return [...out];
}

// ---------------------------------------------------------------- task ids

/** Cyrillic letters that look like the Latin ones of an id, as dictation or a mixed layout types them. */
const LOOK_ALIKE: Record<string, string> = { а: "A", в: "B", е: "E", к: "K", м: "M", н: "H", о: "O", р: "P", с: "C", т: "T", х: "X", і: "I", у: "Y" };

/** Crockford base32, the alphabet of an id's suffix (shared/model.ts ID_PATTERN). */
const SUFFIX = /^[0-9A-HJKMNP-TV-Z]{5}$/;

/** An id's suffix as Crockford reads it: O is 0, I and L are 1. */
function crockford(text: string): string {
  return text.replace(/O/g, "0").replace(/[IL]/g, "1");
}

export interface IdForms {
  /** `LAC-7K3QX`: a whole id whose prefix is a key of a connected space. */
  full?: string;
  /** `7K3QX`: the suffix alone, typed with a digit or in capitals. */
  suffix?: string;
  /**
   * The beginnings of an id the text may be, typed with a digit or in capitals: `LAC-7K` (a space
   * key, a dash or nothing, then one to four characters) or `7K3` (two to four characters of a
   * suffix, in any space). `AB3` with a space AB is both.
   */
  prefixes?: { key?: string; suffix: string }[];
}

/** One to four characters of the suffix alphabet: the beginning of a suffix. */
const SUFFIX_START = /^[0-9A-HJKMNP-TV-Z]{1,4}$/;

/**
 * The id a text names, however it was typed: any case, with or without the dash, with spaces, with
 * Cyrillic look-alikes. A whole id counts only with the prefix of a connected space, so «Add login»
 * is never read as an id; a suffix alone, or the beginning of an id, only with a digit or in
 * capitals, so a word is not one.
 */
export function idForms(text: string, spaceKeys: Iterable<string>): IdForms {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 24) return {};
  const latin = [...trimmed].map((char) => LOOK_ALIKE[char.toLowerCase()] ?? char).join("").toUpperCase();
  const packed = latin.replace(/[\s\-_.·]+/g, "");
  if (!/^[A-Z0-9]+$/.test(packed)) return {};
  const keys = new Set([...spaceKeys].map((k) => k.toUpperCase()));
  if (packed.length >= 7) {
    const prefix = packed.slice(0, -5);
    const suffix = crockford(packed.slice(-5));
    if (keys.has(prefix) && SUFFIX.test(suffix)) return { full: `${prefix}-${suffix}` };
  }
  const typedAsId = /\d/.test(trimmed) || trimmed === trimmed.toUpperCase();
  if (!typedAsId) return {};
  const out: IdForms = {};
  if (packed.length === 5 && SUFFIX.test(crockford(packed))) out.suffix = crockford(packed);
  // A beginning is typed in one piece: «lac fix» is two words, not LAC-F1X. After a space key it is
  // read as Crockford reads a suffix; alone only O reads as 0, so «LAC» stays a word, not 1AC.
  const piece = latin.replace(/-/, "");
  if (/[^A-Z0-9]/.test(piece)) return out;
  const start = (text: string) => text.replace(/O/g, "0");
  const prefixes: { key?: string; suffix: string }[] = [];
  for (const key of keys) {
    const rest = piece.startsWith(key) ? crockford(piece.slice(key.length)) : "";
    if (SUFFIX_START.test(rest)) prefixes.push({ key, suffix: rest });
  }
  if (piece.length >= 2 && SUFFIX_START.test(start(piece))) prefixes.push({ suffix: start(piece) });
  if (prefixes.length) out.prefixes = prefixes;
  return out;
}
