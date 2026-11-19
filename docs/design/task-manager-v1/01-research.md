# 01 · Existing solutions and the reuse / build / integrate decision

What already exists for managing work done by coding agents, what can be reused inside a Paseo
plugin, and the recommendation. Facts were collected on 2026-10-25 from the primary sources listed
at the end (repositories, official docs, changelogs). The entries marked ✔ were re-checked directly
for this document (license, activity, the claims used below); the rest are as reported from those
sources. UI and roadmap tools (Obsidian, Linear, GitHub Projects and others) are covered in
[04-ux.md](04-ux.md).

## The short answer

**Build the plugin, integrate with what the user already runs, borrow the proven ideas, copy no
code.**

- No existing tool combines what v1 needs: a plan shared by several people through a git
  repository, safe concurrent starts from several machines, a roadmap of releases and cross-repo
  features, and a ChatGPT surface through God Mode. Each candidate has at most one of these.
- Paseo already has several task and board plugins (all published in September and October 2026),
  and two of them are close in spirit ([Tasks](#paseo-plugins) and [Flowly](#paseo-plugins)). All of
  them keep a single-user local store, none describes itself to God Mode, and the two closest are one
  to two weeks old with a single maintainer. Forking one means replacing its storage, adding the
  roadmap and the God Mode contract, which is most of the work, on top of a codebase we do not
  control.
- The general agent kanbans are either gone (Vibe Kanban, Terragon), stalled (Task Master, Shrimp),
  cloud services (Linear, GitHub, Codex, Cursor, Jules), or in another runtime (Rust, Go, Python).

## Candidates

### General tools

| Candidate | What it is | License, state | Storage | Task ↔ agent | Progress | API / MCP | Use for us |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Vibe Kanban ✔ | Kanban that runs agents in worktrees (Rust + TS) | Apache-2.0; the company behind it shut down on 2026-04-10, community-maintained since [1][2] | Local SQLite; issues and projects lived in the vendor's cloud | Workspace = branch + worktree, optional linked issue | Executor process, PR monitor | MCP for issues, workspaces, sessions | Ideas only. Lesson: planning data in someone's cloud vanished with the company [6][7] |
| Task Master | PRD → tasks for agents (JS) | MIT + Commons Clause (README forbids competing products); few commits since March 2026 [10][11] | One `tasks.json` in the repo | None | Agent self-reports via `set_task_status` | 36 MCP tools, CLI | Ideas only. Lesson: 36 tools cost about 21k tokens of context, so it split them into sets [10] |
| Backlog.md ✔ | Markdown backlog in the repo, CLI/TUI/web/MCP (TypeScript on Bun) | MIT; active, releases in October 2026 [15] | `backlog/tasks/*.md`: YAML front matter + sections | `branch` field; no session link | Agent self-reports status, plan, notes, acceptance | CLI, `backlog mcp start` | **Format ideas**: file per task, front matter, acceptance checkboxes. Not its code: it builds, tests and runs on Bun (`package.json` scripts) [15]. Its sequential `PREFIX-N` ids collide with several writers; it ships a duplicate-repair module for that [17][18] |
| Beads ✔ | Issue tracker for agents (Go) | MIT; very active [19] | Dolt database in `.beads/`; JSONL is an export | `assignee`, atomic `--claim` | Agent self-reports through `bd` | CLI `--json`, MCP (Python) | **Ideas**: hash ids instead of counters [22]; ephemeral "wisps" kept out of sync [23]; routing to a separate planning repo [24]. Integration only through its CLI; users report heavy operational issues after the move to Dolt [25] |
| Shrimp Task Manager | MCP task manager | MIT; no updates since 2025-08 [26] | `tasks.json` | None | Self-report | MCP | Ideas only |
| Claude Squad | TUI for parallel agents (Go) | AGPL-3.0 [27] | No tasks | tmux session + worktree | Watches tmux | CLI | Nothing (AGPL, no tasks) |
| Conductor | Mac app for parallel agents | Source not found (license unverified) [28] | — | Worktree + branch from a fresh `origin`; can start from a GitHub/Linear issue | Session idle/working/errored; checks | Hosted API, MCP, CLI | **Idea**: "the workspace is the unit of delegation; the branch and PR are the unit of integration" [28] |
| Crystal → Nimbalyst | Electron agent manager | MIT [29] | Markdown in the repo | Session kanban, worktree per session | Agents update trackers; phone push | MCP client | Ideas only |
| Sculptor | Desktop agent runner (Python) | MIT [30] | — | Workspace = worktree | PR state | — | Ideas only |
| Terragon | Cloud agents | Shut down 2026-01-16; Apache-2.0 snapshot [31] | Postgres, Redis | Thread → sandbox + branch + PR | Run states draft…complete; PR states | CLI + MCP | Its status model only |
| kandev | Self-hosted agent pipeline (Go) | AGPL-3.0 [32] | — | Task → worktrees, multi-repo | Pipeline with review gates | MCP | Nothing (AGPL) |
| GitHub Issues/Projects + Copilot agent | SaaS | — | Issues, sub-issues, dependencies, Projects | Assign the Copilot agent | Agent task API; Projects automation moves merged PRs to Done [33][34][35] | REST/GraphQL, `gh` | **Considered as the store** (see [Alternatives](#alternatives-considered)) |
| Linear (agents) | SaaS | — | Issues + workflow states | Delegate (separate from assignee); AgentSession | Session states pending / active / error / awaitingInput / complete / stale [38] | GraphQL, webhooks | **Ideas**: two status axes (issue vs agent session); move to "started" when an agent begins [39] |
| Codex cloud, Cursor background agents, Jules | Cloud agents | — | — | Each run opens a PR | Run states; Jules asks for plan approval [40][41][42] | APIs, some in beta | Ideas only |
| Kiro specs | IDE/CLI spec workflow | — | `.kiro/specs/<feature>/{requirements,design,tasks}.md` | — | in-progress / completed; runs tasks in dependency waves [43] | — | **Idea**: dependency layers as execution waves |

### Paseo plugins

The Paseo registry lists several task or board plugins, all published in September and October 2026
[44]. The relevant ones:

| Plugin | License, age | Store | Agent link | Progress | God Mode | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| **Tasks** (anh-chu) ✔ | Apache-2.0; first release 2026-10-18 [48] | SQLite via `node:sqlite` in `plugin-data/tasks/` (needs Node 24+ on the daemon) | Preset → agent in the project or a new worktree; sessions attached to the task | Lifecycle hooks + agent reports through an injected CLI (`paseo-tasks`) and MCP server over a loopback HTTP bridge with a bearer token | No `meta.describe` ✔ | The cleanest reference for the daemon side: single writer, agent tool injection, token-protected bridge, lifecycle tracking. PR state through `gh pr view` |
| **Flowly** ✔ | MIT; listed 2026-10-16, updated today [47] | JSON in `plugin-data/flowly/` | Card = workspace, several sessions | Agents move their card between stages through eleven scoped MCP tools; "a turn ending never completes a card"; optional summaries by an extra cheap-model session | No `meta.describe` ✔ | The richest UX: "Needs you", a Task chip in the composer, session preview with follow-up input. About 62k lines |
| paseo-github-kanban, paseo-issues-workspaces | MIT [49][50] | GitHub issues + labels | Worktree + agent; the prompt asks for a PR with `Closes #N` | PR open → In review, merged → Done | No | Confirms the PR-driven review/done flow works in Paseo |
| paseo-kanban, Workboard, todo-board, three Beads boards, projectmanager | MIT [51]–[55] | Plugin settings with CAS revisions; workspace labels; checkboxes in `TODO.md`; `bd`; a git store outside the repo | Various | Various | No | projectmanager keeps a coordinator's notes in a separate git repo, the closest to our storage idea, but with a single writer |

None of the Paseo plugins in this table implements `meta.describe`, so none is usable from ChatGPT
through God Mode, and none stores tasks in a shared git repository.

## Lessons taken into the design

| Lesson | Where it comes from | What v1 does |
| --- | --- | --- |
| Planning status and agent run status are two different axes | Linear AgentSession, GitHub agent tasks, Vibe Kanban, Task Master | Committed task status vs. per-machine run activity ([03-model.md](03-model.md#statuses)) |
| A finished turn is not a finished task | Flowly, Workboard, Linear's guidance | Only PR/MR facts and the agent's explicit `done` report move status automatically |
| PR open → review, merged → done | GitHub Projects automation, Paseo GitHub plugins, Vibe Kanban PR monitor | Same, from Paseo's forge data first |
| "Needs you" must be the first thing you see | Flowly, Nimbalyst push, Linear `awaitingInput`, GitHub `waiting_for_user` | `needs_input` sorts first in every list and in God Mode's `overview` |
| Counters collide with several writers | Backlog.md issues and its duplicate-repair module; Beads moving to hash ids | Random ids, collision detection, no counter |
| The daemon is the single writer of its store; never resolve the store relative to an agent's cwd | Backlog.md MCP writing into the wrong checkout; Tasks' design | The plugin writes only its own clone, by absolute path |
| Keep runtime state out of the shared store | Beads wisps; Flowly and Tasks keep ids in `plugin-data` | Two tiers: plan repo vs. `plugin-data` |
| Re-apply operations on the remote's history instead of merging text | git-bug's operation log, TaskChampion's sync model | The operation journal with preconditions ([05-architecture.md](05-architecture.md#sync-and-concurrency)) |
| Do not depend on a service that can disappear | Vibe Kanban's shutdown left projects export-only | Plain files in a repo the team owns |
| Fetch the base before creating a worktree | Conductor | Fetch before every claim and workspace creation |
| Worktrees pile up | Vibe Kanban users reported tens of gigabytes in days [8] | v1 shows each task's workspace and offers archiving after merge; it never deletes on its own |
| A small tool surface for the model | Task Master's 36 tools | Sixteen God Mode operations ([06-god-mode.md](06-god-mode.md)) |
| Meeting notes → tasks works as extract → drafts → human review → queue | Fireflies → Linear, Linear Agent + Granola MCP, GitHub Copilot issue drafts [61]–[64] | Inbox drafts, from ChatGPT or the Laconote import, triaged by a person |

No open-source tool was found that turns meeting notes into a queue for coding agents; the
documented chains are SaaS (Fireflies or Granola into Linear, then delegation to an agent).

## Alternatives considered

| Option | For | Against | Decision |
| --- | --- | --- | --- |
| **GitHub Issues in a separate repo** as the store | Invites and permissions from GitHub, web UI, sub-issues and dependencies, `Fixes owner/tasks#N` across repos, Copilot delegation | Most Laconote repos are on a self-hosted GitLab, so links across forges are manual; every ChatGPT read becomes a network call with rate limits; no offline work; the user chose a repository of files | Not for v1. A one-way mirror to issues can come later |
| **Backlog.md's exact file format**, so its CLI and web UI work on the same repo | Free tooling for people without Paseo | Sequential ids that collide with several writers; its own config and status conventions; no release → feature level | Borrow its conventions (file per task, front matter, acceptance checkboxes), do not promise compatibility |
| **Fork Tasks (anh-chu)** | Working daemon side: bridge, injection, hooks | SQLite store (Node 24+) is the opposite of a shared git store; the roadmap and God Mode are missing; a week-old codebase with one maintainer | Read it as a reference; write our own |
| **Fork Flowly** | Rich UX | 62k lines, single-user JSON store, no roadmap, no God Mode | Borrow UX ideas only |
| **Beads as the backend** | Claims, dependency graph, hash ids | Go CLI dependency on every collaborator's machine, Dolt operational issues, not Markdown | Borrow hash ids and the planning-repo idea |
| **Linear** | The best documented agent ↔ issue protocol | Paid SaaS, OAuth app and a public webhook endpoint (a daemon behind NAT cannot receive it), not where the team plans now | No |

## What v1 integrates with

| System | How | Why not build it |
| --- | --- | --- |
| Paseo | Plugin SDK 0.13: workspaces, agents, lifecycle hooks, forge PR/MR data, UI surfaces | It is the host |
| God Mode | `meta.describe` with `paseo.capabilities/1`; native God Mode tools on `chat_id` | ChatGPT already reaches Paseo through it; no God Mode change needed |
| Laconote | ChatGPT's Laconote connector (no code) and the plugin's own REST import (`/api/v1/history/meetings`) | Meeting summaries and action items already exist there |
| GitHub / GitLab | Through Paseo's forge data; `gh` / `glab` by URL as a fallback | Paseo already normalises PR/MR state across forges |
| Obsidian | File format: Markdown + YAML properties, optional `.base` views ([04-ux.md](04-ux.md#obsidian-interoperability)) | Collaborators can read and edit the plan without Paseo |

## Sources

1. https://github.com/BloopAI/vibe-kanban
2. https://www.vibekanban.com/blog/shutdown
3. https://github.com/BloopAI/vibe-kanban/blob/main/crates/db/src/models/task.rs
5. https://github.com/BloopAI/vibe-kanban/blob/main/crates/services/src/services/pr_monitor.rs
6. https://github.com/BloopAI/vibe-kanban/issues/3354
7. https://github.com/BloopAI/vibe-kanban/issues/3396
8. https://github.com/BloopAI/vibe-kanban/issues/765
10. https://github.com/eyaltoledano/claude-task-master
11. https://github.com/eyaltoledano/claude-task-master/blob/main/LICENSE
15. https://github.com/MrLesk/Backlog.md
17. https://github.com/MrLesk/Backlog.md/blob/main/src/core/duplicate-task-repair.ts
18. https://github.com/MrLesk/Backlog.md/issues/558, /issues/1034, /issues/783
19. https://github.com/gastownhall/beads
22. https://github.com/gastownhall/beads/blob/main/docs/core-concepts/hash-ids.md
23. https://github.com/gastownhall/beads/blob/main/docs/workflows/wisps.md
24. https://github.com/gastownhall/beads/blob/main/docs/multi-agent/routing.md
25. https://github.com/gastownhall/beads/issues/2573, /issues/2938
26. https://github.com/cjo4m06/mcp-shrimp-task-manager
27. https://github.com/smtg-ai/claude-squad
28. https://www.conductor.build/docs/concepts/workspaces-and-branches
29. https://github.com/stravu/crystal, https://github.com/nimbalyst/nimbalyst
30. https://github.com/imbue-ai/sculptor
31. https://github.com/terragon-labs/terragon-oss
32. https://github.com/kdlbs/kandev
33. https://docs.github.com/en/copilot/how-tos/use-copilot-agents/cloud-agent/use-cloud-agent-via-the-api
34. https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-built-in-automations
35. https://github.blog/changelog/2025-08-21-dependencies-on-issues/
38. https://linear.app/developers/agent-interaction
39. https://linear.app/developers/agent-best-practices
40. https://learn.chatgpt.com/docs/cloud
41. https://cursor.com/docs/cloud-agent/api/endpoints
42. https://developers.google.com/jules/api
43. https://kiro.dev/docs/specs/
44. https://github.com/getpaseo/plugins, https://paseo.sh/plugins
47. https://github.com/JasprW/flowly
48. https://github.com/anh-chu/paseo-plugin-tasks
49. https://github.com/denny64/paseo-github-kanban
50. https://github.com/ajma/paseo-issues-workspaces
51. https://github.com/breathi3552/paseo-kanban
52. https://github.com/fxbing/paseo-workboard
53. https://github.com/4fthawaiian/paseo-todo-board
54. https://github.com/jmkelly/paseo-beads-board
55. https://github.com/wy3z/paseo-projectmanager
57. https://github.com/git-bug/git-bug/blob/trunk/doc/design/data-model.md
59. https://github.com/Vinzent03/obsidian-git
60. https://gothenburgbitfactory.org/taskchampion/sync-model.html
61. https://linear.app/integrations/fireflies-ai
62. https://linear.app/integrations/granola
63. https://linear.app/changelog/2026-04-23-linear-agent-mcp-support
64. https://docs.github.com/en/copilot/how-tos/use-copilot-for-common-tasks/use-copilot-to-create-or-update-issues

Numbers follow the research notes they were collected in; gaps are sources not used here.
