import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { GLYPHS } from "./map.ts";
import { ISSUE_URL_MAX } from "./issues.ts";
import { PRIORITIES, REQUIREMENT_KINDS } from "./model.ts";

/**
 * The plan's reads and writes, for the dashboard UI and for God Mode
 * (docs/design/task-manager-v1/06-god-mode.md). Every answer has an `error` text, empty when fine;
 * every action also answers `ok`. Arguments that name a thing take its id or the words of its title.
 */

/**
 * A thing named by its id or the words of its title. Most go without a description: God Mode shows
 * ChatGPT every argument of every operation with each read, and a name says what it takes.
 */
const name = (what?: string) => (what ? z.string().trim().min(1).describe(what) : z.string().trim().min(1));
const optionalName = (what?: string) => (what ? z.string().trim().min(1).optional().describe(what) : z.string().trim().min(1).optional());
const space = optionalName();
const createSpace = optionalName();
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "a real calendar date");
const priority = z.enum(PRIORITIES);
const label = z.string().trim().min(1).max(40);
const labels = (what?: string) => {
  const list = z.array(label).max(10).optional();
  return what ? list.describe(what) : list;
};
const labelFilter = optionalName();
const mine = z
  .boolean()
  .optional()
  ;
const issue = (what?: string) => {
  const url = z.string().trim().max(ISSUE_URL_MAX).optional();
  return what ? url.describe(what) : url;
};
const limit = (fallback: number) => z.number().int().min(1).max(50).default(fallback);

// ---------------------------------------------------------------- reads

export const TASK_FILTERS = ["open", "inbox", "todo", "in_progress", "review", "done", "canceled", "all"] as const;

export const tasksListInput = z.object({
  space,
  project: optionalName(),
  feature: optionalName(),
  milestone: optionalName(),
  status: z
    .enum(TASK_FILTERS)
    .optional()
    .describe("Default open (not done or canceled)"),
  assignee: optionalName(),
  label: labelFilter,
  mine,
  query: optionalName("Words or an id, best first; a PR/MR link or a branch; any status"),
  limit: limit(20),
  offset: z.number().int().min(0).max(10000).optional(),
});

/** The fields of a `tasks.list` row that are left out when empty: "", false or no labels. */
export const TASK_ROW_OPTIONAL = ["release", "activity", "needs", "next", "project", "assignee", "labels", "blocked", "blocked_by", "matched_in", "quote"] as const;

/**
 * One task as every task list shows it: tasks.list and the board (shared/board.ts). A row leaves out
 * what is empty (TASK_ROW_OPTIONAL): ChatGPT reads every row of every list, and most rows have no
 * assignee, blocker, match or need.
 */
export const taskRow = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  /** Where it is listed: running, review, ready, blocked, draft, done or canceled (TASK_SECTIONS). */
  section: z.string(),
  /** Its mark, as the map draws it (an agent of this Mac waiting for the person: needs_you). */
  glyph: z.enum(GLYPHS),
  /** Its own priority, else the space's default, else medium: what the order ranks it by. */
  priority: z.string(),
  /** The release it belongs to (its own, else its feature's) by title. */
  release: z.string().optional(),
  activity: z.string().optional(),
  /** What waits for the user on it, as overview's needs_you kind (server/needs.ts). */
  needs: z.string().optional(),
  /** With needs: what the user can do now, as needs_you says it. */
  next: z.string().optional(),
  project: z.string().optional(),
  assignee: z.string().optional(),
  labels: z.array(z.string()).optional(),
  /** Only when it waits for another task. */
  blocked: z.literal(true).optional(),
  /** What it waits for, as tasks.get says it: "LAC-5RT2M «TOTP contract» (in_progress)". */
  blocked_by: z.string().optional(),
  /**
   * With a query: the field the match is in (id, title, labels, project, feature, release, assignee, brief, acceptance,
   * notes, progress_note, pr, links, issue, branch; server/search/core.ts).
   */
  matched_in: z.string().optional(),
  /** With a query: a short piece of that field around the match. */
  quote: z.string().optional(),
});

/** What else a query names: features, releases and projects by their names (server/search/core.ts namedThings). */
export const namedThing = z.object({
  kind: z.enum(["feature", "release", "project"]),
  id: z.string(),
  title: z.string(),
  /** A project's space key (a feature's or release's is the prefix of its id). */
  space: z.string().optional(),
});

/**
 * Search facts a list adds when it has them: only some words matched, or the other keyboard layout
 * did. They come before the rows: God Mode speaks a reply's fields in order and cuts the end.
 */
const searchFacts = {
  /** No task has every word: these have some of them. */
  partial: z.literal(true).optional(),
  /** The query as typed on the other keyboard layout, when that is what found these. */
  searched_for: z.string().optional(),
};

