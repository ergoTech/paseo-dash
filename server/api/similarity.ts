import { stem, tokenize } from "../search/text.ts";

/**
 * How alike two tasks read, for the ready review (server/api/ready-review.ts). Pure text matching:
 * what it finds is a signal for a person to compare, never proof that work was done.
 */

/** Words too common to tell two tasks apart (Ukrainian, Russian, English). */
const STOPWORDS = new Set(
  [
    "і", "й", "та", "або", "але", "що", "як", "не", "без", "для", "при", "про", "під", "над", "після", "перед", "між", "через", "щоб", "коли", "де", "це", "цей", "ці", "усі", "всі", "вже", "ще", "лише", "тільки",
    "у", "в", "на", "з", "із", "зі", "до", "по", "за", "від", "або", "бо", "чи",
    "и", "или", "что", "как", "для", "при", "про", "под", "над", "после", "перед", "без", "это",
    "the", "a", "an", "and", "or", "of", "to", "in", "for", "with", "on", "is", "are", "be", "by", "as", "at", "from", "not", "no", "it", "its", "that", "this", "when",
  ].map(stem),
);

/** The distinct meaningful stems of a text: no stopwords, no bare numbers, nothing under three characters. */
export function stems(text: string, skip: ReadonlySet<string> = new Set()): Set<string> {
  const out = new Set<string>();
  for (const token of tokenize(text)) {
    if (token.stem.length < 3 || /^\p{N}+$/u.test(token.stem) || STOPWORDS.has(token.stem) || skip.has(token.stem)) continue;
    out.add(token.stem);
  }
  return out;
}

export function shared(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  return [...a].filter((item) => b.has(item));
}

/**
 * How much two cards' whole texts share, 0 to 1 (a cosine over stems weighted by rarity): only to put
 * the likeliest related cards first, never a signal by itself. `texts`: every card of the project.
 */
export function textRanking(texts: ReadonlyMap<string, ReadonlySet<string>>): (a: string, b: string) => number {
  const counts = new Map<string, number>();
  for (const words of texts.values()) for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  const weight = (word: string) => Math.log(texts.size / (counts.get(word) ?? 1)) ** 2;
  const lengths = new Map<string, number>();
  const length = (id: string) => {
    let known = lengths.get(id);
    if (known === undefined) {
      known = Math.sqrt([...(texts.get(id) ?? [])].reduce((sum, word) => sum + weight(word), 0));
      lengths.set(id, known);
    }
    return known;
  };
  return (a, b) => {
    const mine = texts.get(a);
    const theirs = texts.get(b);
    const norm = length(a) * length(b);
    if (!mine || !theirs || !norm) return 0;
    return shared(mine, theirs).reduce((sum, word) => sum + weight(word), 0) / norm;
  };
}

/** A stem in more titles of one project than this says nothing about two of them. */
export function commonStems(titles: Set<string>[]): Set<string> {
  const counts = new Map<string, number>();
  for (const title of titles) for (const item of title) counts.set(item, (counts.get(item) ?? 0) + 1);
  const most = Math.max(COMMON_MIN, Math.ceil(titles.length * COMMON_SHARE));
  return new Set([...counts].filter(([, n]) => n > most).map(([item]) => item));
}
const COMMON_MIN = 5;
const COMMON_SHARE = 0.15;

/** Titles alike by themselves: at least two shared stems, half or more of the shorter title. */
export function alikeTitles(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  const both = shared(a, b).length;
  return both >= 2 && both / Math.min(a.size, b.size) >= 0.5;
}

const LINE_SHARED = 3;
const LINE_ALIKE = 0.6;

/**
 * How alike two acceptance lines are, 0 to 1: shared stems over all stems of both; 0 under the
 * threshold. Short generic lines ("tests pass") share too few words to ever match unless identical.
 * Runs for every open line against every ticked one of a project, so the cheap checks come first.
 */
export function alikeLines(a: { text: string; stems: ReadonlySet<string> }, b: { text: string; stems: ReadonlySet<string> }): number {
  const small = Math.min(a.stems.size, b.stems.size);
  const large = Math.max(a.stems.size, b.stems.size);
  // Under three stems nothing matches; a much shorter line cannot share enough of a longer one.
  if (small < LINE_SHARED || small < large * LINE_ALIKE) return 0;
  let both = 0;
  for (const word of a.stems) if (b.stems.has(word)) both += 1;
  if (both < LINE_SHARED) return 0;
  const score = both / (a.stems.size + b.stems.size - both);
  if (score < LINE_ALIKE) return 0;
  // The same words in another order are not the same line.
  return score === 1 && normalLine(a.text) !== normalLine(b.text) ? 0.99 : score;
}

/** A line as its words, for telling the same criterion on several cards. */
export function normalLine(text: string): string {
  return tokenize(text).map((t) => t.norm).join(" ");
}
