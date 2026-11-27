import { z } from "zod";

/**
 * The plan repository's entities as their front matter reads (docs/design/task-manager-v1/03-model.md).
 * Parsing is lenient about what people may leave out or empty (`null` reads as absent) and strict
 * about values the plugin acts on (statuses, priorities). Unknown keys are dropped here, but never
 * from the file: writes edit the original YAML document.
 */

export const TASK_STATUSES = ["inbox", "todo", "in_progress", "review", "done", "canceled"] as const;
export const PLAN_STATUSES = ["planned", "active", "done", "canceled"] as const;
export const PRIORITIES = ["urgent", "high", "medium", "low"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** `<KEY>-<5 Crockford base32>`, for example `LAC-7K3QX`. */
export const ID_PATTERN = /^[A-Z]{2,6}-[0-9A-HJKMNP-TV-Z]{5}$/;
export const SPACE_KEY_PATTERN = /^[A-Z]{2,6}$/;
/** Project keys the plugin writes: tasks reference them, so they never change once listed. */
export const PROJECT_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const LINE_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
/** A forge's web host name, optionally with a port: `gitlab.example.com`. */
export const WEB_HOST_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,62}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,62}[a-zA-Z0-9])?)*(?::\d{1,5})?$/;
/** Keys of `people` the plugin writes; a task's `assignee` holds one. */
export const PERSON_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
/** A label the plugin writes: letters or digits first, then also spaces and `- _ . / : + &`. */
export const LABEL_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} _\-./:+&]{0,39}$/u;

const text = z.string().nullish().transform((value) => (value === null || value === "" ? undefined : value));
const textList = z
  .array(z.string())
  .nullish()
  .transform((value) => value ?? []);
/**
 * A task's labels: a list, or a single value someone typed by hand (Obsidian, an editor). Nothing is
 * dropped except empties and repeats that differ only in case, so an undefined label still shows.
 */
const labelList = z
  .union([z.array(z.union([z.string(), z.number(), z.boolean()]).nullable()), z.string(), z.number(), z.boolean()])
  .nullish()
  .transform((value) => {
    const items = value === null || value === undefined ? [] : Array.isArray(value) ? value : [value];
    const out: string[] = [];
    for (const item of items) {
      const label = item === null ? "" : String(item).trim();
      if (label && !out.some((seen) => seen.toLowerCase() === label.toLowerCase())) out.push(label);
    }
    return out;
  });
/**
 * The short forms people write by hand for a map of entries: a list of keys (`labels: [bug, ui]`)
 * and a bare value for an entry (`bug: "#e5484d"`, `ergo: Ergo`). They read as the full form, so a
 * hand edit does not make the whole space.yaml unreadable; the plugin itself writes the full form.
 */
function shorthand(value: unknown, entry: (text: string) => Record<string, string>): unknown {
  if (Array.isArray(value)) {
    return Object.fromEntries(value.filter((item) => typeof item === "string" || typeof item === "number").map((item) => [String(item), null]));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, typeof item === "string" || typeof item === "number" ? entry(String(item)) : item]),
  );
}

/** Text or a list of texts, as people write either. */
const textOrList = z
  .union([z.array(z.string()), z.string()])
  .nullish()
  .transform((value) => (value === null || value === undefined ? [] : (Array.isArray(value) ? value : [value]).map((v) => v.trim()).filter(Boolean)));
const count = z.number().int().nonnegative().nullish().transform((value) => value ?? undefined);

/** YAML reads unquoted dates as text under the core schema, but numbers and dates may still come back as other scalars. */
const scalarText = z
  .union([z.string(), z.number(), z.date()])
  .nullish()
  .transform((value) => {
    if (value === null || value === undefined || value === "") return undefined;
    return value instanceof Date ? value.toISOString() : String(value);
  });

/**
 * What a task waits for besides other tasks (03-model.md, Requirements): a person's decision or
 * hands, an environment, a device, an access, a QA pass. Each says why and when it was last checked.
 * An entry of another kind reads as `owner`, so a typo never makes a task look ready for an agent.
 */
export const REQUIREMENT_KINDS = ["owner", "decision", "environment", "device", "access", "qa"] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