export const tasksListRpc = defineRpc({
  name: "tasks.list",
  input: tasksListInput,
  output: z.object({
    /** With a query, on the first page: features, releases and projects whose names it matches. */
    also: z.array(namedThing).optional(),
    ...searchFacts,
    tasks: z.array(taskRow),
    total: z.number().int(),
    shown: z.number().int(),
    error: z.string(),
  }),
});

export const taskRef = z.object({ task: name() });

export const tasksGetRpc = defineRpc({
  name: "tasks.get",
  input: taskRef,
  output: z.object({
    id: z.string(),
    title: z.string(),
    /** When the name was no id or title: where search found the task, "notes: «…»". Early: God Mode cuts a long reply's end. */
    found_by: z.string().optional(),
    /**
     * While its run here changes files another task's run here also changes (a merge conflict in the
     * making): "ERG-X: a.ts, b.ts; ERG-Y: c.ts". Paths come from the agents. Absent otherwise.
     */
    shares_files_with: z.string().optional(),
    status: z.string(),
    activity: z.string(),
    /** What waits for the user on it, as overview's needs_you kind (server/needs.ts); "" when nothing. */
    needs: z.string(),
    /** With needs: what the user can do now, as needs_you says it; else "". */
    next: z.string(),
    /** With a live run: what it waits on (overview.running's state) and the fact; left out without one. */
    state: z.string().optional(),
    progress: z.string(),
    blocked_by: z.string(),
    pr: z.string(),
    chat_id: z.string(),
    project: z.string(),
    feature: z.string(),
    milestone: z.string(),
    priority: z.string(),
    assignee: z.string(),
    labels: z.array(z.string()),
    /** The forge issue the task stands for (its web URL), or empty. */
    issue: z.string(),
    /** What this machine last read of it: open, closed, closed by <PR/MR>, unknown; empty without an issue. */
    issue_state: z.string(),
    /** The agent profile the task names (its model and effort), or empty: the policy and the defaults decide. */
    agent_profile: z.string(),
    branch: z.string(),
    held_by: z.string(),
    host: z.string(),
    since: z.string(),
    acceptance: z.array(z.object({ text: z.string(), done: z.boolean() })),
    last_message: z.string(),
    brief: z.string(),
    /** Only when `brief` is cut: its full length; task_text reads it whole. */
    brief_chars: z.number().int().optional(),
    /** Only with a way to accepted work to show: "<stage>; next <who>: <what>" (delivery reads it all). */
    delivery: z.string().optional(),
    /** The latest handoff a run's agent left for the next one, or empty. */
    handoff: z.string(),
    /**
     * The task's latest runs as the plan's history has them, newest first, the live one included.
     * `result`: what became of the run; `chat_id` and `last_message` only when its agent is on this Mac.
     */
    runs: z.array(
      z.object({
        run_id: z.string(),
        by: z.string(),
        host: z.string(),
        branch: z.string(),
        started: z.string(),
        ended: z.string(),
        result: z.string(),
        pr: z.string(),
        progress: z.string(),
        handoff: z.string(),
        chat_id: z.string(),
        last_message: z.string(),
      }),
    ),
    /** Why the run history could not be read; empty when it was. */
    runs_error: z.string(),
    error: z.string(),
  }),
});

export const roadmapInput = z.object({
  space,
  milestone: optionalName(),
});

export const roadmapRpc = defineRpc({
  name: "roadmap.get",
  input: roadmapInput,
  output: z.object({
    milestones: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        status: z.string(),
        due: z.string(),
        days_left: z.number().int().nullable(),
        done: z.number().int(),
        total: z.number().int(),
        blocked: z.number().int(),
        features: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            status: z.string(),
            done: z.number().int(),
            total: z.number().int(),
            projects: z.string(),
          }),
        ),
      }),
    ),
    later: z.array(z.object({ id: z.string(), title: z.string(), done: z.number().int(), total: z.number().int() })),
    error: z.string(),
  }),
});

export const inboxListInput = z.object({
  space,
  label: labelFilter,
  mine,
  query: optionalName(),
  limit: limit(20),
  offset: z.number().int().min(0).max(10000).optional(),
});

export const inboxListRpc = defineRpc({
  name: "inbox.list",
  input: inboxListInput,
  output: z.object({
    ...searchFacts,
    items: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        project: z.string(),
        meeting_title: z.string(),
        created: z.string(),
        assignee: z.string(),
        labels: z.array(z.string()),
      }),
    ),
    total: z.number().int(),
    error: z.string(),
  }),
});

export const startCheckInput = taskRef.extend({
  profile: optionalName("Agent profile; empty: the default"),
});

