# Paseo Dashboard v1: a task manager with a roadmap, driven from Paseo and ChatGPT

Design for review, 2026-10-25. Nothing is implemented yet; this folder is the plan the
implementation phases follow.

## In one paragraph

The dashboard is a Paseo plugin that keeps each umbrella project's plan (releases, cross-repo
features, tasks with acceptance checklists, and an inbox of drafts from meetings) as Markdown files
in a **separate git repository**. Everyone invited to that repository who runs Paseo with the plugin
sees the same plan, and starting a task **claims it through a git push**, so two machines never run
the same task. Starting a task creates a **worktree workspace and an agent** with the task's brief.
Progress comes back from **Paseo's lifecycle events, the agent's own reports and the PR/MR state**.
The plan shows as a **metro map** per project: each repo a line, each release a column, each
cross-repo feature an interchange, each task a station, readable from far away and zoomable into a
feature, a repo's line or a task. **ChatGPT drives it through God Mode** with eighteen operations, and
uses God Mode's own chat tools on each task's agent. Laconote meetings become inbox drafts either
through ChatGPT or through an import in the plugin. People without Paseo read a generated
`ROADMAP.md` and Obsidian Bases views in the plan repo.

## Documents

| # | Document | What it settles |
| --- | --- | --- |
| 01 | [Existing solutions](01-research.md) | What exists (including several Paseo task plugins), what we borrow, and why we build rather than fork |
| 02 | [Product](02-product.md) | Decisions agreed with the user, actors, scenarios S1–S10, v1 scope and non-goals, open questions |
| 03 | [Model](03-model.md) | Space, milestone, feature, task, inbox; ids; the plan repo's files; statuses and run activity; links to Paseo |
| 04 | [UX](04-ux.md) | What Paseo's UI can render, roadmap patterns from other tools, the four concepts, the chosen metro in detail, surfaces, flows, `ROADMAP.md`, Obsidian |
| 05 | [Architecture](05-architecture.md) | Parts, sync with an operation journal, the claim, start jobs, progress tracking, security, failure modes, platform facts |
| 06 | [God Mode contract](06-god-mode.md) | The eighteen operations, risks, targets, request and response examples, tests |
| 07 | [Plan](07-plan.md) | Six phases with acceptance criteria, dependencies, risks |

## Decisions agreed with the user

Numbered as in [02-product.md](02-product.md#decisions-agreed-with-the-user), where each is stated in
full.

| | Decision | Where it is worked out |
| --- | --- | --- |
| D1 | A separate plan repo per umbrella project; several spaces per plugin | [03](03-model.md) |
| D2 | Start = claim + worktree workspace + agent | [05](05-architecture.md#starting-a-task) |
| D3 | Progress from lifecycle, agent reports (MCP tools injected at creation) and PR/MR | [05](05-architecture.md#tracking-progress) |
| D4 | Several collaborators, each with their own Paseo; no double start (git compare-and-swap claims) | [05](05-architecture.md#the-claim-no-double-start-across-machines) |
| D5 | Space → milestone → feature → task → checklist; projects as lines | [03](03-model.md#hierarchy) |
| D6 | Laconote through ChatGPT and through an import in the plugin | [05](05-architecture.md#laconote-import) |
| D7 | The metro: repos as lines, releases as columns, features as interchanges, tasks as stations; on desktop the space opens on the board, the map a tab away (2026-11-03) | [04](04-ux.md#the-metro-in-detail), [04](04-ux.md#the-board) |
| D8 | God Mode sees and drives the plugin | [06](06-god-mode.md) |
| D9 | `ROADMAP.md` (Mermaid and tables) and Obsidian Bases views in the plan repo | [04](04-ux.md#for-people-without-paseo) |
| D10 | Plan edits from ChatGPT without a read-back (`low`); starting asks first (`outward`) | [06](06-god-mode.md#why-these-risks) |
| D11 | Plugin id `dashboard`, title "Dashboard" | [06](06-god-mode.md#identity) |
| D12 | Releasing or taking over a claimed task asks first (Paseo dialog; God Mode `release_task`, `disruptive`) | [06](06-god-mode.md#why-these-risks), [03](03-model.md#statuses) |
| D13 | The plan repo's default branch is the data branch; plugins push to it directly | [05](05-architecture.md#what-the-plan-repo-needs) |
| D14 | Agent defaults per space (`space.yaml`), overridable per task; the machine's setting is the fallback | [03](03-model.md#spaceyaml), [05](05-architecture.md#what-a-start-sends) |
| D15 | A feature becomes `done` automatically when all its tasks are done, and `active` again when one reopens | [03](03-model.md#milestone-and-feature) |
| D16 | The first plan repo is on GitHub | [05](05-architecture.md#what-the-plan-repo-needs) |
| D17 | Dependency `yaml` approved | [07](07-plan.md#dependencies) |

## The author's recommendation (for review)

| | Recommendation | Where |
| --- | --- | --- |
| R1 | Build our own plugin; borrow ideas from Tasks, Flowly, Backlog.md, Beads, Linear and others; copy no code | [01](01-research.md) |

## Open questions

None on the product side: everything asked is decided (D1–D17). Not yet verified on the live daemon,
and checked by the phase 3 spikes before the code depends on it: Paseo's PR/MR data for the
self-hosted GitLab, preapproved MCP tools in Claude Code and Codex, agent profiles through
`paseo.config.get()` ([07-plan.md](07-plan.md#phase-3--runner-and-progress)). Mermaid in Paseo's
mobile apps is checked in phase 4 ([07-plan.md](07-plan.md#phase-4--ui)).

## How this was researched

- Paseo 0.13.0 plugin documentation (paseo.sh), the 0.13.0 SDK and protocol types, and the daemon
  bundle installed on this machine.
- God Mode 0.12.1 as installed: its documentation and the code that parses `meta.describe` and runs
  `plugin_read` / `plugin_action`.
- The installed plugins on this machine (session-guard, defer, skills, usage-monitor,
  claude-accounts, caffeine, god-mode) for working patterns.
- Primary sources for the tools compared in [01](01-research.md) and [04](04-ux.md).
- The Laconote workspace as it is on this machine: the hub and its repositories, their forges, and
  the Laconote MCP server's REST usage.
