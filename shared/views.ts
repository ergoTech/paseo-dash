import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { liveOverlap } from "./live.ts";
import { mergedPr } from "./board.ts";
import { GLYPHS } from "./map.ts";

/**
 * Reads for the dashboard's own screens (04-ux.md, Surfaces). God Mode has its own, shorter reads
 * (shared/api.ts); these carry what a screen shows in full, by id.
 */

const glyph = z.enum(GLYPHS);

export const taskViewRpc = defineRpc({
  name: "task.view",
  input: z.object({ task: z.string().min(1).describe("Task id") }),
  output: z.object({
    found: z.boolean(),
    space: z.string(),
    id: z.string(),
    title: z.string(),
    status: z.string(),
    glyph,
    project: z.string(),
    feature: z.object({ id: z.string(), title: z.string() }).nullable(),
    /** The release the task belongs to: its own, else its feature's. */
    milestone: z.object({ id: z.string(), title: z.string() }).nullable(),
    /** The task's own release id, empty when it follows its feature's (what an edit form shows). */
    own_milestone: z.string(),
    /** The feature id the task names, also when that feature is not in the plan (what a move starts from). */
    own_feature: z.string(),
    priority: z.string(),
    assignee: z.string(),
    /** `defined` false: the palette does not define the label; `color` empty: a neutral color shows. */
    labels: z.array(z.object({ name: z.string(), color: z.string(), defined: z.boolean() })),
    brief: z.string(),
    acceptance: z.array(z.object({ text: z.string(), done: z.boolean() })),
    dependencies: z.array(z.object({ id: z.string(), title: z.string(), status: z.string() })),
    links: z.array(z.string()),
    meeting: z.string(),
    meeting_title: z.string(),
    /**
     * The forge issue the task stands for, with what this machine last read of it (`state`: open,
     * closed, closed by <PR/MR>, unknown) and what a person should know (`note`), or null.
     */
    issue: z.object({ url: z.string(), label: z.string(), state: z.string(), note: z.string() }).nullable(),
    progress: z.string(),
    /** The live run, if any. */
    run: z
      .object({
        id: z.string(),
        by: z.string(),
        host: z.string(),
        since: z.string(),
        branch: z.string(),
        /** True when this machine started it: then its agent and workspace are here. */
        local: z.boolean(),
        activity: z.string(),
        agentId: z.string(),
        workspaceId: z.string(),
        lastMessage: z.string(),
        /**
         * The mode and effort the run's agent was started with, and what Paseo reports it runs with when
         * that differs (server/runner/run-settings.ts); "" for a run of another machine or one that predates it.
         */
        settings: z.string(),
        /**
         * What the run's agent does and what the run changed, while this machine follows its agent
         * (server/tracker/follow.ts); null otherwise. `now.at` is when the latest call was first seen: its start
         * when seen live, its last update when known only from a refetched page after a reload.
         */
        live: z
          .object({
            now: z.object({ op: z.string(), target: z.string(), status: z.string(), at: z.string() }).nullable(),
            /** Sorted, at most 200; `more` counts the rest. */
            changed: z.array(z.string()),
            more: z.number(),
            /** Other tasks whose runs on this machine change some of the same files. */
            overlaps: z.array(liveOverlap),
          })
          .nullable(),
        /**
         * A Paseo workspace a person tracked as this task (05-architecture.md, Tracking a Paseo
         * workspace as a task); null for a run the dashboard started.
         */
        tracked: z
          .object({
            /** `branch`: its PR/MR is followed; `trunk`: a checkout on the trunk, without a PR/MR. */
            kind: z.enum(["branch", "trunk"]),
            /** What the person should know: no dashboard tools, where progress comes from. */
            note: z.string(),
            /** For a trunk checkout: "landed on origin/main", or why not yet; empty otherwise. */
            landed: z.string(),
            /** Paseo shows the workspace archived (read for trunk checkouts only). */
            archived: z.boolean(),
          })
          .nullable(),
      })
      .nullable(),
    /** `note`: why the tracker moved nothing (a draft, a merge with acceptance left), else empty. */
    pr: z.object({ text: z.string(), url: z.string(), note: z.string() }).nullable(),
    /** The latest handoff a run left on the task (`run` and `at` empty when a person wrote it), or null. */
    handoff: z.object({ run: z.string(), at: z.string(), text: z.string() }).nullable(),
    /** The clarifications people gave when starting the task (`## Clarifications`), or empty. */
    clarifications: z.string(),
    /** The hash of the brief, acceptance, clarifications and handoff as shown, for marking them seen (tasks.seen). */
    instructions_hash: z.string(),
    /**
     * A task that never ran, in todo or inbox: the PR/MRs of its branch or links merged after it was
     * created, as this machine last read them (03-model.md, Work merged outside the dashboard).
     */
    merged: z.array(mergedPr),
    /** What a person may do with the task from this machine now. */
    actions: z.object({
      /** Why it cannot start from here; empty when it can (a blocked task only with "Start anyway"). */
      start: z.string(),
      blocked_by: z.array(z.string()),
      /** A live run holds it: done, back to todo and cancel are releases. */
      release: z.boolean(),
      /** In review with its run on this machine. */
      continue: z.boolean(),
      /** A tracked trunk checkout landed and its workspace is archived: "Mark done" comes first. */
      landed_done: z.boolean(),
      /** Todo without a run: mark done or cancel directly. */
      close: z.boolean(),
      /** Done or canceled: back to todo. */
      reopen: z.boolean(),
      /** An inbox draft: accept, merge or reject. */
      triage: z.boolean(),
      /** Why the task's project (line) cannot change, as a move answers; empty while it can. */
      line: z.string(),
      /** No live run, and a run of this Mac left its own (not a tracked) workspace unarchived. */
      archive: z.boolean(),
    }),
    error: z.string(),
  }),
});