const requirementList = z
  .unknown()
  .optional()
  .transform((value) => {
    const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
    const out: { kind: RequirementKind; reason: string; checked?: string }[] = [];
    for (const item of items) {
      if (typeof item === "string" && item.trim()) {
        out.push({ kind: "owner", reason: item.trim() });
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const kind = (REQUIREMENT_KINDS as readonly string[]).includes(String(record.kind)) ? (record.kind as RequirementKind) : "owner";
      const reason = typeof record.reason === "string" ? record.reason.trim() : "";
      const checked = record.checked instanceof Date ? record.checked.toISOString() : typeof record.checked === "string" && record.checked.trim() ? record.checked.trim() : undefined;
      out.push({ kind, reason: reason || `a ${kind} requirement`, ...(checked ? { checked } : {}) });
    }
    return out;
  });
export type Requirement = z.output<typeof requirementList>[number];

/** QA's verdict on a task's acceptance, apart from its code being merged. */
export const QA_RESULTS = ["pending", "passed", "failed"] as const;

const flag = z
  .unknown()
  .optional()
  .transform((value) => (typeof value === "boolean" ? value : undefined));

/** Where an app's release stands in Google Play; recorded, never inferred from a merge or a build. */
export const PLAY_STATES = ["unpublished", "submitted", "published"] as const;

/** One build QA can install (an APK): its variant (phone, wear), environment and the commit it was built from. */
export interface Build {
  variant: string;
  environment: string;
  sha: string;
  url?: string;
  version?: string;
  at?: string;
}

/** The variant and environment of a build, or of a card, that names none. */
export const DEFAULT_VARIANT = "phone";
export const DEFAULT_ENVIRONMENT = "staging";

function buildList(value: unknown): Build[] {
  const out: Build[] = [];
  for (const item of Array.isArray(value) ? value : []) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const str = (key: string) => {
      const v = record[key];
      if (v instanceof Date) return v.toISOString();
      if (typeof v === "number") return String(v);
      return typeof v === "string" && v.trim() ? v.trim() : undefined;
    };
    const sha = str("sha");
    if (!sha) continue;
    const url = str("url");
    const version = str("version");
    const at = str("at");
    out.push({
      variant: str("variant")?.toLowerCase() ?? DEFAULT_VARIANT,
      environment: str("environment")?.toLowerCase() ?? DEFAULT_ENVIRONMENT,
      sha,
      ...(url ? { url } : {}),
      ...(version ? { version } : {}),
      ...(at ? { at } : {}),
    });
  }
  return out;
}

/**
 * The way from a merged PR/MR to accepted work (03-model.md, Delivery): the build on stage, the flags
 * and access it needs, the device QA tests on, the Trello card and QA's result. Facts a person or an
 * agent recorded, each read leniently: a value of the wrong type reads as absent.
 */
export const deliverySchema = z
  .unknown()
  .optional()
  .transform((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const str = (key: string) => {
      const v = record[key];
      if (v instanceof Date) return v.toISOString();
      if (typeof v === "number") return String(v);
      return typeof v === "string" && v.trim() ? v.trim() : undefined;
    };
    const list = (key: string) => {
      const v = record[key];
      const items = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
      return items.filter((item): item is string => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
    };
    const qa = str("qa");
    const out = {
      stage_sha: str("stage_sha"),
      stage_url: str("stage_url"),
      stage_version: str("stage_version"),
      stage_checked: str("stage_checked"),
      flags: list("flags"),
      flags_ready: flag.parse(record.flags_ready),
      access_ready: flag.parse(record.access_ready),
      device: str("device"),
      device_ready: flag.parse(record.device_ready),
      trello: str("trello"),
      trello_state: str("trello_state"),
      trello_checked: str("trello_checked"),
      qa: qa && (QA_RESULTS as readonly string[]).includes(qa) ? (qa as (typeof QA_RESULTS)[number]) : undefined,
      qa_note: str("qa_note"),
      qa_at: str("qa_at"),
      /** The builds QA needs (phone, wear) and their environment; with these or `builds`, an app's delivery. */
      variants: list("variants").map((v) => v.toLowerCase()),
      environment: str("environment")?.toLowerCase(),
      builds: buildList(record.builds),
      play: PLAY_STATES.find((state) => state === str("play")),
      play_at: str("play_at"),
    };
    return out;
  });
export type Delivery = NonNullable<z.output<typeof deliverySchema>>;

const common = {
  id: z.string().regex(ID_PATTERN),
  title: z.string().min(1),
  created: scalarText,
  updated: scalarText,
};

export const milestoneSchema = z.object({
  ...common,
  type: z.literal("milestone"),
  status: z.enum(PLAN_STATUSES).default("planned"),
  start: scalarText,
  due: scalarText,
  order: z.number().nullish().transform((value) => value ?? undefined),
});

export const featureSchema = z.object({
  ...common,
  type: z.literal("feature"),
  status: z.enum(PLAN_STATUSES).default("planned"),
  milestone: text,
  branch: text,
  projects: textList,
  spec: text,
  order: z.number().nullish().transform((value) => value ?? undefined),
});

/**
 * The record of a closure Paseo Dash made by itself under the owner's rule (server/reconcile): when,
 * on which machine, the merged PR/MRs it stood on and the facts in words. A card that carries one is
 * never closed by the rule again: reopened, it is the owner's.
 */
export const autoClosedSchema = z
  .unknown()
  .optional()
  .transform((value) => {
    if (value === undefined || value === null || value === "") return undefined;
    const record = typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    const str = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === "string" ? v : "");
    return {
      at: str(record.at),
      by: str(record.by),
      prs: Array.isArray(record.prs) ? record.prs.filter((pr): pr is string => typeof pr === "string") : [],
      note: str(record.note),
    };
  });