export const startCheckRpc = defineRpc({
  name: "tasks.start-check",
  input: startCheckInput,
  output: z.object({
    title: z.string(),
    project: z.string(),
    branch: z.string(),
    workspace: z.string(),
    profile: z.string(),
    /** The permission mode the agent starts in and its effort, each with where it comes from: "Auto mode (auto, this Mac's default); effort High (high, this Mac's default)". */
    mode: z.string(),
    instructions: z.string(),
    /**
     * Whether the task's forge issue closes when its PR/MR merges, and why not; first `human`, when
     * there is one, so the read-back says it. Empty without either.
     */
    issue: z.string(),
    /**
     * That it waits for a person: a label marks it as a person's work (defaults.human_labels), its work
     * is merged already (reconcile), or a requirement is open; empty otherwise.
     */
    human: z.string(),
    error: z.string(),
    /** One of START_DECISIONS: what a start of this task does now, as start_plan says it. */
    decision: z.string(),
    /** What the user or ChatGPT does next about it; "" when it can start (an unheld task: why a start claims it again). */
    next: z.string(),
    /** The tasks it waits for that are not done: "LAC-5RT2M «TOTP contract» (in_progress)"; "" when none. */
    waits_for: z.string(),
    /** Whether a start from ChatGPT is read back first on this Mac (the launch permission), apart from `mode`. */
    asks_first: z.boolean(),
  }),
});

/**
 * What starting a task from ChatGPT does now (06-god-mode.md, Starting a set of tasks):
 * - can_start: it starts at once;
 * - after_prerequisites: it waits for tasks that are in the same set or already under way, and starts
 *   on this Mac once they are done, if the user confirmed the set;
 * - blocked: it waits for something nothing in the set will finish (a task not started, a draft, a
 *   missing task, a circle);
 * - needs_owner: it waits for the user: a draft to accept, work in review to test and accept, an
 *   agent's question or failure;
 * - already_started: a run holds it (launching or working), nothing to start;
 * - finished: done or canceled;
 * - refused: a start would be refused for another reason (error, reason say it).
 */
export const START_DECISIONS = ["can_start", "after_prerequisites", "blocked", "needs_owner", "already_started", "finished", "refused"] as const;
export type StartDecision = (typeof START_DECISIONS)[number];

/** The most tasks one start_plan or start_tasks takes: the read-back says each of them in 200 characters a line. */
export const START_SET_MAX = 8;

export const startPlanInput = z.object({
  tasks: z
    .array(z.string().trim().min(1).max(200))
    .min(1)
    .max(START_SET_MAX)
    .describe(`Up to ${START_SET_MAX} the user named`),
});

const startPlanTask = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  decision: z.enum(START_DECISIONS),
  /** Starting order within the set: 1 starts first; tasks with the same order may run at the same time. 0: not started from this set. */
  order: z.number().int(),
  /** Why, in one line. */
  reason: z.string(),
  /** What the user or ChatGPT does next about it; "" when it starts. */
  next: z.string(),
  /** The tasks it waits for that are not done; in_set: part of this set. */
  waits_for: z.array(z.object({ id: z.string(), title: z.string(), status: z.string(), in_set: z.boolean() })),
  /** With a live run: what its agent does (launching, working, waiting, failed, stopped); else "". */
  activity: z.string(),
  /** With needs_owner: what waits for the user (draft, review, or a needs_you kind); else "". */
  needs: z.string(),
  /** The agent a start would create and its permission mode; "" when it does not start. */
  profile: z.string(),
  mode: z.string(),
  instructions: z.string(),
});

export const startPlanRpc = defineRpc({
  name: "tasks.start-plan",
  input: startPlanInput.extend({
    /** Fixed by start_tasks' read-back: a set of which nothing would start is refused before any read-back. */
    for_start: z.boolean().optional(),
  }),
  output: z.object({
    /** How ChatGPT starts tasks for the user: what counts as permission, what waits for the owner, the order. */
    rules: z.string(),
    /** Whether a start from ChatGPT is read back first on this Mac. */
    asks_first: z.boolean(),
    /** The launch permission as a sentence, apart from the agents' permission mode. */
    permission: z.string(),
    /** The read-back of start_tasks, each at most 200 characters: what starts now, what after its prerequisites, what not. */
    start_now: z.string(),
    after: z.string(),
    not_started: z.string(),
    /** The agents' profiles and permission modes, as the starts would create them. */
    agents: z.string(),
    /** Whether the instructions of what starts changed since the user last saw them. */
    instructions: z.string(),
    tasks: z.array(startPlanTask),
    error: z.string(),
  }),
});

export const releaseCheckRpc = defineRpc({
  name: "tasks.release-check",
  input: taskRef,
  output: z.object({ title: z.string(), held_by: z.string(), host: z.string(), since: z.string(), error: z.string() }),
});

