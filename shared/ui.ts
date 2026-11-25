import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { SEND_BACK_MAX, tasksCreateRpc } from "./api.ts";
import { GLYPHS } from "./map.ts";
import { RUN_ACTIVITIES } from "./overview.ts";

/**
 * Actions only the dashboard's own screens offer (04-ux.md, Main flows). They are not described to
 * God Mode: starting a blocked task, continuing a run and marking instructions seen are decisions a
 * person makes in Paseo, not requests ChatGPT relays.
 */

const taskId = z.string().trim().min(1).describe("Task id");
const hash = z.string().regex(/^[0-9a-f]{24}$/, "an instructions hash");

const profile = z.string().trim().min(1).optional();
/** One of the chosen provider's modes, picked in the start confirmation. */
const mode = z.string().trim().min(1).max(100).optional();
/** One of the chosen model's efforts (thinking options), picked in the start confirmation. */
const effort = z.string().trim().min(1).max(100).optional();
/** One of the chosen provider's models (an id Paseo lists), picked in the start confirmation. */
const model = z.string().trim().min(1).max(200).optional();

export const DIFF_OPS = ["+", "-", " ", "…"] as const;

/** The longest clarification a start takes, in UTF-16 units as the input schema counts them. */
export const CLARIFICATION_MAX = 4000;

/**
 * For a task that never ran whose planned branch already exists (03-model.md, Branch names): continue
 * on that branch, or start on the planned name with a numeric suffix. Without it such a start is refused.
 */
const branchChoice = z.enum(["continue", "fresh"]).optional();

export const uiStartCheckRpc = defineRpc({
  name: "ui.start-check",
  input: z.object({
    task: taskId,
    profile,
    mode,
    effort,
    model,
    /** Check the rest of the start past the tasks it waits for, as "Start anyway" would. */
    anyway: z.boolean().default(false),
    branch: branchChoice,
  }),
  output: z.object({
    title: z.string(),
    project: z.string(),
    branch: z.string(),
    workspace: z.string(),
    profile: z.string(),
    mode: z.string(),
    /** The mode the start would pass, empty for the provider's own; and the provider's modes to pick from. */
    mode_id: z.string(),
    modes: z.array(z.object({ id: z.string(), label: z.string(), asks: z.boolean() })),
    /** The mode stops for the user's approval (Always Ask, Plan Mode): the agent waits for a person. */
    mode_asks: z.boolean(),
    /** The effort and where it comes from; the one the start would pass, empty for the provider's own; and the model's efforts. */
    effort: z.string(),
    effort_id: z.string(),
    efforts: z.array(z.object({ id: z.string(), label: z.string() })),
    /**
     * The model and where it comes from (for a pick per task, why); the model id the start would pass;
     * the models to pick from instead (the policy's, the provider's default and this one).
     */
    model: z.string(),
    model_id: z.string(),
    models: z.array(z.object({ id: z.string(), label: z.string() })),
    /** The agent profiles on this Mac, by name, to start with one of them instead. */
    profiles: z.array(z.string()),
    /** One sentence for all parts, as God Mode's confirmation reads it. */
    instructions: z.string(),
    /** Whether the task's forge issue closes when its PR/MR merges, and why not; empty without an issue. */
    issue: z.string(),
    /** That a label of the task marks it as a person's work; empty otherwise. */
    human: z.string(),
    /** The tasks it waits for that are not done, as text and by id. */
    blocked_by: z.array(z.string()),
    blocked_ids: z.array(z.string()),
    /** The same tasks to open from the confirmation, and whether each can itself start now. */
    waits: z.array(z.object({ id: z.string(), title: z.string(), status: z.string(), glyph: z.enum(GLYPHS), can_start: z.boolean() })),
    /** Each part of the instructions, with what changed since the local user saw it. */
    parts: z.array(
      z.object({
        key: z.string(),
        name: z.string(),
        hash,
        state: z.enum(["unchanged", "changed", "unseen"]),
        author: z.string(),
        diff: z.array(z.object({ op: z.enum(DIFF_OPS), text: z.string() })),
      }),
    ),
    /**
     * With an error about it: the planned branch exists and no run of the task made it. What it holds,
     * and what the person may choose: "Mark done" when its work is merged, continuing on it when
     * `cannot_continue` is empty, or `fresh`, the suffixed name.
     */
    existing: z
      .object({
        branch: z.string(),
        /** "on this Mac", "on origin", "checked out in /path". */
        where: z.array(z.string()),
        /** Its latest PR/MR merged, or the branch merged into the trunk; left out when that cannot be told. */
        merged: z.boolean().optional(),
        pr: z.object({ label: z.string(), url: z.string(), state: z.enum(["open", "merged", "closed"]), merged_at: z.string() }).optional(),
        /** The trunk it was merged into, when one took it in through a merge. */
        in_trunk: z.string(),
        fresh: z.string(),
        cannot_continue: z.string(),
      })
      .nullable(),
    error: z.string(),
  }),
});

