# 07 · Implementation plan and acceptance criteria

Six phases, each a separate task in this repository: its own branch from `origin/master`, its own
Paseo worktree workspace, its own PR, every commit through the review gate (see `AGENTS.md`). Each
phase ends with something that runs in the real daemon, not only green tests.

**Where checks must look.** A green `tsc` or `node --test` does not show that the plugin loads in
Paseo, that God Mode sees it, or that an agent can call its tools. Every phase therefore names a
check on the real daemon (`paseo plugin reload` + `paseo plugin logs`), through God Mode's own probe,
or on a phone, next to its unit tests.

**Development install.** During development the plugin runs from the phase's worktree under a
separate id, `paseo plugin add <worktree> --id dashboard-dev`, the pattern `claude-accounts-dev`
already uses on this machine. After the first release it is installed from git as `dashboard`.

## Phase 0 · Skeleton and the God Mode handshake

**Goal:** an empty plugin that loads, typechecks, tests and describes itself to God Mode.

- `paseo plugin init` into the repository; manifest `id: dashboard`, `name`, `description`,
  `requirements.paseo: ">=0.13.0"`; `OVERVIEW.md` placeholder with real text.
- `package.json`: `typecheck` (`tsc --noEmit`) and `test` (`node --test`); the `@getpaseo/*` SDK
  pinned exactly to `0.13.0` to match `requirements.paseo`, the other dev dependencies as the 0.13.0
  scaffold writes them (checked when `paseo plugin init` runs). Runtime `dependencies` empty unless
  approved.