/**
 * What accepting a task's work in review stands on, for God Mode's read-back of `accept_task`: who
 * holds it, as `tasks.release-check` says it, its PR/MR's checks and review as the forge has them
 * now, and what becomes of its agent. `error` when the task is not in review.
 */
export const acceptCheckRpc = defineRpc({
  name: "tasks.accept-check",
  input: taskRef,
  output: z.object({
    title: z.string(),
    held_by: z.string(),
    host: z.string(),
    since: z.string(),
    /** "PR #7 open, checks failing (lint), review approved", "no PR/MR", or why the forge could not be read. */
    result: z.string(),
    /** "its agent on this Mac is stopped; its chat stays", "its agent on anna-mbp keeps running; …". */
    agent: z.string(),
    error: z.string(),
  }),
});

/** Names of failed checks a `tasks.result` answer lists; the rest are counted in `failed`. */
export const RESULT_FAILING = 5;

/**
 * A task's PR/MR as its forge has it now, for God Mode: the task screen's `ui.task-result` without
 * the changed files, flat for reading out. Read from `gh` / `glab` on each call, never written.
 */
export const tasksResultRpc = defineRpc({
  name: "tasks.result",
  input: taskRef,
  output: z.object({
    id: z.string(),
    title: z.string(),
    /** "#12", "!412"; empty when the task's run has no PR/MR, or the forge could not be asked. */
    pr: z.string(),
    /** open, draft, merged or closed; empty when not read. */
    state: z.string(),
    /** passing, failing, pending, waiting (a GitLab pipeline on a manual job or a schedule) or none; empty when not read. */
    checks: z.string(),
    /** Names of the failed checks, at most RESULT_FAILING. */
    failing: z.array(z.string()),
    /** approved, changes requested, review required, or empty when the forge does not say. */
    review: z.string(),
    passed: z.number().int(),
    failed: z.number().int(),
    pending: z.number().int(),
    /** The PR/MR's page; also set when it could not be read. */
    url: z.string(),
    /** Where the checks are listed: the PR's checks tab on GitHub, the pipeline on GitLab. */
    checks_url: z.string(),
    pr_title: z.string(),
    read_at: z.string(),
    error: z.string(),
  }),
});

// ---------------------------------------------------------------- actions

export const inboxAddInput = z.object({
  space: createSpace,
  items: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        note: z.string().max(2000).optional(),
        project: z.string().trim().min(1).optional(),
        labels: labels(),
        issue: issue(),
      }),
    )
    .min(1)
    .max(20)
    .describe("Drafts: title, note, project, labels, issue URL"),
  source_url: z
    .string()
    .regex(/^https?:\/\/[^\s]+$/i, "an http(s) URL")
    .max(2000)
    .optional(),
  source_title: z.string().trim().min(1).max(200).optional(),
});

export const inboxAddRpc = defineRpc({
  name: "inbox.add",
  input: inboxAddInput,
  output: z.object({
    ok: z.boolean(),
    created: z.array(z.object({ id: z.string(), title: z.string() })),
    skipped: z.array(z.string()),
    error: z.string(),
  }),
});

const taskOutput = z.object({ ok: z.boolean(), id: z.string(), title: z.string(), status: z.string(), error: z.string() });

export const tasksCreateInput = z.object({
  space: createSpace,
  title: z.string().trim().min(1).max(200),
  brief: z.string().max(20000).optional().describe("The agent's first prompt"),
  project: optionalName("Needed for todo"),
  feature: optionalName(),
  milestone: optionalName(),
  priority: priority.optional(),
  labels: labels(),
  depends_on: z.array(z.string().trim().min(1)).max(20).optional(),
  issue: issue("GitHub or GitLab issue URL"),
  acceptance: z
    .array(z.string().trim().min(1).max(500).regex(/^[^\r\n]*$/, "one line"))
    .max(30)
    .optional()
    .describe("Checklist lines"),
  status: z.enum(["todo", "inbox"]).optional(),
  /** false: To Do only; absent: this Mac's "Start new ready tasks" (server/auto-start.ts). create_task's description says it. */
  start: z.boolean().optional(),
});

/** What became of a new task's start (server/auto-start.ts). */
export const NEW_START_STATES = ["", "queued", "todo_only", "waits", "asks_first"] as const;

export const tasksCreateRpc = defineRpc({
  name: "tasks.create",
  input: tasksCreateInput,
  output: taskOutput.extend({
    /**
     * queued: this Mac's autopilot starts it once; todo_only: kept in To Do; waits: not started (start_note
     * says why); asks_first: start it only through start_task; "": a draft.
     */
    start: z.enum(NEW_START_STATES),
    start_note: z.string(),
  }),
});