/**
 * Creating a task from the dashboard's form: tasks.create, for a person at this Mac. Its start request
 * counts the brief as seen by them and needs no read-back (server/auto-start.ts).
 */
export const uiTasksCreateRpc = defineRpc({ name: "ui.tasks.create", input: tasksCreateRpc.input, output: tasksCreateRpc.output });

export const uiStartRpc = defineRpc({
  name: "ui.start",
  input: z.object({
    task: taskId,
    profile,
    mode,
    effort,
    model,
    /** "Start anyway": the ids of the blocking tasks the confirmation showed; any other blocker refuses. */
    start_past: z.array(z.string().trim().min(1)).max(20).default([]),
    /** What the person chose for an existing branch the confirmation showed. */
    branch: branchChoice,
    /** The hashes of the instruction parts the confirmation showed; a start refuses when they changed since. */
    seen: z.array(hash).max(8),
    /** What the person adds to the instructions; it is kept in the task's `## Clarifications`. */
    clarification: z.string().max(CLARIFICATION_MAX).default(""),
    /** The project, branch, workspace, agent and issue the confirmation showed; a start that would use others refuses. */
    shown: z
      .object({
        project: z.string().max(4000),
        branch: z.string().max(4000),
        workspace: z.string().max(4000),
        profile: z.string().max(4000),
        issue: z.string().max(4000),
        human: z.string().max(4000).default(""),
      })
      .optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    id: z.string(),
    state: z.enum(["launching", ""]),
    branch: z.string(),
    workspace: z.string(),
    error: z.string(),
  }),
});

export const tasksContinueRpc = defineRpc({
  name: "tasks.continue",
  input: z.object({ task: taskId }),
  output: z.object({ ok: z.boolean(), id: z.string(), status: z.string(), error: z.string() }),
});

/**
 * A task's place among the tasks of its priority waiting to start (D21): up, down, to the top or the
 * bottom of its section, or before or after another task there (`next_to`).
 */
export const tasksRankRpc = defineRpc({
  name: "tasks.rank",
  input: z.object({ task: taskId, position: z.enum(["top", "bottom", "up", "down", "before", "after"]), next_to: z.string().trim().min(1).max(200).optional() }),
  output: z.object({ ok: z.boolean(), id: z.string(), changed: z.number().int(), error: z.string() }),
});

/** The most tasks one archive names. */
export const ARCHIVE_MAX = 500;

/**
 * Takes done and canceled tasks off the board, or puts them back (03-model.md, Archive): the tasks
 * named, or every finished task not archived yet of a feature, of a space, or of every space. The plan
 * file, its run, branch and PR/MR stay; an open task is refused.
 */
export const tasksArchiveRpc = defineRpc({
  name: "tasks.archive",
  input: z
    .object({
      archived: z.boolean().describe("true archives, false puts back on the board"),
      tasks: z.array(taskId).min(1).max(ARCHIVE_MAX).optional(),
      /** Every done or canceled task of this feature, else of this space, else of every space (archiving only). */
      finished_of: z.object({ space: z.string().trim().min(1).optional(), feature: z.string().trim().min(1).optional() }).optional(),
    })
    .refine((input) => Boolean(input.tasks) !== Boolean(input.finished_of), "name the tasks, or finished_of, not both"),
  output: z.object({
    ok: z.boolean(),
    /** The tasks this changed. */
    changed: z.array(z.string()),
    /** Tasks named that were not changed, each with why: "ERG-7K3QX is todo; only a done or canceled task is archived". */
    refused: z.array(z.string()),
    error: z.string(),
  }),
});

/** "Archive workspace" (D23): the workspaces this Mac's ended runs of the task left, never a tracked one. */
export const tasksArchiveWorkspaceRpc = defineRpc({
  name: "tasks.archive-workspace",
  input: z.object({ task: taskId }),
  output: z.object({ ok: z.boolean(), archived: z.number().int(), error: z.string() }),
});

export const tasksSeenRpc = defineRpc({
  name: "tasks.seen",
  input: z.object({ task: taskId, hash }),
  output: z.object({ ok: z.boolean(), error: z.string() }),
});

/**
 * "Move…" (04-ux.md, Main flows): a task to another release, feature or project (line). An absent
 * field stays as it is; "" removes the task's feature or its own release. `from` is where the dialog
 * showed the task: a move refuses when that changed meanwhile, instead of overwriting it.
 */