export type AutoClosed = NonNullable<z.output<typeof autoClosedSchema>>;

export const taskSchema = z.object({
  ...common,
  type: z.literal("task"),
  status: z.enum(TASK_STATUSES),
  project: text,
  feature: text,
  milestone: text,
  priority: z.enum(PRIORITIES).nullish().transform((value) => value ?? undefined),
  /**
   * The task's place among the tasks of its priority that wait to start, lower first (D21); set by
   * the dashboard's moves, absent until the first one. Anything but a finite number reads as absent.
   */
  rank: z
    .unknown()
    .optional()
    .transform((value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)),
  assignee: text,
  labels: labelList,
  depends_on: textList,
  branch: text,
  base: text,
  agent_profile: text,
  meeting: text,
  meeting_title: text,
  /** The forge issue the task stands for: its web URL (shared/issues.ts). Its state is not stored here. */
  issue: text,
  links: textList,
  duplicate_of: text,
  run_id: text,
  run_by: text,
  run_host: text,
  run_branch: text,
  run_started: scalarText,
  run_pr: text,
  run_ended: scalarText,
  /** When the live run last moved the task to review (lists put the longest waiting first). */
  run_review_at: scalarText,
  progress_done: count,
  progress_total: count,
  progress_note: text,
  progress_at: scalarText,
  /**
   * When a person took the finished task off the board (03-model.md, Archive). It counts only while the
   * task is done or canceled; a reopen clears it. The file, its run and its PR/MR stay as they are.
   */
  archived: scalarText,
  /** What the task waits for besides other tasks: a person, an environment, a device, an access, QA. */
  requires: requirementList,
  /** When a person last checked that the task can start as it is, and what they found. */
  readiness_checked: scalarText,
  readiness_note: text,
  /** From merged code to accepted work: stage build, flags, access, device, Trello card, QA. */
  delivery: deliverySchema,
  auto_closed: autoClosedSchema,
});

export const spaceSchema = z.object({
  schema: z.literal("paseo-dashboard/1"),
  key: z.string().regex(SPACE_KEY_PATTERN),
  name: z.string().min(1),
  projects: z
    .record(
      z.string(),
      z.object({
        remote: z.string().min(1),
        trunk: z.string().nullish().transform((v) => v ?? undefined),
        /** The line's color on the map, `#rrggbb`; anything else reads as absent (a default applies). */
        color: z
          .string()
          .nullish()
          .transform((v) => (v && LINE_COLOR_PATTERN.test(v) ? v.toLowerCase() : undefined)),
        /** An umbrella the project belongs to (one plan repository can hold several); lines group by it. */
        group: text,
        /**
         * The forge's web host when the remote's host is another one (`gitlab-ssh.example.com` →
         * `gitlab.example.com`); issue and PR/MR links are on the web host. Anything but a host name
         * reads as absent.
         */
        web_host: z
          .string()
          .nullish()
          .transform((v) => (v && WEB_HOST_PATTERN.test(v.trim()) ? v.trim().toLowerCase() : undefined)),
      }),
    )
    .nullish()
    .transform((value) => value ?? {}),
  /** People by key: for display and matching only (git emails, forge logins); grants nothing. */
  people: z
    .preprocess((value) => shorthand(value, (name) => ({ name })), z.record(
      z.string(),
      z
        .object({
          name: scalarText,
          emails: textOrList,
          github: scalarText,
          /** GitLab login per host, since there are several GitLab instances. */
          gitlab: z
            .record(z.string(), z.string())
            .nullish()
            .transform((v) => v ?? {}),
        })
        .nullish()
        .transform((v) => v ?? { name: undefined, emails: [], github: undefined, gitlab: {} }),
    ))
    .nullish()
    .transform((value) => value ?? {}),
  /** The label palette: name → color and description. Tasks may carry labels not listed here. */
  labels: z
    .preprocess((value) => shorthand(value, (color) => ({ color })), z.record(
      z.string(),
      z
        .object({
          /** `#rrggbb`; anything else reads as absent (a neutral color shows). */
          color: z
            .string()
            .nullish()
            .transform((v) => (v && LINE_COLOR_PATTERN.test(v) ? v.toLowerCase() : undefined)),
          description: text,
        })
        .nullish()
        .transform((v) => v ?? { color: undefined, description: undefined }),
    ))
    .nullish()
    .transform((value) => value ?? {}),
  defaults: z
    .object({
      priority: z.enum(PRIORITIES).nullish(),
      agent_profile: z.string().nullish(),
      /**
       * The agent mode for starts in the space when the profile names none (`auto`); used only where
       * the provider has it. A value that is not a short text reads as none rather than failing the space.
       */
      mode: z
        .unknown()
        .optional()
        .transform((v) => (typeof v === "string" && v.trim().length <= 100 ? v : undefined)),
      /**
       * Labels that mark a task as a person's work: nothing starts such a task on its own (Start next,
       * Start ready tasks, the autopilot, start_tasks); a start of that one task still can. A value
       * that is not a list of labels reads as none rather than failing the space.
       */
      human_labels: labelList.catch([]),
    })
    .nullish()
    .transform((value) => ({
      priority: value?.priority ?? undefined,
      agent_profile: value?.agent_profile || undefined,
      mode: value?.mode?.trim() || undefined,
      human_labels: value?.human_labels ?? [],
    })),
});