/** What update_task records of a task's way to accepted work (03-model.md, Delivery); "" clears a field. */
export const deliveryInput = z.object({
  stage_sha: z.string().trim().regex(/^(?:[0-9a-fA-F]{7,64})?$/, "a commit sha").optional(),
  stage_url: z.string().trim().regex(/^(?:https:\/\/\S+)?$/, "an https URL").max(500).optional(),
  stage_version: z.string().trim().max(80).optional(),
  flags: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  flags_ready: z.boolean().optional(),
  access_ready: z.boolean().optional(),
  device: z.string().trim().max(120).optional(),
  device_ready: z.boolean().optional(),
  trello: z.string().trim().regex(/^(?:https:\/\/trello\.com\/c\/\S+)?$/, "a Trello card URL").max(300).optional(),
  trello_state: z.string().trim().max(80).optional(),
  qa: z.enum(["pending", "passed", "failed", ""]).optional(),
  qa_note: z.string().trim().max(500).optional(),
});

export const tasksUpdateInput = z.object({
  task: name(),
  title: z.string().trim().min(1).max(200).optional(),
  brief: z.string().max(20000).optional(),
  project: optionalName(),
  feature: optionalName(),
  milestone: optionalName(),
  priority: priority.optional(),
  assignee: optionalName(),
  add_labels: labels(),
  remove_labels: labels(),
  depends_on: z.array(z.string().trim().min(1)).max(20).optional().describe("Replaces the list"),
  issue: issue("Issue URL; empty takes it off"),
  agent_profile: z.string().trim().max(80).optional().describe("Agent profile name on this Mac; its model and effort start the task; empty takes it off"),
  requires: z
    .array(z.object({ kind: z.enum(REQUIREMENT_KINDS), reason: z.string().trim().min(1).max(200) }))
    .max(10)
    .optional()
    .describe("Owner or environment needs; replaces the list"),
  readiness_note: z.string().trim().max(300).optional().describe("The user checked it can start"),
  delivery: deliveryInput.optional().describe("\"\" clears a field"),
  duplicate_of: optionalName("With status canceled: merge into that task"),
  status: z
    .enum(["todo", "inbox", "done", "canceled"])
    .optional()
    .describe("todo: accept a draft or reopen; inbox: back to the drafts"),
  position: z
    .enum(["top", "bottom", "up", "down", "before", "after"])
    .optional()
    .describe("Among its priority; before/after need next_to"),
  next_to: optionalName(),
});

export const tasksUpdateRpc = defineRpc({
  name: "tasks.update",
  input: tasksUpdateInput,
  output: taskOutput.extend({ changed: z.array(z.string()) }),
});

export const tasksStartInput = startCheckInput.extend({
  /**
   * Set by God Mode (as a fixed argument) when this machine lets ChatGPT start without asking: the
   * start then refuses unless the switch is on here.
   */
  without_asking: z.boolean().optional(),
});

export const tasksStartRpc = defineRpc({
  name: "tasks.start",
  input: tasksStartInput,
  output: z.object({
    ok: z.boolean(),
    id: z.string(),
    state: z.enum(["launching", ""]),
    branch: z.string(),
    workspace: z.string(),
    /** The permission mode the agent is created in, as start_check says it; empty when nothing started. */
    mode: z.string(),
    /** The effort the agent is created with and where it comes from; empty when nothing started. */
    effort: z.string(),
    /** Whether the instructions sent changed since the user last saw them, as start_check says it; empty when nothing started. */
    instructions: z.string(),
    /** As start_check says it: a start without a read-back says here that the task is marked as a person's work. */
    human: z.string(),
    error: z.string(),
  }),
});

/**
 * A task flag of this Mac's autopilot as a resume through ChatGPT sees it (server/autopilot-resume.ts):
 * queued: it waits for the autopilot to start it; launching: claimed, its agent being created, not
 * yet working; working: its agent is at work; started: it has a run whose agent does something else
 * (`agent` says what), or it is in progress or in review; finished: done or canceled; paused: the
 * flag is paused; blocked: it waits for other tasks or is a draft; not_queued: no task flag of its
 * own on this Mac; not_found: no such task.
 */
export const RESUME_STATES = ["queued", "launching", "working", "started", "finished", "paused", "blocked", "not_queued", "not_found"] as const;

/** The read-back of resume_task: the paused task, why it is paused, and what resuming it does. */
export const resumeCheckRpc = defineRpc({
  name: "autopilot.resume-check",
  input: taskRef,
  output: z.object({
    task: z.string(),
    title: z.string(),
    space: z.string(),
    /** Why the autopilot paused its flag, as it wrote it. */
    paused: z.string(),
    /** What resuming does: the autopilot may start it on its own, under this Mac's limit. */
    then: z.string(),
    /** Its state now; with an error, why there is nothing to resume. */
    state: z.enum(RESUME_STATES),
    /** What the user can do instead, with an error; else "". */
    next: z.string(),
    error: z.string(),
  }),
});

