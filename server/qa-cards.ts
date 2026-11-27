import { type QaCard, QA_CARDS_MAX, type Task, trelloShortLink } from "../shared/model.ts";

/**
 * A task's QA cards (03-model.md, QA cards): how a reading of a Trello card joins what is recorded,
 * and what the recorded cards say is left. Pure, and used both by the write and by the operation as
 * it applies, so the same rule holds when a journal is replayed on another machine's changes:
 *
 * - a reading older than the recorded one changes nothing;
 * - a read that could not be made keeps the last state read and says so beside it;
 * - a card is never removed, so a replaced one stays with its link to the replacement;
 * - a statement settles the run it was made in: a card seen open again after its archive keeps its
 *   earlier replacement as history only, and a proof is dropped when the open card was reopened or
 *   moved to another list, unless the same reading gives it again;
 * - an archived card is finished only by a stated replacement or a recorded proof of its run.
 */

/** One reading of a card: its state as read, or why it could not be read. */
export interface QaReading {
  url: string;
  checked: string;
  state?: QaCard["state"];
  unreadable?: string;
  /** For these: left out keeps what is recorded, "" or [] takes it off. */
  name?: string;
  list?: string;
  tester?: string;
  replaced_by?: string[];
  evidence?: string;
  proof?: string;
}

const key = (url: string) => trelloShortLink(url) ?? url;
const at = (time: string | undefined) => {
  const parsed = Date.parse(time ?? "");
  return Number.isNaN(parsed) ? -Infinity : parsed;
};

/** Whether a newer reading of the card is recorded than this one. */
export function isOlder(card: QaCard | undefined, reading: QaReading): boolean {
  if (!card) return false;
  const seen = at(reading.checked);
  // A failed read says nothing about the card: any read made after it, or an earlier failure, outranks it.
  return reading.state ? seen < at(card.checked) : seen < Math.max(at(card.checked), at(card.failed_at));
}

/** The card with the reading in it; the card as it was when the reading is older. */
export function mergeReading(card: QaCard | undefined, reading: QaReading): QaCard {
  const base: QaCard = card ?? { url: reading.url };
  if (isOlder(card, reading)) return base;
  if (!reading.state) return ordered({ ...base, failed_at: reading.checked, failure: reading.unreadable || "not read" });
  const kept = <K extends "name" | "list" | "tester" | "proof">(field: K) => (reading[field] === undefined ? base[field] : reading[field] || undefined);
  const reopened = reading.state === "open" && base.state === "archived";
  const moved = reading.state === "open" && Boolean(reading.list && base.list && reading.list !== base.list);
  const before = reopened ? undefined : base.replaced_by;
  const replaced = reading.replaced_by ?? before;
  // Evidence belongs to the replacement it was given for, never to another one.
  const evidence = reading.evidence || (!reopened && sameCards(replaced, before) ? base.evidence : undefined);
  const history = union(base.was_replaced_by, reopened ? base.replaced_by : undefined);
  const failedLater = at(base.failed_at) > at(reading.checked);
  return ordered({
    url: base.url,
    state: reading.state,
    checked: reading.checked,
    name: kept("name"),
    list: kept("list"),
    tester: kept("tester"),
    replaced_by: replaced?.length ? replaced : undefined,
    evidence: replaced?.length ? evidence : undefined,
    was_replaced_by: history.length ? history : undefined,
    proof: (reopened || moved) && reading.proof === undefined ? undefined : kept("proof"),
    failed_at: failedLater ? base.failed_at : undefined,
    failure: failedLater ? base.failure : undefined,
  });
}

/** The cards of both lists, each once. */
function union(a: string[] | undefined, b: string[] | undefined): string[] {
  const out = [...(a ?? [])];
  for (const url of b ?? []) if (!out.some((own) => key(own) === key(url))) out.push(url);
  return out;
}

/**
 * What an older reading states that the recorded card does not have: a replacement or a proof. A
 * journaled reading that reaches the plan after a newer one must not lose them without a word.
 */
export function lostStatement(card: QaCard | undefined, reading: QaReading): string {
  if (!isOlder(card, reading)) return "";
  const known = union(card!.replaced_by, card!.was_replaced_by).map(key);
  if (reading.replaced_by?.some((to) => !known.includes(key(to)))) return "replacement";
  return reading.proof && reading.proof !== card!.proof ? "proof" : "";
}