- `meta.describe` answering one `overview` read with an empty plan, rendered lazily from zod.
- Tests: the God Mode checklist from [06-god-mode.md](06-god-mode.md#tests-the-plugin-ships); an
  import-boundary test (client code imports only host modules; no DOM APIs in `client/`).
- `AGENTS.md`: replace "no build or test commands yet" with the verified commands.

**Acceptance**

- [ ] `npm run typecheck` and `npm test` pass.
- [ ] `paseo plugin add <worktree> --id dashboard-dev`; `paseo plugin ls` shows `running` with no
      error; `paseo plugin logs dashboard-dev` shows no errors after `paseo plugin reload dashboard-dev`.
- [ ] From a separate God Mode checkout (not `~/.paseo/plugins/...`), `node core/probe.mjs plugins`
      lists "Dashboard (dashboard-dev)" with nothing dropped, and `plugin-read dashboard-dev` answers
      the empty overview.

## Phase 1 · Plan store and sync

**Goal:** the plan repo as a reliable shared store, without UI or agents.

- `shared/model.ts`: zod schemas for `space.yaml`, milestone, feature, task; statuses; ids.
- Parse and write entity files; preserve unknown keys and sections; slugs; ids with collision checks.
- In-memory index; derived state (blocked, progress per feature and milestone).
- Sync engine with the invariants I1–I5 of [05-architecture.md](05-architecture.md#invariants):
  managed clone per space, fetch loop, operation journal with `op_id`s and `Dashboard-Op:` trailers,
  idempotent application, run scope, the claim with its deadline, the transition table; git run
  without prompts (`GIT_TERMINAL_PROMPT=0`, SSH in batch mode) so a missing credential fails instead
  of hanging.
- The owner lock in `plugin-data/dashboard/`.
- Spaces registry and project mapping by normalised remote URL.

**Acceptance** (automated, with a bare repository as the remote and two clones as two collaborators)

- [ ] Parsing then writing an untouched file reproduces it byte for byte; a field edit changes only
      that field's line.
- [ ] Two clones claim the same task at once: exactly one claim lands; the other is refused with the
      winner's name, host and time (I4).
- [ ] A push that lands but whose result is dropped (the test discards the acknowledgement, and
      separately kills the process between push and journal update): after restart the operations are
      found on origin and leave the journal; no conflict is reported; a claim made this way continues
      as won (I1, I2, I5).
- [ ] Operations of an abandoned run, replayed after the task was released and claimed again, are
      dropped and do not touch the new run (I3); the same between a release and the next claim.
- [ ] An operation found already applied on origin (two machines recording the same merge) leaves the
      journal without a commit and without a conflict (I1, I2).
- [ ] A claim whose push fails before sending (remote unreachable) answers "nothing was started"; a
      push cut midway answers as unknown, is never pushed again, and is decided by later fetches
      (won if it landed); a claim that lands after being reported as not started shows as orphaned
      (I5). The fetch, push and deciding fetch together finish within 30 seconds, and with the
      default deadlines a confirmed `start_task` stays within God Mode's 45-second call budget.
- [ ] Reopening a task whose run ended with a merge and starting it again keeps the new run
      `in_progress`: the old merged PR/MR does not count, and the new run gets a fresh branch; the
      same when the PR/MR was merged after a release.
- [ ] A rejected claim push replays: another live run → "already started by …"; the task canceled
      meanwhile → refused with that reason; both without an "unknown".
- [ ] A merge time within the clock margin of `run_started` is shown to a person and moves nothing;
      a `run_pr` closed without merge is replaced by a newer open PR/MR of the same branch.
- [ ] Transition sequences: PR/MR first seen → `review`; seen again → no change; a person's "continue
      work" → `in_progress` and stays there while the same PR/MR is open; merged while `in_progress`
      → `done`; merged while `review` → `done`; an agent's `working` report never changes the status.
- [ ] `update_task`-style status changes on a task with a live run are refused; a release ends the run
      and keeps its fields as history (I4).
- [ ] Edits to different fields or different tasks from both clones all land, without conflicts.
- [ ] The same field edited in both clones: one lands, the other is reported as a conflict with both
      values; no data is lost.
- [ ] With the remote unreachable, operations persist in the journal across a restart and are pushed
      once it is back.
- [ ] An invalid file is listed in the space's problems with its reason and is not modified; duplicate
      ids are reported and writes to them refused.
- [ ] A second server instance on the same `PASEO_HOME` finds the owner lock and stays read-only.
- [ ] Feature status follows its tasks (D15): the last open task done → feature `done`; a task
      reopened, added or moved in → `active`; a `canceled` feature is never changed; a person's manual
      `done` stands until the next task change; two clones finishing the feature's last two tasks at
      once produce one feature transition and no conflict; a task closed in another clone (no plugin)
      triggers the transition after fetch.
- [ ] Live: connect a test plan repo on GitHub (D16; the user creates it) on the real daemon through
      a minimal settings screen; its entities appear in the `overview` read through God Mode's probe,
      and the plugin's pushes land on its default branch (D13).

## Phase 2 · API and God Mode

**Goal:** every operation of [06-god-mode.md](06-god-mode.md) works from ChatGPT, except the agent
part of `start_task`, which phase 3 completes.

- RPC contracts and handlers for reads and plan writes; name resolution; `outcome` fields.
- The sixteen operations in `meta.describe`; `start_task` described with its target, its handler
  doing the claim only until phase 3.

**Acceptance**

- [ ] Unit tests for each handler: resolution by id and by title words across spaces, ambiguity
      answered as `error` with candidates, every refusal answers `ok: false` with a reason, the
      transition table enforced.
- [ ] Probe: `plugins` shows sixteen operations and nothing dropped; `plugin-act ... add_to_inbox`
      creates drafts that appear as a commit in the plan repo, and repeating it skips them;
      `plugin-act ... start_task --json` returns `needs_confirmation` with the six target facts for a
      startable task and `refused` without asking for a blocked one; `plugin-act ... release_task
      --json` returns `needs_confirmation` naming the holder.
- [ ] By voice in ChatGPT (the user): "what needs me", "add a task …", "how is release …" answered
      from the plugin.

## Phase 3 · Runner and progress

**Goal:** starting a task runs an agent, and its progress comes back from all three sources.

Two spikes first, each a few hours, each ending in a written result in this folder:

- **Spike A, agent tools transport and creation idempotency.** Create a Claude Code agent and a Codex
  agent through `agents.create` with `config.mcpServers.dashboard` and `toolPolicy.preapproved`;
  compare the stdio bridge (Unix socket) and loopback HTTP. Also: resend the same request with the
  same `idempotencyKey` (same agent comes back), a changed request with the same key
  (`agent_request_key_conflict` expected), and a failure after provisioning (`outcomeUnknown`).
  *Pass:* both tools callable by both providers without a permission prompt and still working after
  `paseo plugin reload`; the three idempotency cases behave as the daemon code reads.
- **Spike B, forge data and profiles.** Read `githubRuntime.pullRequest` through
  `paseo.workspaces.ref(id).refresh()` for a worktree with an open MR on the self-hosted GitLab
  (`gitlab-ssh.example.com`) and one with a PR on GitHub. *Pass:* state, URL and merge state present
  for both; otherwise the `gh`/`glab` fallback becomes primary. Also: merge an MR after a rebase (or
  after pushing one more commit) and confirm the descriptor stops showing it, so the CLI check of
  `run_pr` catches the merge; check `glab mr view … ` JSON for the merge time on the installed glab.
  In the same spike: read `agentProfiles` from `paseo.config.get()` on the live daemon.

Then:

- Start job with persisted attempts, per-attempt idempotency keys and stored exact requests,
  reconciliation on `outcomeUnknown` (I6); restart on an existing run branch; prompt template;
  labels; title cut to 200 characters; timeline card.
- Tracker: hooks, latest-message read, reconciliation that adopts only known run ids, run-scoped and
  idempotent PR/MR transitions, CLI fallback, `pr_url` checked against the run's repo and branch.
- Agent tools bridge with per-run tokens.
- The instructions facts (`seen.json`, diff since last seen) for the start confirmation.

**Acceptance**

- [ ] A start from the UI and a confirmed `start_task` from God Mode each create exactly one
      workspace and one agent, also when the RPC is retried, the plugin is reloaded mid-start, or the
      daemon reports `outcomeUnknown`.
- [ ] Releasing a task and starting it again continues on its existing branch and MR: on the same
      machine in the previous workspace, on another machine through a checkout of the branch.
- [ ] When Paseo creates a workspace on a different branch than expected (the branch is held by
      another worktree), the attempt fails with both names and no agent is created.
- [ ] Live: an MR merged while the task is still `in_progress` moves it to `done`; the agent's
      `working` reports during review leave it in `review`.
- [ ] Live: a merged task reopened and started again runs on a fresh branch and stays `in_progress`
      although the old branch's MR is merged; a released task started again on the same machine
      while its previous agent still works is refused with "stop the previous run's agent first".
- [ ] An agent that sets the `dashboard.*` labels on itself (`paseo agent update --label`) is not
      adopted.
- [ ] The agent's first message is the brief; its title is `<id> · <title>`; it carries the
      `dashboard.*` labels (checked with `agents.list({ filter: { labels } })`).
- [ ] A permission request appears as `needs_input` in the dashboard and in God Mode's `overview`
      within one refresh; answering it through God Mode's `answer_approval` on the returned
      `chat_id` clears it.
- [ ] A `task_report` with two acceptance lines ticks them in the plan repo within the coalescing
      interval; `state: done` moves the task to `review`.
- [ ] Opening the MR moves the task to `review` with the link; merging moves it to `done`.
- [ ] After `paseo plugin reload dashboard-dev` during a run, the run's activity is correct again
      after reconciliation, without duplicates.

## Phase 4 · UI

**Goal:** the metro from [04-ux.md](04-ux.md#the-metro-in-detail), usable on desktop and phone,
and the plan repo's views for people without Paseo.

- The metro layout as a pure, unit-tested function; the map, feature and line views; Live tab; task
  list; task detail; inbox (without import); settings; workspace panel; Command Center items; composer
  pill; timeline renderer.
- `ROADMAP.md` rendering (tables, per-feature flowcharts, release gantt) from committed state;
  `views/*.base` templates written on space creation.

**Acceptance**

- [ ] Every scenario S1–S9 of [02-product.md](02-product.md#scenarios) can be done in the UI, except
      the Laconote import of S3, which phase 5 adds.
- [ ] Layout tests: lines in `space.yaml` order, releases by due date then Later, one interchange per
      feature per release spanning exactly its projects there, finished releases folded, two tasks of
      one feature in one repo shown as one station with a count.
- [ ] `ROADMAP.md` renders identically from two clones with the same plan state (byte for byte), and
      its Mermaid renders on GitHub, on the self-hosted GitLab and in Obsidian, and a Mermaid block in
      the host `Markdown` renders in Paseo's iOS and Android apps; the `.base` views open
      in Obsidian 1.14 or newer.
- [ ] Checked on a wide desktop window and on a phone (compact layout), in a light and a dark theme;
      no text without a theme color.
- [ ] Client code stays native-safe: `tsc` passes with no DOM library in `tsconfig.json`, and
      `rg -n "<(div|span|button|input|a|p|img|ul|li|form)\b|className=|onClick=|localStorage" client/`
      finds nothing outside `client/web.ts`. (The broader pattern in the paseo-plugin skill also
      matches TypeScript generics such as `Set<string>`, so its hits are triaged by hand.)
- [ ] A generated plan of 500 tasks in 6 projects stays responsive on the roadmap and list screens
      (fixture in the repository, `node fixtures/large-plan.ts`, checked by hand on desktop and phone).

## Phase 5 · Laconote import

- Settings: API base URL and key (stored in `secrets.json`, mode 0600); meeting list; preview;
  import of chosen action items as drafts; de-duplication.

**Acceptance**

- [ ] Importing a real meeting creates drafts with the meeting link; a second import of the same
      meeting offers only items not imported yet.
- [ ] The key appears in no RPC answer, no log line (`paseo plugin logs dashboard-dev`), and no file in
      the plan repo.
- [ ] An invalid key shows the API's error in the import screen; nothing is written.

## Phase 6 · Release

- `OVERVIEW.md`, `README.md`, `CHANGELOG.md`; version `0.1.0`; install from git as `dashboard`;
  remove the `dashboard-dev` install.

**Acceptance**

- [ ] `paseo plugin add github:ergoTech/paseo-dash --ref v0.1.0` installs and runs.
- [ ] One end-to-end run by the user: meeting → inbox (by voice) → triage → start (by voice, with the
      read-back) → agent works and reports → MR → merged → task done, roadmap updated, all visible to
      a second collaborator's Paseo.

## v1 is done when

- Scenarios S1–S10 work as described in [02-product.md](02-product.md#scenarios).
- All phase acceptance boxes above are ticked, with the evidence (command output, probe output,
  screenshots) linked from the phase PRs.
- God Mode lists the plugin with sixteen operations and nothing dropped.
- No secret in the plan repo, logs or RPC answers.

## Dependencies

`AGENTS.md` asks for agreement before new dependencies. `yaml` was approved by the user on
2026-10-25 (D17); the other two rows need none:

| Package | Where | Why | Alternative |
| --- | --- | --- | --- |
| `yaml` (eemeli/yaml, ISC, no dependencies) | server | Front matter that keeps comments, key order and formatting on rewrite, so human and Obsidian edits survive the plugin's writes | A hand-written parser for a restricted YAML subset; loses comments |
| none for MCP | server | The bridge needs only `initialize`, `tools/list` and `tools/call`; a small hand-written JSON-RPC handler avoids `@modelcontextprotocol/sdk` | The SDK, if spike A shows the transport needs more |
| none for layout | client | Lanes and dependency layers are computed in a few dozen lines; SVG is not available anyway | `d3-hierarchy` / `dagre`, bundled, if a graph view is chosen |

Dev dependencies are as the 0.13.0 scaffold writes them, with the `@getpaseo/*` SDK pinned exactly
(phase 0).

## Risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Paseo plugin API changes after 0.13 | Hooks or SDK calls break | SDK pinned exactly; typed wrappers in `server/context.ts`; a typecheck tripwire like the skills plugin's |
| A provider ignores injected MCP servers | No agent reports | Lifecycle and PR/MR still work; the run shows "no reports" |
| Plan repo branch protected, or a collaborator lacks push | Claims and edits stay pending | Clear "not synced" state with git's message; setup notes in `OVERVIEW.md` |
| Instructions from a collaborator tell the agent to do harm (git authorship is not authenticated) | Damage with the starter's permissions | Push access to the plan repo only for trusted people (the real boundary); "changed since you last saw them" with a diff before every start and in the God Mode read-back; `untrusted` reads; later, signed commits for instruction changes |
| Two installations on one daemon (`dashboard` and `dashboard-dev`) | Two writers on one clone and journal | The owner lock; the second installation stays read-only |
| Hooks missed during restarts | Wrong activity | Reconciliation on start and on a timer |
| God Mode or ChatGPT time limits | Failed or duplicated actions | Reads in memory; `start_task` returns after the claim; idempotency keys |
| The roadmap is hard to make readable on a phone | The main view fails on mobile | The concept must define its compact layout before phase 4 starts |
| Worktrees accumulate | Disk fills up | Task detail shows its workspace; archive offered after merge |