/** Clears the pause of one task flag of this Mac's autopilot, as Live → Autopilot's Resume does. */
export const resumeTaskRpc = defineRpc({
  name: "autopilot.resume-task",
  input: taskRef,
  output: z.object({
    ok: z.boolean(),
    task: z.string(),
    title: z.string(),
    /** After the resume: queued, launching or working; paused when its start failed again at once. Refused: the state found. */
    state: z.enum(RESUME_STATES),
    /** What its run's agent does (overview.running's activity); "" without a run. */
    agent: z.string(),
    /** Queued or paused: what the autopilot waits for, or why it paused; else "". */
    wait: z.string(),
    next: z.string(),
    error: z.string(),
  }),
});

export const tasksStartSetInput = startPlanInput.extend({
  /** As tasks.start's: set by God Mode while this machine lets ChatGPT start without asking. */
  without_asking: z.boolean().optional(),
});

export const tasksStartSetRpc = defineRpc({
  name: "tasks.start-set",
  input: tasksStartSetInput,
  output: z.object({
    ok: z.boolean(),
    /** Claimed for this Mac, its worktree and agent being created: launching, not yet working. */
    started: z.array(z.object({ id: z.string(), title: z.string(), state: z.enum(["launching"]), branch: z.string(), mode: z.string() })),
    /** Left to this Mac's autopilot: each starts on its own once ready, one per check. */
    queued: z.array(z.object({ id: z.string(), title: z.string(), waits_for: z.string() })),
    not_started: z.array(z.object({ id: z.string(), title: z.string(), decision: z.string(), reason: z.string(), next: z.string() })),
    /** Claimed, but whether the claim landed is not known yet: it may still start; never start it again, read task. */
    unclear: z.array(z.object({ id: z.string(), title: z.string(), reason: z.string() })),
    /** What the lists mean and how to follow them. */
    note: z.string(),
    error: z.string(),
  }),
});

export const tasksReleaseInput = taskRef.extend({
  to: z.enum(["todo", "canceled", "done"]),
});

export const tasksReleaseRpc = defineRpc({
  name: "tasks.release",
  input: tasksReleaseInput,
  output: z.object({
    ok: z.boolean(),
    id: z.string(),
    status: z.string(),
    /** What became of the run's agent: "stopped on this Mac", "stops on <host> once it syncs", or why it could not be stopped. */
    agent: z.string(),
    error: z.string(),
  }),
});

/** The longest review comment `tasks.send-back` takes. */
export const SEND_BACK_MAX = 4000;

/** What God Mode supplies to `tasks.send-back`: never `reply`, so the comment goes as review feedback. */
export const sendBackInput = taskRef.extend({
  comment: z
    .string()
    .trim()
    .min(1)
    .max(SEND_BACK_MAX)
    .describe("In the user's words"),
});

const entityOutput = z.object({ ok: z.boolean(), id: z.string(), title: z.string(), error: z.string() });

export const milestonesCreateInput = z.object({
  space: createSpace,
  title: z.string().trim().min(1).max(200),
  due: day.optional(),
  start: day.optional(),
  status: z.enum(["planned", "active"]).optional(),
});

export const milestonesCreateRpc = defineRpc({ name: "milestones.create", input: milestonesCreateInput, output: entityOutput });

export const milestonesUpdateInput = z.object({
  milestone: name(),
  title: z.string().trim().min(1).max(200).optional(),
  due: day.optional(),
  start: day.optional(),
  status: z.enum(["planned", "active", "done", "canceled"]).optional(),
});

export const milestonesUpdateRpc = defineRpc({ name: "milestones.update", input: milestonesUpdateInput, output: entityOutput });

export const featuresCreateInput = z.object({
  space: createSpace,
  title: z.string().trim().min(1).max(200),
  milestone: optionalName(),
  branch: z.string().trim().min(1).max(100).optional(),
  projects: z.array(z.string().trim().min(1)).max(20).optional(),
  brief: z.string().max(20000).optional(),
});

export const featuresCreateRpc = defineRpc({ name: "features.create", input: featuresCreateInput, output: entityOutput });

export const featuresUpdateInput = z.object({
  feature: name(),
  title: z.string().trim().min(1).max(200).optional(),
  milestone: optionalName(),
  branch: z.string().trim().min(1).max(100).optional(),
  status: z.enum(["planned", "active", "done", "canceled"]).optional(),
});

export const featuresUpdateRpc = defineRpc({ name: "features.update", input: featuresUpdateInput, output: entityOutput });

// ---------------------------------------------------------------- reconcile (JOBBY-YV2QS)

/** Acceptance lines a reconcile row names; the rest are counted in `left_count`. */
export const RECONCILE_LEFT = 8;