/** The readings as they are recorded: a repeated replacement carries the evidence it already has. */
export function withKnownEvidence(cards: QaCard[], readings: QaReading[]): QaReading[] {
  return readings.map((reading) => {
    const card = cards.find((own) => key(own.url) === key(reading.url));
    const known = reading.replaced_by?.length && !reading.evidence && card?.evidence && sameCards(reading.replaced_by, card.replaced_by);
    return known ? { ...reading, evidence: card!.evidence } : reading;
  });
}

const sameCards = (a: string[] | undefined, b: string[] | undefined) =>
  JSON.stringify((a ?? []).map(key).sort()) === JSON.stringify((b ?? []).map(key).sort());

const FIELDS = ["url", "state", "checked", "name", "list", "tester", "replaced_by", "evidence", "was_replaced_by", "proof", "failed_at", "failure"] as const;

/** The card's fields in one order, nothing empty: the plan file reads the same whatever wrote it. */
function ordered(card: QaCard): QaCard {
  return Object.fromEntries(FIELDS.filter((field) => card[field] !== undefined).map((field) => [field, card[field]])) as unknown as QaCard;
}

/** The recorded cards with the readings in them, in the order they were first recorded. */
export function mergeReadings(cards: QaCard[], readings: QaReading[]): QaCard[] {
  const out = [...cards];
  for (const reading of readings) {
    const index = out.findIndex((card) => key(card.url) === key(reading.url));
    if (index === -1) out.push(mergeReading(undefined, reading));
    else out[index] = mergeReading(out[index], reading);
  }
  return out;
}

/** How far ahead of this machine's clock a reading's time may be. */
const CLOCK_SKEW_MS = 5 * 60_000;

/**
 * Why these readings are refused for the task; "" when they are all good. Only cards explicitly tied
 * to the task are taken: the one `delivery` or a link names, one already recorded, and one stated as
 * the replacement of such a card. Nothing is matched by a title or a task id on a card.
 */
export function readingsRefusal(task: Pick<Task, "qa_cards" | "links" | "delivery">, readings: QaReading[], now: Date, linked: string[] = []): string {
  const cards = task.qa_cards ?? [];
  const seen = new Set<string>();
  for (const reading of readings) {
    const short = trelloShortLink(reading.url);
    if (!short) return `${reading.url} is not a Trello card URL`;
    if (seen.has(short)) return `card ${short} is given twice`;
    seen.add(short);
    const time = Date.parse(reading.checked);
    if (Number.isNaN(time)) return `card ${short}: checked is not a time`;
    if (time > now.getTime() + CLOCK_SKEW_MS) return `card ${short}: checked ${reading.checked} is in the future; give the time the card was read`;
    if (Boolean(reading.state) === Boolean(reading.unreadable)) return `card ${short}: give either its state (open, archived) or unreadable with why`;
    if (!reading.state && (reading.replaced_by !== undefined || reading.proof !== undefined)) return `card ${short}: replaced_by and proof go with a state that was read`;
    for (const to of reading.replaced_by ?? []) {
      const target = trelloShortLink(to);
      if (!target) return `card ${short}: replaced_by ${to} is not a Trello card URL`;
      if (target === short) return `card ${short} cannot replace itself`;
    }
    const recorded = cards.find((card) => key(card.url) === short);
    const known = recorded?.evidence && sameCards(reading.replaced_by, recorded.replaced_by);
    if (reading.replaced_by?.length && !reading.evidence?.trim() && !known) {
      return `card ${short}: replaced_by needs evidence, where the replacement is stated (a card comment, the owner's word)`;
    }
    if (isOlder(recorded, reading)) {
      const newer = at(recorded!.checked) >= at(recorded!.failed_at) ? recorded!.checked : recorded!.failed_at;
      return `card ${short} has a newer reading, or a newer failed one, of ${newer}; this one of ${reading.checked} is older and changes nothing`;
    }
  }
  const bound = new Set(
    [...linked, task.delivery?.trello ?? "", ...(task.links ?? []), ...cards.flatMap((card) => [card.url, ...(card.replaced_by ?? []), ...(card.was_replaced_by ?? [])])]
      .map((url) => trelloShortLink(url))
      .filter((short): short is string => Boolean(short)),
  );
  for (let grew = true; grew; ) {
    grew = false;
    for (const reading of readings) {
      if (!bound.has(key(reading.url))) continue;
      for (const to of reading.replaced_by ?? []) {
        if (!bound.has(key(to))) {
          bound.add(key(to));
          grew = true;
        }
      }
    }
  }
  const stray = readings.find((reading) => !bound.has(key(reading.url)));
  if (stray) return `card ${key(stray.url)} is not tied to this task: name it in delivery trello, link it on the task, or give it as replaced_by of a card that is`;
  if (mergeReadings(cards, readings).length > QA_CARDS_MAX) return `a task keeps at most ${QA_CARDS_MAX} QA cards`;
  return "";
}