/**
 * A task's code map while its run is followed on this machine (server/tracker/codemap.ts): the files
 * the run changed or read, and the relative imports between them; `linked` is a file a changed file
 * imports that the run did not touch. Read from the run's checkout when asked.
 */
export const taskCodeMapRpc = defineRpc({
  name: "task.codemap",
  input: z.object({ task: z.string().min(1).describe("Task id") }),
  output: z.object({
    /** The task has a run this machine follows. */
    followed: z.boolean(),
    nodes: z.array(
      z.object({
        path: z.string(),
        state: z.enum(["changed", "read", "linked"]),
        /** When the agent last touched it (ISO); empty when only git lists it, or for a linked file. */
        at: z.string(),
        imports: z.array(z.string()),
      }),
    ),
    /** Files left out beyond the map's limit. */
    more: z.number(),
    error: z.string(),
  }),
});

/**
 * A task's runs as the plan's commits have them, newest first, the live one included (read apart from
 * task.view: it asks git, and the answer is cached per clone HEAD).
 */
export const taskRunsRpc = defineRpc({
  name: "task.runs",
  input: z.object({ task: z.string().min(1).describe("Task id") }),
  output: z.object({
    found: z.boolean(),
    runs: z.array(
      z.object({
        id: z.string(),
        by: z.string(),
        host: z.string(),
        branch: z.string(),
        started: z.string(),
        ended: z.string(),
        /** Holds the task now. */
        live: z.boolean(),
        /** What became of it: "ended: done", "released back to todo", … */
        result: z.string(),
        pr: z.string(),
        progress: z.string(),
        handoff: z.object({ at: z.string(), text: z.string() }).nullable(),
        /** This machine started it (runs.json has it): its agent and workspace are here, or were. */
        local: z
          .object({ agentId: z.string(), workspaceId: z.string(), activity: z.string(), lastMessage: z.string() })
          .nullable(),
        /** Without `local`: where its agent is instead, as a person reads it. */
        elsewhere: z.string(),
      }),
    ),
    error: z.string(),
  }),
});

export const featureViewRpc = defineRpc({
  name: "feature.view",
  input: z.object({ feature: z.string().min(1).describe("Feature id") }),
  output: z.object({
    found: z.boolean(),
    space: z.string(),
    id: z.string(),
    title: z.string(),
    status: z.string(),
    branch: z.string(),
    milestone: z.string(),
    done: z.number().int(),
    total: z.number().int(),
    /** Dependency layers inside the feature: phase 1 depends on nothing in it, phase 2 on phase 1, … */
    phases: z.array(
      z.array(
        z.object({
          id: z.string(),
          title: z.string(),
          project: z.string(),
          status: z.string(),
          glyph,
          note: z.string(),
          /** That a label marks it as a person's work: "Start ready tasks" leaves it out. "" otherwise. */
          human: z.string(),
          after: z.array(z.string()),
        }),
      ),
    ),
    /** Projects the feature plans for (space.yaml keys) that have no task yet. */
    missing: z.array(z.string()),
    error: z.string(),
  }),
});