export const reconcileInput = z.object({
  space,
  task: optionalName("Asks its forge now"),
});

/**
 * Work merged on the forge while the task stayed open (todo, a draft, or in progress with no run):
 * the PR/MR, its merge commit and source branch, how it is tied to the task, the acceptance still
 * open and what to do. Read only: it never changes a task. `projects`: a project whose web host is
 * not the one its forge serves, with the fix.
 */
export const reconcileRpc = defineRpc({
  name: "tasks.reconcile",
  input: reconcileInput,
  output: z.object({
    tasks: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        status: z.string(),
        project: z.string(),
        merged: z.array(
          z.object({
            pr: z.string(),
            url: z.string(),
            /** The merge's commit on the target branch; "" when the forge did not name it. */
            sha: z.string(),
            branch: z.string(),
            merged_at: z.string(),
            /** How it is tied to the task: branch, link, id_in_title, id_in_description, id_in_branch, closes_issue. */
            by: z.string(),
          }),
        ),
        /** Acceptance lines not ticked, at most RECONCILE_LEFT. */
        left: z.array(z.string()),
        left_count: z.number().int(),
        next: z.string(),
      }),
    ),
    projects: z.array(z.object({ space: z.string(), project: z.string(), problem: z.string() })),
    note: z.string(),
    error: z.string(),
  }),
});

// ---------------------------------------------------------------- batches and full text (JOBBY-YV2QS)

/** Most tasks one update_tasks changes: its read-back names each, and a retry re-reads each. */
export const BATCH_MAX = 25;
/** Most tasks one tasks_profiles reads. */
export const PROFILES_READ_MAX = 50;
/** Characters of a section one task_text answer carries; the rest is read from `next_cursor`. */
export const TEXT_CHUNK = 4000;

export const tasksProfilesInput = z.object({
  tasks: z.array(z.string().trim().min(1).max(200)).min(1).max(PROFILES_READ_MAX),
});

/**
 * For each task: the profile its next start uses and the model and effort that gives, apart from the
 * model and effort of the agent that runs it now (a profile change never touches a running agent).
 * `revision`: of the profiles as read, for update_tasks. A task not found has `error`; the rest still answer.
 */
export const tasksProfilesRpc = defineRpc({
  name: "tasks.profiles",
  input: tasksProfilesInput,
  output: z.object({
    tasks: z.array(
      z.object({
        task: z.string(),
        id: z.string(),
        title: z.string(),
        status: z.string(),
        agent_profile: z.string(),
        /** What the next start uses: "profile Sonnet 5.5 High: claude/claude-sonnet-5-5, effort high" or the policy's pick and why. */
        next_start: z.string(),
        /** The agent at work on it now, as started: "claude-opus-5-5, effort high"; "" without one on this Mac. */
        running: z.string(),
        error: z.string(),
      }),
    ),
    revision: z.string(),
    error: z.string(),
  }),
});

const batchItem = z.object({
  task: name(),
  agent_profile: z.string().trim().max(80).describe("Empty takes it off"),
});

export const updateTasksCheckInput = z.object({
  items: z.array(batchItem).min(1).max(BATCH_MAX),
});

/** The read-back of update_tasks: each change, each refusal, and the revision the action must carry. */
export const updateTasksCheckRpc = defineRpc({
  name: "tasks.update-many-check",
  input: updateTasksCheckInput,
  output: z.object({
    /** "ERG-1 Sonnet 5.5 High → Opus 5.5 High; ERG-2 unchanged", at most 600 characters. */
    changes: z.string(),
    /** Items that would be refused: unknown task or profile. */
    refused: z.string(),
    revision: z.string(),
    count: z.number().int(),
    error: z.string(),
  }),
});

export const updateTasksInput = updateTasksCheckInput.extend({
  revision: z.string().trim().min(1).max(40),
  key: z.string().trim().min(8).max(80).describe("Idempotency key"),
});

/**
 * Sets the agent profile of up to BATCH_MAX tasks; nothing else of them changes. Each item answers on
 * its own: applied, already (it was so, or an earlier call with this key set it), refused (unknown
 * task or profile, or someone changed it since the check) or unknown (queued while the plan syncs:
 * call again with the same key). A checkpoint per key on this Mac keeps a retry from applying anything twice.
 */
export const updateTasksRpc = defineRpc({
  name: "tasks.update-many",
  input: updateTasksInput,
  output: z.object({
    ok: z.boolean(),
    key: z.string(),
    counts: z.object({ applied: z.number().int(), already: z.number().int(), refused: z.number().int(), unknown: z.number().int() }),
    items: z.array(
      z.object({
        task: z.string(),
        id: z.string(),
        result: z.enum(["applied", "already", "refused", "unknown"]),
        before: z.string(),
        after: z.string(),
        /** With a running agent: that it keeps its model until its next start. */
        note: z.string(),
        error: z.string(),
      }),
    ),
    error: z.string(),
  }),
});