/**
 * What one card says is left:
 * - `proven`: the proof of its run is recorded;
 * - `replaced`: archived, and the cards that replace it carry the QA;
 * - `unclear`: archived, with no replacement that leads anywhere and no proof;
 * - `open`: on the board, its run not proven;
 * - `unread`: named or tried, its state never read.
 */
export type QaRunStatus = "proven" | "replaced" | "unclear" | "open" | "unread";

export interface QaRun {
  card: QaCard;
  status: QaRunStatus;
}

/**
 * The task's QA cards with what each says is left, the replacements named but never read among them.
 * A task with none recorded has none here: its delivery stays what was recorded by hand.
 */
export function qaRuns(cards: QaCard[]): QaRun[] {
  const all = new Map(cards.map((card) => [key(card.url), card]));
  for (const card of cards) {
    for (const to of [...(card.replaced_by ?? []), ...(card.was_replaced_by ?? [])]) if (!all.has(key(to))) all.set(key(to), { url: to });
  }
  // A chain of replacements has to end at a card that is not itself archived and replaced: a loop leads
  // nowhere. Found by growing the set of cards that lead there, which stays quick however they name each other.
  const waiting = [...all.values()].filter((card) => !card.proof && card.state === "archived" && card.replaced_by?.length);
  const leads = new Set([...all.keys()].filter((short) => !waiting.some((card) => key(card.url) === short)));
  for (let grew = true; grew; ) {
    grew = false;
    for (const card of waiting) {
      if (!leads.has(key(card.url)) && card.replaced_by!.some((to) => leads.has(key(to)))) {
        leads.add(key(card.url));
        grew = true;
      }
    }
  }
  return [...all.values()].map((card) => {
    const status: QaRunStatus = card.proof
      ? "proven"
      : card.state === "archived"
        ? card.replaced_by?.length && leads.has(key(card.url))
          ? "replaced"
          : "unclear"
        : card.state === "open" && card.checked
          ? "open"
          : "unread";
    return { card, status };
  });
}

/** The runs someone still has to look at: open, never read, or archived with nothing saying where its QA went. */
export const pendingRuns = (cards: QaCard[] | undefined): QaRun[] => qaRuns(cards ?? []).filter((run) => run.status === "open" || run.status === "unread" || run.status === "unclear");

/** A card as people name it: the `#024` its title starts with, else its short link. */
export function cardLabel(card: Pick<QaCard, "url" | "name">): string {
  return /^#\d+/.exec(card.name ?? "")?.[0] ?? key(card.url);
}

/** A recorded time to the minute, in UTC as recorded: "2026-01-02 14:03Z". */
export function readAt(time: string): string {
  const parsed = Date.parse(time);
  return Number.isNaN(parsed) ? time : `${new Date(parsed).toISOString().slice(0, 16).replace("T", " ")}Z`;
}

/**
 * What Needs you says of a task's QA cards: a card archived with nothing replacing it, whatever the
 * task's status, or a done task whose QA is not settled and would otherwise be out of view. A
 * canceled task asks nothing. Undefined when nothing is left to look at.
 */
export function qaNeed(task: Pick<Task, "status" | "qa_cards">): { why: string; next: string; cards: QaRun[] } | undefined {
  if (task.status === "canceled") return undefined;
  const pending = pendingRuns(task.qa_cards);
  const unclear = pending.filter((run) => run.status === "unclear");
  const shown = unclear.length ? unclear : task.status === "done" ? pending : [];
  if (!shown.length) return undefined;
  const names = shown.map((run) => `${cardLabel(run.card)} ${run.status === "unclear" ? "archived, no known replacement" : run.status === "unread" ? "not read" : `open when read ${readAt(run.card.checked!)}`}`);
  return {
    why: `${task.status === "done" ? "done, QA not settled: " : ""}Trello ${names.join("; ")}`,
    next: unclear.length
      ? "say which card replaced it, with evidence, or where its run is proven (update_task delivery trello_cards)"
      : "get the acceptance run done and record its result and proof (update_task delivery)",
    cards: shown,
  };
}