export const uiMoveRpc = defineRpc({
  name: "ui.move",
  input: z.object({
    task: taskId,
    /** A project key of the space; only while the task was never started. */
    project: z.string().trim().min(1).optional(),
    /** A feature id, or "" for none. */
    feature: z.string().trim().optional(),
    /** The task's own release id, or "" for none (it then follows its feature's). */
    milestone: z.string().trim().optional(),
    from: z.object({ project: z.string(), feature: z.string(), milestone: z.string() }),
  }),
  output: z.object({ ok: z.boolean(), id: z.string(), changed: z.array(z.string()), error: z.string() }),
});

/**
 * What the forms offer to pick in a space: its projects, open releases and open features, and its
 * labels and people (also what the People & labels tab lists).
 */
export const uiOptionsRpc = defineRpc({
  name: "ui.options",
  input: z.object({ space: z.string().trim().min(1).describe("Space key") }),
  output: z.object({
    /** In space.yaml order; `mapped` when a Paseo project on this machine has its remote. */
    projects: z.array(z.object({ key: z.string(), mapped: z.boolean() })),
    /** Planned and active releases, by due date. */
    milestones: z.array(z.object({ id: z.string(), title: z.string(), due: z.string(), status: z.string() })),
    /** Planned and active features; `milestone` is the release id or empty. */
    features: z.array(z.object({ id: z.string(), title: z.string(), milestone: z.string(), projects: z.array(z.string()) })),
    /**
     * The palette in space.yaml order, then labels tasks carry that it does not define (`defined`
     * false, `color` empty: shown in a neutral color). `tasks` counts the tasks carrying each.
     */
    labels: z.array(z.object({ name: z.string(), color: z.string(), description: z.string(), defined: z.boolean(), tasks: z.number().int() })),
    /** `open_tasks`: tasks not done or canceled assigned to the person. */
    people: z.array(
      z.object({
        key: z.string(),
        name: z.string(),
        emails: z.array(z.string()),
        github: z.string(),
        gitlab: z.array(z.object({ host: z.string(), login: z.string() })),
        open_tasks: z.number().int(),
      }),
    ),
    /** The person whose emails hold this machine's git email (empty when none), and that email. */
    me: z.object({ key: z.string(), email: z.string() }),
    error: z.string(),
  }),
});

/**
 * The live runs this machine started, for the surfaces inside Paseo (04-ux.md, Surfaces): the
 * header button and workspace panel of a task's workspace, the composer pill of its agent, and the
 * Command Center's "Open this task".
 */
export const uiRunsRpc = defineRpc({
  name: "ui.runs",
  input: z.object({}),
  output: z.object({
    runs: z.array(
      z.object({
        task: z.string(),
        title: z.string(),
        space: z.string(),
        status: z.string(),
        workspaceId: z.string(),
        agentId: z.string(),
        /** "3/5" from the run's report or the acceptance ticks; empty when there is nothing to count. */
        progress: z.string(),
      }),
    ),
    error: z.string(),
  }),
});

/** The space's ROADMAP.md as the plugin renders it from the plan, for the Roadmap tab. */
export const uiRoadmapRpc = defineRpc({
  name: "ui.roadmap",
  input: z.object({ space: z.string().trim().min(1).describe("Space key") }),
  output: z.object({ text: z.string(), error: z.string() }),
});

/** Files shown per PR/MR on the task screen; the rest is counted. */
export const RESULT_FILES = 20;

/**
 * What a task's run produced, for deciding on it from the task screen: its PR/MR as the forge has
 * it now (state, changed files, checks, review). Read from `gh` / `glab` when the screen asks, never
 * on a timer.
 */
export const uiTaskResultRpc = defineRpc({
  name: "ui.task-result",
  input: z.object({ task: taskId }),
  output: z.object({
    /** The PR/MR the task's run is followed by; null when it has none yet. */
    pr: z
      .object({
        url: z.string(),
        label: z.string(),
        title: z.string(),
        /** open, draft, merged or closed */
        state: z.string(),
        base: z.string(),
        head: z.string(),
      })
      .nullable(),
    /** Null when the forge did not say. GitLab gives the file count only. */
    changes: z
      .object({
        files: z.number().int(),
        /** GitLab stops counting at 1000: `files` is then a lower bound. */
        at_least: z.boolean(),
        additions: z.number().int().nullable(),
        deletions: z.number().int().nullable(),
        list: z.array(z.object({ path: z.string(), additions: z.number().int(), deletions: z.number().int() })),
        /** Files not in `list`. */
        more: z.number().int(),
      })
      .nullable(),
    /** CI as the forge sums it up; null when it did not say. */
    checks: z
      .object({
        /** passing, failing, pending, waiting (a GitLab pipeline on a manual job or a schedule) or none */
        state: z.string(),
        passed: z.number().int(),
        failed: z.number().int(),
        pending: z.number().int(),
        /** Names of the failed checks, at most ten. */
        failing: z.array(z.string()),
        /** The pipeline's page on GitLab; empty on GitHub, where the PR page lists the checks. */
        url: z.string(),
      })
      .nullable(),
    /** approved, changes requested, review required, or empty when the forge does not say. */
    review: z.string(),
    read_at: z.string(),
    error: z.string(),
  }),
});