export const TEXT_SECTIONS = ["brief", "acceptance", "handoff", "clarifications", "notes"] as const;

export const taskTextInput = taskRef.extend({
  section: z.enum(TEXT_SECTIONS),
  cursor: z.number().int().min(0).max(1_000_000).optional(),
  revision: z.string().trim().max(40).optional(),
});

/**
 * One section of a task in full, TEXT_CHUNK characters at a time: `truncated` and `next_cursor` say
 * there is more. `revision` is of the task's file: a cursor read against another revision is refused,
 * so parts of two versions are never joined.
 */
export const taskTextRpc = defineRpc({
  name: "tasks.text",
  input: taskTextInput,
  output: z.object({
    id: z.string(),
    section: z.string(),
    text: z.string(),
    cursor: z.number().int(),
    next_cursor: z.number().int(),
    truncated: z.boolean(),
    total: z.number().int(),
    revision: z.string(),
    error: z.string(),
  }),
});

// ---------------------------------------------------------------- start candidates (JOBBY-YV2QS)

/**
 * What the open tasks wait for, as start_candidates groups them:
 * - agent: an agent can take it now: ready, no person's label, requirement, open question or merged work;
 * - person: a label marks it as a person's work;
 * - decision: an owner's decision (a requirement, or an open question in its brief);
 * - dependencies: it waits for other tasks;
 * - qa_environment: a requirement of an environment, a device, an access or QA;
 * - merged: its work is merged already; what is left is acceptance (reconcile);
 * - check: a label of it reads like a person's work, but the space does not mark it so: a person decides;
 * - not_here: its project is not mapped on this Mac.
 */
export const CANDIDATE_GROUPS = ["agent", "person", "decision", "dependencies", "qa_environment", "merged", "check", "not_here"] as const;

export const startCandidatesInput = z.object({
  space,
  group: z.enum(CANDIDATE_GROUPS).optional(),
  limit: limit(20),
});

/**
 * The todo tasks in the board's order, each with what it waits for and what a start would use, and
 * this Mac's slots. Read only: it starts nothing; a start is start_task or start_tasks when the user asks.
 */
export const startCandidatesRpc = defineRpc({
  name: "tasks.start-candidates",
  input: startCandidatesInput,
  output: z.object({
    /** This Mac's places: active (at work, asking or being started), launching among them, stopped and review holding none, free. */
    slots: z.object({
      max: z.number().int(),
      active: z.number().int(),
      launching: z.number().int(),
      stopped: z.number().int(),
      review: z.number().int(),
      free: z.number().int(),
      /** A usage limit holding every start: until when and why; "" when none. */
      hold: z.string(),
    }),
    counts: z.record(z.string(), z.number().int()),
    tasks: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        group: z.enum(CANDIDATE_GROUPS),
        /** Its place in the board's order of the space's todo tasks, 1 first. */
        order: z.number().int(),
        reason: z.string(),
        next: z.string(),
        /** What its next start uses: its profile or the per-task pick, with the model and effort. */
        start_with: z.string(),
        /** When a person last checked it can start, and what they found; "" when nobody did. */
        checked: z.string(),
        /** Known overlap with work under way or another candidate (a shared branch); "" when none is known, which is not "none". */
        overlap: z.string(),
      }),
    ),
    total: z.number().int(),
    note: z.string(),
    error: z.string(),
  }),
});

// ---------------------------------------------------------------- delivery (JOBBY-YV2QS)

/** The stages of a task's way from code to accepted work (server/delivery.ts). */
export const DELIVERY_STAGE_NAMES = ["in_work", "waiting_for_merge", "waiting_for_ci", "waiting_for_stage", "waiting_for_setup", "ready_for_qa", "qa_failed", "qa_passed", "accepted"] as const;

/**
 * A task's way from its PR/MR to accepted work: each step's state and fact, the stage it is at, who
 * acts next and what, why Trello cannot be read from here, and a QA handoff text. Merged is not
 * accepted: only QA's recorded result or the owner's acceptance closes it.
 */
export const tasksDeliveryRpc = defineRpc({
  name: "tasks.delivery",
  input: taskRef,
  output: z.object({
    id: z.string(),
    title: z.string(),
    stage: z.string(),
    /** Who acts next: agent, CI, deploy, owner, QA; "" when done. */
    next_by: z.string(),
    next: z.string(),
    steps: z.array(z.object({ step: z.string(), state: z.string(), fact: z.string() })),
    trello_blocker: z.string(),
    qa_handoff: z.string(),
    error: z.string(),
  }),
});