export type Milestone = z.output<typeof milestoneSchema>;
export type Feature = z.output<typeof featureSchema>;
export type Task = z.output<typeof taskSchema>;
export type Space = z.output<typeof spaceSchema>;
export type SpaceProject = Space["projects"][string];
export type Person = Space["people"][string];
export type LabelDef = Space["labels"][string];
export type Entity = Milestone | Feature | Task;
export type EntityType = Entity["type"];

export const ENTITY_DIRS: Record<EntityType, string> = {
  milestone: "milestones",
  feature: "features",
  task: "tasks",
};

/**
 * The id a reference points at: a bare id (`LAC-2HV9D`) or a wikilink to the file name
 * (`[[LAC-2HV9D-totp-2fa]]`, `[[LAC-2HV9D-totp-2fa|TOTP 2FA]]`).
 */
export function refId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const inner = value.trim().replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0]!.trim();
  const match = /^([A-Z]{2,6}-[0-9A-HJKMNP-TV-Z]{5})(?:-|$)/.exec(inner);
  return match?.[1];
}

/**
 * Status changes a live run makes by itself (03-model.md, the transition table): forward to review
 * once, back to in progress by a person on the run's machine, and to done by the run's own merge
 * once every acceptance line is ticked or its workspace is archived, which also ends the run.
 */
export const RUN_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  inbox: [],
  todo: [],
  in_progress: ["review", "done"],
  review: ["in_progress", "done"],
  done: [],
  canceled: [],
};

/** A live run: claimed and not ended (I4). */
export function hasLiveRun(task: Pick<Task, "run_id" | "run_ended">): boolean {
  return Boolean(task.run_id) && !task.run_ended;
}

/**
 * In progress with no live run (03-model.md, Statuses): a session outside the dashboard, a hub merging
 * the plan or a hand edit set the status, so no run will move it. Only a person does: done, back to
 * todo, canceled, or a start that claims it for a new run. (Review with no live run stays work up for
 * the owner's test, as before.)
 */
export function unheld(task: Pick<Task, "status" | "run_id" | "run_ended">): boolean {
  return task.status === "in_progress" && !hasLiveRun(task);
}

/** Whether a person may start the task: todo, or unheld (see above). A start claims it for a new run. */
export function startable(task: Pick<Task, "status" | "run_id" | "run_ended">): boolean {
  return (task.status === "todo" && !hasLiveRun(task)) || unheld(task);
}

/** Done or canceled: the statuses a task may be archived in (03-model.md, Archive). */
export function closed(task: Pick<Task, "status">): boolean {
  return task.status === "done" || task.status === "canceled";
}

/** Taken off the board: archived and still done or canceled. */
export function isArchived(task: Pick<Task, "status" | "archived">): boolean {
  return Boolean(task.archived) && closed(task);
}

/**
 * Why a task's project (its line on the map) can no longer change; empty while it can. Once a run
 * claimed it, its branch and PR/MR belong to that project's repository, released or not.
 */
export function lineLocked(task: Pick<Task, "id" | "title" | "project" | "run_id">): string {
  if (!task.run_id) return "";
  return `«${task.title}» (${task.id}) was started in ${task.project ?? "its project"}, and its branch belongs to that repository; its project cannot change. Create a task in the other project instead.`;
}