/**
 * A person's review comment, sent to the task's agent as its next message; a task in review goes
 * back to in progress, as "Continue work" does, except a tracked Paseo workspace's, which stays in
 * review (its agent cannot report the work done again). Only on the run's own machine.
 */
export const tasksSendBackRpc = defineRpc({
  name: "tasks.send-back",
  input: z.object({
    task: taskId,
    comment: z.string().trim().min(1).max(SEND_BACK_MAX),
    /** An answer to an agent waiting while the task is in progress: sent as written, the status stays. */
    reply: z.boolean().optional(),
  }),
  output: z.object({
    ok: z.boolean(),
    status: z.string(),
    /** Sent, but the task did not move, and why; `error` is only for a comment that was not sent. */
    note: z.string(),
    error: z.string(),
  }),
});

/**
 * This machine's display choices (04-ux.md, Surfaces): `space_rows` adds a sidebar row per space
 * next to the all-spaces "Paseo Dash" row; off unless turned on. Settings screen only.
 */
const uiPrefs = z.object({ space_rows: z.boolean() });

/** How many places the search remembers as recent. */
export const RECENT_MAX = 10;

/** A place a person opened: a task, a feature or a line, with its space, for the search's empty field. */
export const recentItem = z.object({
  kind: z.enum(["task", "feature", "line"]),
  /** A task's or feature's id; a line's project key. */
  id: z.string().trim().min(1).max(64),
  title: z.string().max(300),
  space: z.string().max(16),
});
export type RecentItem = z.output<typeof recentItem>;

/** This Mac's recent places, newest first (server/ui-prefs.ts); none when another installation owns the data. */
export const uiRecentRpc = defineRpc({
  name: "ui.recent",
  input: z.object({}),
  output: z.object({ items: z.array(recentItem), error: z.string() }),
});

export const uiRecentAddRpc = defineRpc({
  name: "ui.recent.add",
  input: recentItem,
  output: z.object({ ok: z.boolean(), error: z.string() }),
});

export const uiPrefsRpc = defineRpc({
  name: "ui.prefs",
  input: z.object({}),
  output: uiPrefs.extend({ error: z.string() }),
});

export const uiPrefsSetRpc = defineRpc({
  name: "ui.prefs.set",
  input: uiPrefs.partial(),
  output: uiPrefs.extend({ ok: z.boolean(), error: z.string() }),
});

/** The highest limit of runs at work a person may set for this Mac's autopilot. */
export const MAX_RUNNING_CAP = 20;

/**
 * Why one of this Mac's live runs (an `autopilot.read` run) takes one of the autopilot's slots or not,
 * as a person reads it (server/autopilot.ts holdsPlace decides; this only says it).
 */
export function slotNote(run: { activity: (typeof RUN_ACTIVITIES)[number]; holds_place: boolean; status: string }): string {
  if (run.holds_place) {
    if (run.activity === "launching") return "holds a slot: its agent is being started";
    if (run.activity === "working") return "holds a slot: its agent is at work";
    return "holds a slot: its agent waits for your reply or asks for a permission";
  }
  if (run.activity === "stopped") return "no slot: its agent stopped or is gone; the task stays held until you release it";
  if (run.activity === "failed") return "no slot: its agent failed; the task stays held until you release it or start it again";
  if (run.status === "review") return "no slot: in review, its agent waits for your acceptance";
  return "no slot: no agent at work";
}

/**
 * The cautious autopilot (D24; server/autopilot.ts): this Mac's flags to start one task once it is
 * ready, or a project's ready tasks one after another, with what each waits for.
 */
