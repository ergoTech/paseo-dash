import { ITEM_TEXT_MAX } from "../../shared/laconote.ts";

/**
 * A Laconote meeting's summary as the import needs it: topics with their decisions, action items and
 * links. It is read from the API's meeting detail or from the Markdown export the web app downloads
 * (laconote site/src/lib/clientExport.ts); both carry other people's words, kept as data.
 */

export interface ActionItem {
  /** The item's text, whitespace collapsed. */
  task: string;
  /** As the summary gives them, possibly a "not specified" in the meeting's language; "" when absent. */
  owner: string;
  deadline: string;
  priority: string;
}

export interface Topic {
  title: string;
  decisions: string[];
  items: ActionItem[];
  /** Its artifacts' http(s) links. */
  links: string[];
}

export interface Meeting {
  /** The API's meeting id; "" for a paste. */
  id: string;
  title: string;
  /** As given: the API's timestamp cut to minutes, or the export's own date text. */
  date: string;
  /** Only topics with action items. */
  topics: Topic[];
}

export const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

const URL_PATTERN = /https?:\/\/[^\s<>()[\]"'`]+/gi;

export function httpLinks(text: string): string[] {
  return [...text.matchAll(URL_PATTERN)].map((m) => m[0].replace(/[.,;:!?]+$/, ""));
}

// ---------------------------------------------------------------- API

const asString = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** GET /api/v1/history/meetings/{id}: `meeting.data.topics` with decisions, action_items, artifacts. */
export function meetingFromApi(detail: unknown): Meeting {
  const meeting = asRecord(asRecord(detail).meeting);
  const id = asString(meeting.meeting_id);
  const when = asString(meeting.date) || asString(meeting.start_time);
  const topics: Topic[] = [];
  for (const raw of asArray(asRecord(meeting.data).topics)) {
    const topic = asRecord(raw);
    const items = asArray(topic.action_items)
      .map((a) => {
        const item = asRecord(a);
        return {
          task: oneLine(asString(item.task) || asString(item.title) || asString(item.description)).slice(0, ITEM_TEXT_MAX),
          owner: oneLine(asString(item.owner)),
          deadline: oneLine(asString(item.deadline)),
          priority: oneLine(asString(item.priority)),
        };
      })
      .filter((item) => item.task);
    if (items.length === 0) continue;
    const decisions = asArray(topic.decisions)
      .map((d) => {
        if (typeof d !== "object" || !d) return oneLine(asString(d));
        const rec = asRecord(d);
        const text = asString(rec.decision) || asString(rec.title);
        const why = asString(rec.justification);
        return oneLine(why ? `${text} (${why})` : text);
      })
      .filter(Boolean);
    const links = asArray(topic.artifacts).flatMap((art) => {
      const rec = asRecord(art);
      return httpLinks(typeof art === "string" ? art : `${asString(rec.value)} ${asString(rec.url)}`);
    });
    topics.push({ title: oneLine(asString(topic.title)) || "Topic", decisions, items, links: [...new Set(links)] });
  }
  return { id, title: oneLine(asString(meeting.meeting_name)) || id, date: when.slice(0, 16).replace("T", " "), topics };
}

// ---------------------------------------------------------------- Markdown export

/** Field labels of a topic, in the languages Laconote exports (core bot/localization schema.field.*). */
const FIELDS: Record<string, "decisions" | "items" | "artifacts"> = {
  "рішення": "decisions",
  decisions: "decisions",
  "завдання": "items",
  "action items": "items",
  artifacts: "artifacts",
  "артефакти": "artifacts",
};

/**
 * Labels of an action item's details (schema.field.owner, deadline, priority, status). The status is
 * known so it is not mistaken for part of the task, and is not kept.
 */
const ITEM_FIELDS: Record<string, "owner" | "deadline" | "priority" | "status"> = {
  "відповідальний": "owner",
  owner: "owner",
  "дедлайн": "deadline",
  deadline: "deadline",
  "пріоритет": "priority",
  priority: "priority",
  "статус": "status",
  status: "status",
};

/** Longest action item text kept; laconote.import accepts the chosen items up to this length. */
const ITEM_MAX = ITEM_TEXT_MAX;

const label = (text: string) => oneLine(text).toLowerCase();

/** Details "Label: value · Label: value", a " · " inside a value kept; undefined unless a known label leads. */
function parseDetails(text: string): { label: string; value: string }[] | undefined {
  const details: { label: string; value: string }[] = [];
  for (const part of text.split(" · ")) {
    const m = /^([^:—·]{1,40}):\s*(.*)$/.exec(part.trim());
    if (m && ITEM_FIELDS[label(m[1]!)]) details.push({ label: label(m[1]!), value: m[2]! });
    else if (details.length > 0) details[details.length - 1]!.value += ` · ${part}`;
    else return undefined;
  }
  return details;
}

/**
 * One exported action item: "<task> — Label: value · Label: value". The details follow the first
 * " — " whose remainder starts with a known label, so a dash inside the task's own text stays part
 * of it; unknown labels after it are taken as part of the value before them.
 */
function parseItem(line: string): ActionItem | undefined {
  const separator = " — ";
  let from = 0;
  for (;;) {
    const at = line.indexOf(separator, from);
    if (at < 0) break;
    const details = parseDetails(line.slice(at + separator.length));
    if (details) {
      const item: ActionItem = { task: oneLine(line.slice(0, at)).slice(0, ITEM_MAX), owner: "", deadline: "", priority: "" };
      for (const { label: name, value } of details) {
        const key = ITEM_FIELDS[name];
        if (key && key !== "status") item[key] = oneLine(value);
      }
      return item.task ? item : undefined;
    }
    from = at + 1;
  }
  const task = oneLine(line).slice(0, ITEM_MAX);
  return task ? { task, owner: "", deadline: "", priority: "" } : undefined;
}

/**
 * The Markdown export: "# <title>", "**Date:** …", topics as "### N. <title>" with "**<Field>:**"
 * blocks of "- " lines. Anything it does not know (details, summaries, other fields) is skipped.
 */
export function meetingFromExport(markdown: string): Meeting {
  const meeting: Meeting = { id: "", title: "", date: "", topics: [] };
  let topic: Topic | undefined;
  let field: "decisions" | "items" | "artifacts" | undefined;
  const close = () => {
    if (topic && topic.items.length > 0) meeting.topics.push({ ...topic, links: [...new Set(topic.links)] });
    topic = undefined;
    field = undefined;
  };
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^#\s+(.+)$/.exec(line))) {
      if (!meeting.title) meeting.title = oneLine(m[1]!);
      continue;
    }
    if ((m = /^\*\*(?:Date|Дата):\*\*\s*(.+)$/i.exec(line)) && !topic) {
      if (!meeting.date) meeting.date = oneLine(m[1]!);
      continue;
    }
    if ((m = /^###\s+\d+\.\s+(.+)$/.exec(line))) {
      close();
      topic = { title: oneLine(m[1]!), decisions: [], items: [], links: [] };
      continue;
    }
    if (/^#{1,3}\s/.test(line) || /^-{3,}$/.test(line)) {
      close();
      continue;
    }
    if (!topic) continue;
    if ((m = /^\*\*([^*]+?):\*\*\s*(.*)$/.exec(line))) {
      field = FIELDS[label(m[1]!)];
      continue;
    }
    const bullet = /^[-*]\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(line);
    if (!bullet || !field) continue;
    const text = bullet[1]!;
    if (field === "decisions") topic.decisions.push(oneLine(text));
    else if (field === "artifacts") topic.links.push(...httpLinks(text));
    else {
      const item = parseItem(text);
      if (item) topic.items.push(item);
    }
  }
  close();
  return meeting;
}