export const autopilotReadRpc = defineRpc({
  name: "autopilot.read",
  input: z.object({}),
  output: z.object({
    flags: z.array(
      z.object({ space: z.string(), task: z.string(), project: z.string(), title: z.string(), state: z.string(), paused: z.boolean() }),
    ),
    max_running: z.number().int(),
    /** This Mac's live runs that take a place under `max_running` (`runs` with `holds_place`). */
    running: z.number().int(),
    /**
     * This Mac's live runs. `activity` as overview.running says it. `holds_place`: its agent is at work
     * or being started, or waits for a reply in a task in progress (server/autopilot.ts holdsPlace); a
     * stopped or failed agent, or one waiting in review for the user's acceptance, takes no place, and
     * overview.needs_you says what the user does about it.
     */
    runs: z.array(
      z.object({
        space: z.string(),
        task: z.string(),
        title: z.string(),
        status: z.string(),
        activity: z.enum(RUN_ACTIVITIES),
        holds_place: z.boolean(),
      }),
    ),
    /** A usage limit holding every start: until when (ISO) and how that is known; both "" when none holds. */
    limit: z.object({ until: z.string(), source: z.string() }),
    started: z.array(z.object({ space: z.string(), task: z.string(), title: z.string(), project: z.string(), at: z.string() })),
    /**
     * This Mac's start defaults (server/autopilot.ts DEFAULT_START): whether a new ready task asks the
     * autopilot to start it, and the mode and effort ids every start passes when nothing more specific names one.
     * `auto_model`: Claude's model and effort are picked per task where no profile names them (server/runner/model-policy.ts).
     */
    start: z.object({ new_tasks: z.boolean(), mode: z.string(), mode_provider: z.string(), effort: z.string(), auto_model: z.boolean() }),
    error: z.string(),
  }),
});

/** The modes and efforts to pick this Mac's start defaults from: those of its default provider and model. */
export const autopilotStartOptionsRpc = defineRpc({
  name: "autopilot.start-options",
  input: z.object({}),
  output: z.object({
    /** "claude/claude-opus-5-5": whose modes and efforts these are. */
    provider: z.string(),
    /** `skips`: it skips permission prompts, so no start takes it by default. */
    modes: z.array(z.object({ id: z.string(), label: z.string(), skips: z.boolean() })),
    efforts: z.array(z.object({ id: z.string(), label: z.string(), model_default: z.boolean() })),
    error: z.string(),
  }),
});

export const autopilotSetRpc = defineRpc({
  name: "autopilot.set",
  input: z.object({
    /** The flag's space; may be left out when only `max_running` changes, which is this Mac's, not a space's. */
    space: z.string().trim().min(1).max(10).optional(),
    task: z.string().trim().max(20).optional(),
    project: z.string().trim().max(40).optional(),
    /** Turn the flag on or off; absent: leave it. */
    on: z.boolean().optional(),
    /** Clear a pause. */
    resume: z.boolean().optional(),
    /**
     * This Mac's limit of runs that take a place (server/autopilot.ts holdsPlace). It changes nothing
     * else: no flag, and no run, also when it drops below the runs at work now.
     */
    max_running: z.number().int().min(1).max(MAX_RUNNING_CAP).optional(),
    /** This Mac's start defaults; each changes only itself, for starts from now on. */
    start_new_tasks: z.boolean().optional(),
    /** With start_mode_provider: a mode id is one provider's. */
    start_mode: z.string().trim().min(1).max(100).optional(),
    start_mode_provider: z.string().trim().min(1).max(100).optional(),
    start_effort: z.string().trim().min(1).max(100).optional(),
    /** Pick Claude's model and effort per task where no profile names them. */
    start_auto_model: z.boolean().optional(),
  }),
  output: z.object({ ok: z.boolean(), error: z.string() }),
});

/** "Start next": the first task ready to start from this Mac across the spaces, in list order (D21). */
export const tasksNextRpc = defineRpc({
  name: "tasks.next",
  input: z.object({ space: z.string().optional() }),
  output: z.object({
    task: z.string(),
    title: z.string(),
    space: z.string(),
    /** The tasks that came first but are a person's work, and why; "" when none was passed over. */
    passed_over: z.string(),
    error: z.string(),
  }),
});

/** "Start ready tasks" of a feature (04-ux.md, The feature view): every task of it that can start now from here. */
export const tasksStartReadyRpc = defineRpc({
  name: "tasks.start-ready",
  input: z.object({
    feature: z.string().trim().min(1).max(20),
    /** The tasks the confirmation named: only these start, never one that became ready since. */
    tasks: z.array(z.string().trim().min(1).max(20)).min(1).max(50),
  }),
  output: z.object({
    started: z.array(z.object({ id: z.string(), title: z.string() })),
    skipped: z.array(z.object({ id: z.string(), title: z.string(), reason: z.string() })),
    error: z.string(),
  }),
});
