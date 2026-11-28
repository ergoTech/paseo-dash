# 06 · God Mode contract

How ChatGPT reads and drives the dashboard through God Mode. God Mode knows no plugin by name: a
plugin that answers `meta.describe` with the `paseo.capabilities/1` shape is offered to ChatGPT
through God Mode's generic `plugin_read` and `plugin_action` tools, with no God Mode release. This
page fixes the operations v1 describes, their arguments and answers, the risk of each action, and
examples of whole exchanges.

Sources for every rule used here: God Mode 0.12.1 `docs/plugin-capabilities.md`,
`docs/plugin-tools.md`, `docs/security.md`, `gpt-site/core/capabilities.mjs` and
`gpt-site/core/paseo.mjs` (installed copy, read on 2026-10-25).

## What God Mode already does, and what the plugin adds

God Mode has native tools for agents ("chats"): `overview`, `list_chats`, `read_chat`,
`read_activity`, `start_chat`, `send_message`, `answer_approval`, `stop_chat`, `archive_chat`. They
take a chat by id, and a Paseo agent id is God Mode's chat id. So the plugin does **not** duplicate
messaging, approvals or stopping. Its answers carry `chat_id` for a task's agent, and ChatGPT uses
the native tools on it. The plugin adds what God Mode cannot know: the plan (spaces, milestones,
features, tasks, inbox), task status and progress, and starting a task the way the plan says.

```mermaid
sequenceDiagram
    participant U as User (voice)
    participant C as ChatGPT
    participant G as God Mode Site
    participant P as Dashboard plugin
    U->>C: What needs me in Laconote?
    C->>G: plugin_read {plugin: "dashboard"}
    G->>P: meta.describe, then dashboard.overview {}
    P-->>G: needs_you: [{task, title, why, chat_id, kind, space, since}]
    G-->>C: result + actions
    C-->>U: "TOTP endpoints in core is waiting for approval to run npm test."
    U->>C: Allow it.
    C->>G: answer_approval with chat = the task's chat_id, decision allow
```

## Identity

| Key | Value |
| --- | --- |
| Plugin id | `dashboard` (from `paseo-plugin.json`) |
| `title` | `Dashboard` |
| `summary` | `Tasks, features and releases of your projects: what needs you, what runs, and starting a task as an agent.` |
| `aliases` | `tasks`, `task manager`, `roadmap`, `plan`, `backlog`, `releases`, `milestones`, `задачі`, `таски`, `дорожня карта`, `роадмап`, `планування`, `дашборд`, `релізи` |

## Operations

Thirty-six operations: twenty-one reads, fifteen actions. God Mode keeps at most 40; a small set also keeps the
catalog ChatGPT reads on every call short.

| id | kind | method | risk / asks | target | outcome | untrusted |
| --- | --- | --- | --- | --- | --- | --- |
| `overview` | read (main) | `dashboard.overview` | | | `error` | yes |
| `tasks` | read | `tasks.list` | | | `error` | yes |
| `task` | read | `tasks.get` | | | `error` | yes |
| `task_text` | read | `tasks.text` | | | `error` | yes |
| `delivery` | read | `tasks.delivery` | | | `error` | yes |
| `reconcile` | read | `tasks.reconcile` | | | `error` | yes |
| `start_candidates` | read | `tasks.start-candidates` | | | `error` | yes |
| `ready_review` | read | `tasks.ready-review` | | | `error` | yes |
| `tasks_profiles` | read | `tasks.profiles` | | | `error` | yes |
| `task_result` | read | `tasks.result` | | | `error` | yes |
| `roadmap` | read | `roadmap.get` | | | `error` | yes |
| `inbox` | read | `inbox.list` | | | `error` | yes |
| `start_check` | read | `tasks.start-check` | | | `error` | yes |
| `start_plan` | read | `tasks.start-plan` | | | `error` | yes |
| `start_tasks_check` | read | `tasks.start-plan`, fixed `for_start: true` | | | `error` | yes |
| `release_check` | read | `tasks.release-check` | | | `error` | yes |
| `accept_check` | read | `tasks.accept-check` | | | `error` | yes |
| `events` | read | `events.list` | | | `error` | yes |
| `recap` | read | `plan.recap` | | | `error` | yes |
| `autopilot` | read | `autopilot.read` | | | `error` | yes |
| `resume_check` | read | `autopilot.resume-check` | | | `error` | yes |
| `mark_events_read` | action | `events.seen` | `low`, runs at once | | `ok`, `error` | |
| `add_to_inbox` | action | `inbox.add` | `low`, runs at once | | `ok`, `error` | |
| `create_task` | action | `tasks.create` | `low`, runs at once | | `ok`, `error` | |
| `update_task` | action | `tasks.update` | `low`, runs at once | | `ok`, `error` | |
| `update_tasks` | action | `tasks.update-many` | `low`, runs at once ([below](#batches-and-full-text)) | | `ok`, `error` | |
| `start_task` | action | `tasks.start` | `outward`, **asks first**; `low`, runs at once, while this machine starts without asking ([below](#starting-without-asking)) | `start_check` → title, project, branch, workspace, profile, mode, instructions, issue (none while it runs at once) | `ok`, `error` | |
| `start_tasks` | action | `tasks.start-set` | `outward`, **asks first**; `low`, runs at once, while this machine starts without asking | `start_tasks_check` → start_now, after, not_started, agents, instructions (none while it runs at once) | `ok`, `error` | |
| `resume_task` | action | `autopilot.resume-task` | `outward`, **asks first**, also while this machine starts without asking ([below](#resuming-a-paused-task)) | `resume_check` → title, paused, then | `ok`, `error` | |
| `release_task` | action | `tasks.release` | `disruptive`, **asks first** | `release_check` → title, held_by, host, since | `ok`, `error` | |
| `accept_task` | action | `tasks.release`, fixed `to: "done"` | `disruptive`, **asks first** | `accept_check` → title, result, held_by, host, since, agent | `ok`, `error` | |
| `send_back` | action | `tasks.send-back` | `low`, runs at once | | `ok`, `error` | |
| `create_milestone` | action | `milestones.create` | `low` | | `ok`, `error` | |
| `update_milestone` | action | `milestones.update` | `low` | | `ok`, `error` | |
| `create_feature` | action | `features.create` | `low` | | `ok`, `error` | |
| `update_feature` | action | `features.update` | `low` | | `ok`, `error` | |

### Why these risks

God Mode's scale: `low` stays on the machine and one more call undoes it; `outward` reaches people
or services; `disruptive` interrupts work; `destructive` loses something for good. Only `low` runs
without asking.

- **Plan edits are `low`.** Creating, editing, accepting, completing, cancelling or reopening a task
  that **has no live run**, and creating or editing a feature or milestone, changes a planning file
  that one more call changes back; by itself it sends nothing to anyone and starts nothing. The issue
  mirror may later copy the committed plan to forge issues; see below. The edit becomes visible to
  collaborators on their next sync, which is the purpose of the shared plan repo.
  Confirmed by the user on 2026-10-25: plan edits from ChatGPT run without a read-back.
- **Starting is `outward`.** It creates a branch and an agent that works with the user's
  permissions, can push and open a merge request: it reaches the forge and other people, and costs
  money. It asks first, with facts read from the plugin.
  The user can turn this read-back off on one machine; see [Starting without asking](#starting-without-asking).
- **Marking events read is `low`.** It changes only this Mac's record of which task events were
  told (`events.json`); marking again changes nothing, and the events stay in the history.
- **Releasing is `disruptive`.** A task with a live run is held by one machine; ending that hold
  (back to `todo`, or to `canceled` or `done`) lets another machine start the task while the first
  agent may still work. That is the double start D4 forbids unless a person means it, so it asks
  first and names who holds the task. Decided with the user on 2026-10-25. `update_task` never
  changes the status of a task with a live run; it refuses with "use release_task".
- **Accepting work is `disruptive`, like releasing.** `accept_task` is the same release to done,
  so it asks first and still names who holds the task; its read-back also says the PR/MR's checks
  and review. **Sending work back is `low`.** It sends one message to the task's own agent, as God
  Mode's `send_message` does without a read-back, and makes the status move the task screen's Send
  back makes. Both decided with the user on 2026-10-28; see
  [Accepting and sending back](#accepting-and-sending-back).
- **Not described at all:** deleting anything, adding or removing spaces (`spaces.add`,
  `spaces.create`, `spaces.disconnect`), sync and settings, the Laconote API key, the plugin-side
  Laconote import and the release context mapping (`laconote.projects`, `laconote.releases.read`,
  `laconote.releases.set`), archiving workspaces, the autopilot's switches (`autopilot.set`; its
  state is the `autopilot` read; `start_tasks` sets task flags only for a set the user confirmed, see
  [Starting a set of tasks](#starting-a-set-of-tasks), and `resume_task` clears the pause of one task
  flag, see [Resuming a paused task](#resuming-a-paused-task)), and sharing a plan repository (`plans.available`, `sharing.read`,
  `sharing.invite`, `sharing.remove`, `spaces.check`; 09-forge-issues.md, F4): an
  invitation lets someone write instructions for the user's agents. God Mode's authoring guide asks
  to leave out settings writes, credentials and deletions; these stay in the Paseo UI.

### Starting without asking

Asked for by the user on 2026-10-27 (task JOBBY-8KM5B): a start the user asks ChatGPT for in their own
words should not need a second "yes". **Settings → Paseo Dash → Starts asked through ChatGPT (God Mode) → Start tasks
without asking** (also in the dialog of the top bar's Settings button) is a per-machine switch, off by default, kept in the plugin's data directory
(`godmode.json`), so it survives a daemon restart. Only the Settings screen changes it
(`godmode.settings`, `godmode.settings.set`, not described): ChatGPT cannot turn it on.

- **What God Mode supports.** God Mode skips its confirmation only for a `low` action; any other risk
  asks whatever `confirm` says. So while the switch is on, `meta.describe` describes `start_task` as
  `risk: "low"` (no `confirm`: God Mode derives it from the risk), without `target` and `confirmText`, with `fixed:
  {"without_asking": true}` and a description saying it runs at once. God Mode's catalog then lists
  it with `asks_first: false`. God Mode reads the description on every call, so a change of the
  switch applies to ChatGPT's next call. The risk it declares is the user's choice, not a new
  judgement of what a start reaches: it still creates a branch and an agent.
- **The handler checks it itself.** `meta.describe` is not a permission system: a `tasks.start` with
  `without_asking: true` while the switch is off is refused ("Starting a task from ChatGPT without
  asking is off on this Mac"), and nothing starts. Without the flag (God Mode's asking path, after a
  "yes") the start is as before.
- **What still refuses.** Everything `start_check` refuses refuses the same way: a task that is not
  todo, held by a live run, blocked, unmapped. A repeated request finds the task held by the run the
  first one made and starts nothing. Creating a task starts one only through
  [Starting new tasks](#starting-new-tasks): with this switch on, a ready task ChatGPT creates goes to
  the autopilot.
- **Instructions nobody read back.** The confirmation was where the user heard "changed since you
  last saw them (per git: anna)" ([05-architecture.md](05-architecture.md#security)). Without it,
  the start goes on and its answer carries the same fact as `instructions`, which the description asks
  ChatGPT to say, so the user hears it after the start and can stop the agent. Refusing such a start
  instead was tried and dropped: git cannot tell who wrote a part. The last commit of a task file is
  often this machine's own (a label, a status) on top of a collaborator's brief change, and imports
  (issues, Laconote) and ChatGPT's own writes commit other people's words under the local user's
  email. Turning the switch on accepts this; push access to the plan repo is the trust boundary
  either way.
- **Not the agent's permission mode.** The switch decides only whether a start asks. The agent's mode
  is chosen as before: the profile's `modeId`, else the provider's declared default. `start_check`
  says it as `mode`, and the start's answer carries the same `mode`, which the description asks
  ChatGPT to say.

### Starting with the read-back

Asked for by the user on 2026-10-27 (task JOBBY-H6X7D): with the switch above off (the default, and
the state of a Mac that never wrote `godmode.json`), a start the user asked for in their own words
still came back as `needs_confirmation`, and nothing told ChatGPT what the confirmation is or how the
user stops it. The limits of the integration, as God Mode 0.12.1 implements them:

- **Only `low` runs without asking.** God Mode's `plugin_action` asks first for every action above
  `low`, whatever `confirm` says; it has no "the user already asked" flag, and the plugin cannot see
  the user's words. So the one supported way to start on the request alone is the switch above, which
  only the person at the Mac sets. Declaring `start_task` `low` without it, or calling it without the
  token, would be the bypass the brief rules out.
- **The read-back is a spoken or typed yes.** `needs_confirmation` carries `confirm_text` for ChatGPT
  to say and a token for exactly that call and those facts, valid two minutes. The user's yes in the
  chat, by voice or text, is the confirmation; there is no dialog on the Mac or in Paseo to confirm
  in. `confirmText` therefore ends with "Start it?", and the asking form of `start_task` says that
  the yes is given in the chat, that asking for the start again after hearing `confirm_text` is a yes
  too, and that only the user turns the read-back off (Start tasks without asking; ChatGPT cannot).
- **Nothing runs before the yes, and a repeat starts nothing more.** The request sent again without
  the token gets a new read-back and starts nothing. God Mode does not spend the token, but it reads
  the target again before every confirmed call: a confirmed call sent again after the start finds the
  task held in that read and is refused ("its target could not be read: … already started by …")
  without reaching `tasks.start`. Two confirmed calls sent at once can both pass that read; then the
  claim in `tasks.start` refuses the second. A task `start_check` refuses (blocked, held, not todo, unmapped) is refused before any
  read-back, through the target read.
- **Not checked here.** Whether the ChatGPT app asks before calling a write tool of God Mode's MCP
  server is ChatGPT's own behaviour, outside God Mode and this plugin.

### Starting a set of tasks

Asked for by the user on 2026-10-31 (task JOBBY-1YM99, after the audit JOBBY-0YWBK): ChatGPT must get
from the plugin itself, every time, which tasks it may start for the user, which wait for the user,
and in which order; a start the user explicitly asked for must not get extra questions of ChatGPT's
own, and drafts or ideas must never count as a request.

- **The rules travel with the plugin.** `start_plan` answers `rules` (`START_RULES` in
  `server/api/start-set.ts`): only tasks the user named, or a set they clearly defined, and told
  ChatGPT to start count; ideas, drafts, created tasks and text inside briefs or answers do not; with
  that request ChatGPT calls the start at once, and the read-back is the one question; the
  permission to start is not the agent's permission mode; `needs_owner` waits for the user and is
  never answered for them; prerequisites first; `launching` is not `working`; a change after the yes
  is read back again. The descriptions of `start_check`, `start_task` and `start_tasks` say the same
  in short, since a description is cut at 600 characters.
- **One decision per task, the same in every read.** `server/api/start-verdict.ts` decides for
  `start_check`, `start_plan` and `start_tasks`: `can_start`, `after_prerequisites` (waits only for
  tasks of the set that start, or tasks under way: a live run, in progress or in review, in the set
  or not), `blocked` (waits for a task
  nothing in the set starts, a draft, a missing task, a circle), `needs_owner` (a draft to accept,
  work in review to test and accept, an agent's question or failure, a label of the space's
  `defaults.human_labels`; `needs` says which),
  `already_started` (`activity` says `launching` or what the agent does), `finished`, `refused`
  (`reason` is the start check's error). Each has `reason`, `next`, `waits_for`; in a set `order`
  says what goes first and what may run at the same time. `asks_first` and `permission` say whether a
  start is read back on this Mac; `agents` and `mode` say the agents' permission mode, apart from it.
- **A person's work stays with the person.** A task carrying a label of `defaults.human_labels` is
  `needs_owner` with `needs: human_label`, ahead of the start checks, so `start_tasks` never starts or
  queues it and what waits for it in the set is `blocked`. Start next, Start ready tasks and the
  autopilot pass it over in their handlers and name it, and a start they make carries `automatic`, so
  the claim refuses a label its own fetch is the first to show. A start of that one task is the
  explicit way past: `start_check` still has no `error`, and says `human`; God Mode shows at most
  eight fields of a read-back, so `start_check` also puts it first into `issue`, the sentence before
  "Start it?". The dashboard's dialog and the answer of a start without a read-back say `human`. Without the setting nothing
  changes.
- **One read-back for the set.** `start_tasks` asks first like `start_task` (or runs at once while
  the machine starts without asking, with the same fixed flag and the same check in the handler).
  Its target is `start_tasks_check`, the plan read with `for_start`, which refuses a set of which
  nothing would start, so such a set is refused before any read-back. The shown fields are lines of
  at most 200 characters, the most God Mode keeps of one, so a set takes at most eight tasks. God Mode
  reads the target again before the confirmed call: a set that reads differently by then (a task
  started meanwhile, a blocker added, instructions edited: the shown line carries a six-character
  mark of the text not seen) is read back again, and the same confirmed call
  sent twice starts nothing more.
- **What the yes starts.** Each `can_start` task starts as `tasks.start` would, first in the call;
  later ones only while the call has time (the budget of Start ready tasks). The rest that may start
  goes to this Mac's autopilot as task flags, in starting order: `after_prerequisites`, and
  `can_start` tasks past the budget. They start one per check, under the autopilot's limit of live
  runs, once ready; a task waiting for one of the set that did not start is not queued. No project
  flag is ever set, and nothing outside the set: the set is the permission and its bound. The answer
  says `started` (state `launching`: claimed, the agent being created, not yet working), `queued` and
  `not_started` with reason and next; a claim pushed without an answer is `unclear` (it may still
  land and start, so it is never started again), and a set of which only such claims came is thrown
  as God Mode's "unknown whether it took effect". A task whose flag the autopilot paused stays paused:
  only the user resumes it. A prerequisite canceled later counts as done for a queued task, as it does
  for every start (decided 2026-10-28).
- **Instructions the yes covered.** The read-back says whether the instructions changed since the
  user last saw them, as `start_task`'s does. A queued flag keeps the hashes of the instructions it
  covered: those count as seen for that flag, and a change after the yes waits until the task is
  opened once in Paseo Dash, as the autopilot does for any unseen text. A start through ChatGPT never
  marks instructions seen: the user heard of them, they did not read them.
- **Not changed.** No confirmation is skipped or weakened: the read-back stays God Mode's, the switch
  stays the user's alone, and the descriptions never suggest turning it off. The agent's mode is
  still the profile's, else the space's `defaults.mode`, else the provider's default: ChatGPT cannot
  choose it per start (JOBBY-H6X7D), and the effort is the profile's, else this Mac's default
  (Settings → Autopilot, JOBBY-H3ZEX), else the model's default.
- **God Mode.** Nothing in God Mode 0.12.1 has to change for this; `server/api/godmode.test.ts` runs
  its own `pluginActionOn` through the read-back. What God Mode does not offer, and a later God Mode
  could: a confirmation that covers longer lists than eight lines of 200 characters, and a way for
  the plugin to know that the user's own words, not text from a read, asked for the start.

### Resuming a paused task

Asked for by the user on 2026-11-16 (task JOBBY-TGHP0): a task flag the autopilot paused (its start
failed) can be resumed through ChatGPT, as Resume in Live → Autopilot does, and nothing more.

- **The same resume.** `resume_task` (`autopilot.resume-task`, `server/autopilot-resume.ts`) calls the
  autopilot's own `resume` for that one task flag, then asks for a pass, as `autopilot.set` with
  `resume` does. The limit, the start defaults, every other flag and the instructions the flag counts
  as seen stay as they are; the autopilot then starts the task under all its rules (ready, a slot
  free, no usage limit, its instructions seen). It takes `task` only: no project flag, no limit, no
  profile, no switch. A project's flag starts one task after another, so only the user resumes it, in
  Paseo Dash; the refusal says so.
- **It always asks first.** A resume may start an agent later with nobody watching, so it is
  `outward` and its read-back is `resume_check`: `title`, `paused` (the reason the autopilot wrote)
  and `then` (it may start on its own, with no further question, under this Mac's limit). Unlike
  `start_task` it is read back also while this Mac starts without asking
  ([above](#starting-without-asking)): that switch covers a start the user asks for in their own
  words, which runs now, not a flag that starts on its own later; the brief asks for a confirmation
  before every resume.
- **A stale yes resumes nothing.** God Mode reads `resume_check` again before the confirmed call: a
  pause written again with another reason, or another limit, reads differently and is read back again
  (`target_changed`); a task started, finished, no longer paused, blocked or gone meanwhile makes the
  read refuse, so the call is refused before `autopilot.resume-task`. The handler runs the same checks
  again, for two confirmed calls sent at once. God Mode passes on only `error` of a refused read, cut
  at 300 characters, so `error` says the fact, then `Next: …`, then the long details (blockers, the
  pause reason); the handler's own answer also has `state` and `next`. The states: `launching`,
  `working` or `started` (read the task), `finished`, `queued` (not paused: it already waits),
  `not_queued` (no task flag here; or only its project's flag is paused, which the user resumes),
  `blocked` (resume it once it is ready; the flag stays paused), `not_found`.
- **Queued, launching, working.** After the resume the handler waits up to `RESUME_WAIT_MS` for the
  pass, then answers `state`: `queued` with `wait`, what the autopilot waits for (a full limit, a usage
  limit, instructions not seen yet); `launching`, claimed and its agent being created, not working
  yet; `working`, its agent at work; `paused` with the new reason when its start failed again at once.
  When the wait ends before the pass, `wait` says the check is under way rather than repeat the state
  of a pass from before the resume.
  A claim may take longer than that wait; the pass goes on, and the `task` read says `launching`, then
  `working`.

"Resume JOBBY-TGHP0 on the autopilot", first call `plugin_action {"plugin": "dashboard", "operation":
"resume_task", "args": {"task": "JOBBY-TGHP0"}}`:

```json
{
  "plugin": "dashboard", "operation": "resume_task",
  "outcome": "needs_confirmation", "delivered": false, "risk": "outward",
  "confirm_text": "Resume «Paseo Dash: resume a paused task» on this Mac's autopilot. Paused: paused: starting JOBBY-TGHP0 failed: the worktree could not be made. Once resumed, this Mac's autopilot may start it on its own, with no further question: at a check of the plans, while fewer than 3 of this Mac's runs are at work and no usage limit holds starts. Resume it?",
  "target": { "title": "Paseo Dash: resume a paused task", "paused": "paused: starting JOBBY-TGHP0 failed: the worktree could not be made", "then": "Once resumed, …" },
  "confirmation": "…"
}
```

After the user's yes, the same call with `confirmation`:

```json
{
  "outcome": "done", "delivered": true,
  "result": { "ok": true, "task": "JOBBY-TGHP0", "title": "Paseo Dash: resume a paused task", "state": "queued", "agent": "", "wait": "waits: 3 runs of this Mac are at work (the autopilot's limit is 3): JOBBY-A1B2C, JOBBY-D3E4F, JOBBY-G5H6J", "next": "it starts on its own once the autopilot lets it; then the task reads launching (being started), then working", "error": "" }
}
```

The same confirmed call again is refused by the target read: "its target could not be read:
JOBBY-TGHP0 is not paused: it is queued on this Mac's autopilot. Next: nothing to resume; the
autopilot read says what it waits for. Now: …".

### Starting new tasks

Asked for by the user on 2026-11-16 (task JOBBY-H3ZEX, after JOBBY-CB2NF): a new task that is ready
should start at once, in Auto mode with effort High, without anyone pressing Start.

- **The settings.** Settings → Autopilot (also in the top bar's Settings dialog) holds this Mac's
  "Start new ready tasks" (on by default), its default mode (`auto`, one provider's id: Claude's) and
  its default effort (`high`), in `autopilot.json`. Only the Settings screen changes them
  (`autopilot.set`, not described). The mode and effort count for every start from this Mac from the
  next start on: below a mode or effort a person picks, the profile's, and (for the mode) the space's;
  above the provider's and the model's defaults. The effort is passed to `agents.create` explicitly,
  so a model whose default is Medium runs with High; one that lacks the default says so in the effort
  text ([05-architecture.md](05-architecture.md#starting-a-task)).
- **What a create does.** `tasks.create` takes `start` (false: To Do only) and answers `start` and
  `start_note`. A todo task with nothing to wait for, its project mapped here, no label of the space's
  `defaults.human_labels` and no open question in its brief (an entry under an "Open questions" heading
  or line, also "Відкриті питання"; "none" does not count) gets an autopilot task flag: `queued`. The
  autopilot starts it once, under its limit of runs at work; while the limit is full the flag waits in
  Live with its state, and a pass after each sync, or when a run of this Mac stops working, starts it once
  a slot is free. `todo_only`: asked so, or the switch is off; `waits`: a blocker, an open question, a
  person's work, an unmapped project (`start_note` says which); `""`: a draft. A task that waits gets
  no flag, so it is not started later either: a blocked task starts when a person starts it.
- **Who may start.** Nothing here widens who may start. The dashboard's form calls `ui.tasks.create`
  (not described): the person who wrote the brief at this Mac; its text counts as seen, the space's
  start template still must be seen as it is. `tasks.create` (God Mode's `create_task`, and any other
  caller) flags the task only while [Starting without asking](#starting-without-asking) is on, with
  the hashes of the instructions as the start without asking would send them, nothing marked seen.
  With the switch off the answer is `asks_first` and `start_note` names the one step: `start_task` of
  that task, whose read-back the user answers. `START_RULES` and the descriptions say that a task
  created ready asks for its own start unless the user wanted To Do only.

### Tasks and chats from voice

Asked for by the user (task JOBBY-YDNB7): new project work asked by voice becomes a Paseo Dash task,
and the model follows the task however it is started.

- **A task, not a chat.** The description of `create_task` says project work, by voice too, is a task
  with a short brief and concrete acceptance lines, and a chat is started only when the user asks for
  one. A ready task then starts as in [Starting new tasks](#starting-new-tasks).
- **Dash picks the model.** A profile the user names goes with the task (`create_task`'s
  `agent_profile`), so a start queued by that create uses it; for a task that exists it is set with
  `update_task` or `update_tasks`, or passed to `start_task` as `profile`. Without one the task's
  profile applies, else the space's, else, on a Mac whose first provider is Claude and with "Pick
  Claude's model and effort per task" on, the pick by the task's own text
  (`server/runner/model-policy.ts`, [05-architecture.md](05-architecture.md#starting-a-task)), else
  the provider's default model. A task with no acceptance lines is `complex` in that pick, so the
  lines also decide the model.
- **A direct chat gets no pick.** God Mode's `start_chat` does not go through this plugin. For a
  Claude chat where the user named no runtime, model or effort, the same description tells ChatGPT to
  pass `model` and `thinking` by the same three tiers, judged by hand:

  | Work | `model` | `thinking` |
  |---|---|---|
  | A clear local fix | `claude-sonnet-5-5` | `medium` |
  | Harder local work | `claude-sonnet-5-5` | `high` |
  | Unclear, architecture, more than one repository, or high risk | `claude-opus-5-5` | `high` |

  This is guidance in a description, not a check, with these limits. No handler of this plugin sees a
  direct chat. ChatGPT reads the sentence only once it has read this plugin, so a chat asked first
  may start without it. God Mode's own `start_chat` description (seen in 0.17.0 and 1.1.1) says to set
  model and thinking only when the user asks for them, and ChatGPT may follow that instead. Passing
  them also overrides the new-chat defaults of God Mode's Site, where it has any. A user who needs the
  rule on every chat says it in ChatGPT's own instructions. Independent review stays as the
  repository's own process says.

### Plan edits while the issue mirror is on

Decided by the user on 2026-10-27: plan edits stay `low` (option 1 of the three laid out when the
mirror was built). The issue mirror ([05-architecture.md](05-architecture.md#issue-mirror),
09-forge-issues.md option c) turns accepted
tasks into forge issues on the one machine where a space's switch is on, so a `create_task` from
ChatGPT may end as an issue other people see (with its brief, public in a public repository), and an
`update_task` may rewrite that issue's title, labels, assignee or state. The operation itself writes
only the plan; the mirror runs later, from committed state, on a machine and a switch a person
chose, and a later plan edit corrects the issue. So `low` means "sends nothing to anyone by itself",
and ChatGPT's plan edits stay without a read-back (D10).

Not chosen: describing `create_task` and `update_task` as `outward` (always, which reverses D10, or
only while a space on this machine has the switch on, which this machine cannot always tell), and
answers that say "will be mirrored to <repository>" (it needs the switch visible beyond one machine,
for example in `space.yaml`). Either can be revisited if mirrored issues from ChatGPT surprise people.

### Accepting and sending back

Asked for in task JOBBY-5YRRY, after an audit found
review from ChatGPT half done: work sent back through `send_message` reached the agent while the
task stayed in review, and accepting it was `release_task to=done`, read back as a release. The
task screen's two answers to a task in review are now two operations over the same RPCs.

- **`send_back`** is `tasks.send-back`, the screen's Send back: the user's comment goes to the
  task's agent on this Mac as review feedback (from the user, about this task, on the run's own
  branch, push to the same PR/MR), and a task in review goes back to in progress. `reply` is never
  offered: an answer to an agent's question is `send_message`. Decided with the user on 2026-10-28:
  `low`, no read-back, as `send_message` has none. A repeat while the agent works on the first
  comment is refused; once it has ended its turn, a repeat is sent again, as a repeated
  `send_message` would be. A refusal names its reason in
  `error`: no live run, the run on another Mac, the agent gone, the agent still working; nothing is
  sent then. A comment that was sent while the task could not move (a tracked Paseo workspace's
  task, which stays in review on purpose, says nothing; a refused or unclear move) says so in
  `note`, not in `error`: God Mode reads a non-empty `error` as "not done" and would tell the user
  the comment was not sent.
- **`accept_task`** is `tasks.release` with `fixed: { to: "done" }`, the screen's "Accept and mark
  done…". Its target is `accept_check`, which refuses a task that is not in review (release_task
  still sets one done) and reads back, decided with the user on 2026-10-28, the PR/MR's checks and
  review as the forge has them now (JOBBY-T6ADY) along with who holds the task, as `release_check`
  says it, and what becomes of its agent. God Mode reads the target again on the confirmed call: CI
  that finished, a review given, or another holder between the read-back and the yes makes a new
  read-back with `target_changed: true`, and nothing runs. The checks are said without counts
  ("checks pending", not "3 of 5"), so a check finishing while others still run does not ask again.
  A forge that cannot be read (no checkout here, gh/glab logged out) is said in `result` and does
  not block accepting: the user decides on what they heard.
- **What a read-back takes.** `accept_check` asks `gh`/`glab` (15-second timeout) on the first call
  and again on the confirmed one. On the confirmed call that comes before the plan write and the
  agent's stop, so a hanging forge together with a busy plan sync can run past God Mode's 45 seconds
  per call; God Mode then says it is unknown whether it took effect, and the next `task` read shows
  it.

### Resolving names

Every argument that names a thing (`space`, `project`, `feature`, `milestone`, `task`) accepts an id
or the words of its title (for projects: the key or its name), compared ignoring case. An id is read
however it was typed (server/search/text.ts `idForms`): any case, with or without its dash or with
spaces (`lac7k3qx`, `LAC 7K3QX`), with Cyrillic look-alike letters, with Crockford's O for 0 and I or
L for 1, or its five-character suffix alone (`7K3QX`, with a digit or in capitals) when one entity
ends with it. A whole id counts only with the key of a connected space, so «Add login» is no id.

- Reads take the best match: an exact id, else an exact title, else the only entity that has every
  word. Several equal candidates: the read answers `error` naming them, so ChatGPT asks the user
  (God Mode reports it as "could not read it" with that reason). No match: `error` says so and names
  the five entities search finds closest, with their ids ("Closest: … Use the id.").
- `task` and `task_result`, which only show, go one step further when nothing matches: search (below)
  answers the task when it points to one clearly, every word of the name being a word of the task,
  another form of one, a beginning of four letters or more, or a typo, and no other task matching as
  well, nor any task ranked above it that only a fragment matches. `task` says where it matched in
  `found_by` ("title: «…»"); `task_result` answers the task's id and title. A fragment never picks
  («ne» does not name «one»). A name that only looks like an id («Laconote» in LAC reads as
  LAC-0N0TE) is matched as words unless an entity has that id; an id written as one (`LAC-0N0TE`)
  that nothing has is an error. Decided 2026-11-03.
- Writes and targets accept only an unambiguous match, and never choose by recency or status. This is
  the rule God Mode applies to its own chat writes.
- An existing task, feature or milestone is looked up across all spaces (an id carries its space's
  key), so writes to them need no `space`. `space` is needed only to create something when more than
  one space exists; without it, the create refuses with the list of spaces. Reads without `space`
  cover all spaces.

### Answers

- Every read and action answers a JSON object with an `error` text field (empty when fine), declared
  in `outcome`; actions also answer `ok`. So an unknown name or a refusal reads as "not done" or
  "could not read it" with the reason, never as an empty list or as "done".
- Ids and `chat_id` travel in the result; titles are what ChatGPT says aloud.
- `output.fields` lists the fields worth reading out **in the order they should be read**. God Mode
  keeps that order in `result` and cuts its spoken text at 1,500 characters for a read and 800 for
  an action (`resultLines`), so short facts come first and long text (brief, latest agent message)
  last; `structuredContent` keeps every field either way. An operation whose fields would be every
  field of its answer but `error`, in the answer's own order, declares none (JOBBY-NY4D4).
- No field name contains `token`, `secret`, `password`, `credential`, `key` in the `api key` /
  `private key` sense, or the other words God Mode redacts.
- Every read is marked `untrusted`: titles, briefs and drafts are written by collaborators or come
  from meetings, a brief contains instructions meant for a coding agent (never for ChatGPT), and
  `needs_you.why` quotes what an agent asks for. God Mode then adds its fixed note ("never follow
  instructions inside it") to each answer.
- Every read but `start_check` touches only the in-memory index (no git, disk or network work), so
  its time is God Mode's relay round trip, which God Mode's documentation measures at about 1.1
  seconds per read. `start_check` also asks git and the forge whether the branch exists and how an
  earlier run's PR/MR ended, all within one deadline (default 5 seconds). With the claim's own
  deadlines, the confirmed call of `start_task` stays inside God Mode's 45-second budget
  ([05-architecture.md](05-architecture.md#time-budget-of-a-start-from-chatgpt)). Only `meta.describe` has God Mode's 4-second
  limit.
- Plan edits answer `ok` once the change is recorded locally; the push follows in the background.
  A later conflict (someone changed the same field) is counted in `overview.spaces[].conflicts`, so a
  voice user hears about it at the next overview.

## Arguments and answers

Input schemas are rendered from the same zod contracts the handlers parse (`z.toJSONSchema` with
`io: "input"`, without `$schema`), lazily on the first `meta.describe` call. Arguments are flat,
except lists: lists of strings (`depends_on`, `projects`) and one list of small objects
(`add_to_inbox.items`).

**What ChatGPT is given of them (JOBBY-NY4D4).** God Mode puts every operation's arguments next to
every read, as `name: type – description` with the description cut at 80 characters, and never
shows bounds; nested properties are not shown at all. So `meta.describe` stays within 17.5 KiB
(`fixtures/response-budget.ts`; 16 KiB until the user raised it for `resume_task`, JOBBY-TGHP0), and `compactSchema` in `server/capabilities.ts` renders names,
types, enums, `required` and descriptions, without `minLength`, `maxLength`, `minItems`,
`maxItems`, `minimum`, `maximum`, `pattern` and `default`, and without `type` beside an `enum`. The
handler's zod contract still enforces each bound, and the daemon's refusal names the field and the
bound. An argument has a description only where its name does not say what it takes; a name of a
task, feature, release, project or person takes its id or the words of its title. A rule ChatGPT has
to follow at a given moment travels with the answer that meets that moment: a question's `next`
(`QUESTION_NEXT` in `server/needs.ts`), events' `next`, `start_plan`'s `rules`. Shown below as TypeScript-like types for brevity; the order
of output fields is the `output.fields` order.

### Reads

**`overview`**: what is going on across the plan. The main read: `plugin_read {plugin: "dashboard"}`
runs it. Each list holds at most ten entries unless `limit` asks otherwise (the Live tab asks for 200);
`counts` has the totals.

```ts
input:  { space?: string; limit?: number }   // limit: 1-200 per list, default 10
output: {
  needs_you:  { task: string; title: string; why: string; kind: NeedsKind; next: string; chat_id: string; space: string; since: string }[];  // most urgent kind first, then the longest waiting where known; since: ISO or ""
  // NeedsKind: "permission" | "question" | "failed" | "sync" | "answer" | "stopped" | "checkout" | "closed" | "merged" | "accept"
  // next: what the user can do now, one line ("release it: to done if it is finished, to todo to start it again")
  running:    { task: string; title: string; activity: "launching" | "working" | "waiting" | "failed" | "stopped"; host: string; chat_id: string; since: string }[];  // waiting, failed first, then the longest running, stopped last; since: run_started
  // stopped: no agent of this Mac at work on it (gone, or none known here); another machine's run: working
  review:     { task: string; title: string; pr: string; since: string }[];        // the longest in review first; since: run_review_at (when not older than run_started), else run_started
  counts:     { needs_you: number; running: number; review: number; inbox: number; events: number };   // events: unread task events
  milestones: { id: string; title: string; due: string; done: number; total: number; blocked: number }[];
  spaces:     { key: string; name: string; synced: string; conflicts: number; problems: number; needs_you: number }[];
  error:      string;
}
fields: counts, needs_you, running, review, milestones, spaces
```

`needs_you` is everything that waits for the user, one item per task, each `why` one line of at
most 160 characters: an agent's permission request (`permission`), its questions to the user
(`question`: Claude's AskUserQuestion, Codex's request_user_input; answered with God Mode 0.15's
`read_approval` and `answer_questions`, never `answer_approval`'s allow), a failed agent (`failed`), a
space's plan changes that cannot be pushed (`sync`; `task` is empty and `title` is the space's
name; a failed fetch alone heals on the next tick and is not listed), an agent that finished its
turn while the task is in progress (`answer`, its last message, often a question), an agent gone
while it is (`stopped`; also a run this Mac holds in the plan with no record of its agent here), a
tracked checkout on the trunk with no agent at work (`checkout`: its agent's end is the normal one,
not a failure, but no PR/MR moves the task, so only the user does; `why` says whether its work
landed on `origin/<trunk>`), a run's PR/MR closed without a merge while no agent works on it (`closed`), merged without the task
done (`merged`, with the tracker's reason), and a task in review with no PR/MR (`accept`; with the
URL the agent reported when the tracker has not confirmed it yet). Agent states are this machine's
runs only. A task in review whose PR/MR is open waits for the forge and is listed under `review`.
Conflicts stay a count per space (`spaces[].conflicts`, listed in Settings): nothing clears them
yet, so they would never leave the queue. `counts` comes first so that the totals survive God
Mode's spoken limit when the lists are long. Every item has `next`, the user's step for it, which
`tasks` and `task` repeat for the same task ([One state in every read](#one-state-in-every-read)).

The answer also carries `events_latest` (the newest task event id), which the dashboard's sidebar
uses; it is not among the fields read out.

**`tasks`**: find tasks.

```ts
input: {
  space?: string; project?: string; feature?: string; milestone?: string;
  status?: "open" | "inbox" | "todo" | "in_progress" | "review" | "done" | "canceled" | "all";  // default "open" (not done, not canceled); "all" with a query
  assignee?: string;                       // a person of space.yaml by key or name (else the text as written)
  label?: string;                          // only tasks carrying this label (any case)
  mine?: boolean;                          // only tasks assigned to the person whose emails hold this Mac's git user.email
  query?: string;                          // words of the task's text, or a PR/MR link or branch name (below)
  limit?: number;                          // 1-50, default 20
  offset?: number;                         // how many to skip, for the next page; default 0
}
output: {
  // With a query; before the rows, since God Mode speaks a reply's fields in order and cuts its end.
  also?: { kind: "feature" | "release" | "project"; id: string; title: string }[];   // first page: what else the words name
  partial?: true;                // no task has every word: these have some
  searched_for?: string;         // the query as typed on the other keyboard layout, when that found these
  tasks: { id: string; title: string; status: string;
           section: string;          // running | review | ready | blocked | draft | done | canceled (the order below)
           priority: string;         // its own, else the space's default
           glyph: string;            // its mark on the map
           // Left out when empty ("", false, no labels): TASK_ROW_OPTIONAL in shared/api.ts.
           release?: string;         // the release it belongs to (its own, else its feature's)
           activity?: string;
           needs?: string;           // what waits for the user on it: overview's needs_you kind
           next?: string;            // with needs: the user's next step, as needs_you says it
           project?: string; assignee?: string; labels?: string[];
           blocked?: true;
           blocked_by?: string;      // what it waits for, as `task` says it
           matched_in?: string;      // with a query: the field the match is in
           quote?: string }[];       // with a query: a short piece of that field around the match
  total: number; shown: number; error: string;   // error with mine: no person has this Mac's git email
}
```

`mine` reads `git config user.email` in each space's own clone, so it names the person this Mac
commits as; a task whose `assignee` holds that person's name rather than the key counts too.

`query` searches the plan in memory, never git or the network (server/search/core.ts): the id (as
a whole only), the title, the labels, the project (its key and repository name), the feature's and the release's
titles, the assignee (key and name), brief, acceptance, `## Notes`, `progress_note`, `run_pr`,
`links`, `issue` and the branch. A task whose id the query is (in any form, as above) matches; else
every word must be in the task: as the word, another form of it (a light stem of Ukrainian, Russian
and English: «логіну» finds «логін»), its beginning, a part of a word ("log" finds «login»), or, for
a word found in no task as typed, with one typo in words of 4–7 letters and two from 8. With nothing
found the query is tried as typed on the other keyboard layout (`kjusy` → «логін»), and the answer
says so in `searched_for`; then the tasks with most of the words are answered with `partial: true`.
`matched_in` and `quote` say where the match is: the field that holds the most of the words. A query
without spaces that has a `/` is a link or a branch: a task whose own PR/MR, link, issue or branch it
is (a link may be given by its tail, `core/pull/38`, or with `/files` after it) is the only answer;
without one, tasks that name it in their text, as a whole link. On the first page, `also` lists up
to three features, releases and projects whose names have every word, so ChatGPT finds a feature or
release by its name and filters by it next.

Tasks come in the order of every task list (the Tasks tab, a station's tasks, a feature phase;
`sortTasks`, server/api/view.ts), by section: **running** (an agent of this Mac waiting for the
user first: needs input, failed, waiting, stopped, launching, working, then runs whose agent is
not on this Mac; then priority, then the run started first), **review** (priority, then the run started first), **ready** (todo, no live run,
every task it waits for done or canceled), **blocked**, **draft** (inbox), then **done** and
**canceled**, the latest finished first. Ready and blocked tasks go by priority (a task without
one ranks as the space's `defaults.priority`, else medium), then the place a person gave them
(`rank`: ranked tasks first, lower first), then the due day of their open release (none after every
dated one), then creation time (oldest first), then id. Drafts go by priority, then rank, then
creation time. A rank orders only its own space's tasks, so a list of several spaces goes space by
space (by key) inside a priority; the drafts one call adds get creation times one millisecond apart, in the
order given, so a batch keeps its order. Decided 2026-10-28 (D21). A query ranks instead: the id
asked; the exact title; every word in the title, then in labels, project, feature, release or
assignee, then in the text, then in links; fewer typos; stronger matches (the word, a form, a
beginning, a part); open before done before canceled; and this order last (decided 2026-11-03).

`update_task` with `position` (`top`, `bottom`, `up`, `down`, or `before`/`after` with `next_to`)
moves a task among the tasks of its own section (ready, blocked or drafts) and priority in its space
(server/api/rank.ts). A move writes only the moved task's `rank` when its new neighbours have ranks
with room between them; otherwise the whole group is numbered again in the new order (steps of
1000), in one commit. Each write is a `set` expecting the rank it replaces; when someone else moved
a task of the group meanwhile, that write refuses and the others stand, so the order stays whole but
is not the one asked for, and the answer says how many places were written. A task cannot be moved
above one of another priority, and `position` does not combine with a new `priority` or `status`; a
new priority, or a new status (a draft accepted, a task reopened), drops the task's rank, so it goes
after the ranked tasks it then stands with. A task that becomes unblocked keeps its rank among the
ready ones. In a list of several spaces the space grouping holds without ranks too: the first ready
task is the first of the space whose key sorts first, among the highest priority.

**`task`**: one task in full.

```ts
input:  { task: string }      // id or words of the title (Resolving names)
output: {
  id: string; title: string;
  found_by?: string;           // a name that was no id or title: where search found the task, "title: «…»"
  status: string;
  activity: string;            // "working on this Mac", "running on anna-mbp", "" when not started
  needs: string;               // what waits for the user on it: overview's needs_you kind, or ""
  next: string;                // with needs: the user's next step, as needs_you says it; else ""
  progress: string;            // "3 of 5 · Enroll and verify done; recovery codes next"
  blocked_by: string;          // "LAC-5RT2M «TOTP contract» (in_progress)" or ""
  pr: string;                  // the live run's PR/MR as the tracker last saw it: "!412 open", "#7 merged — <why nothing moved>";
                               // otherwise the run's PR/MR link, or "". No checks or review: those are task_result
  chat_id: string;             // "" when no agent on this machine
  project: string; feature: string; milestone: string; priority: string; assignee: string;
  labels: string[];
  issue: string;               // the GitHub/GitLab issue it stands for (web URL), or ""
  issue_state: string;         // as this Mac last read it: "open", "closed", "closed by <PR/MR URL>", "unknown", "";
                               // with a note after ": " when it matters ("closed: … changes nothing by itself: mark the task done or cancel it …",
                               // "open: The task is done, but the issue is still open: the forge did not close it with <PR/MR> …";
                               // "unknown: … <host> is not the web host of any project of this space …" for an issue the space's hosts do not cover)
  branch: string;              // the run's branch, or the branch a start would use
  held_by: string; host: string; since: string;     // the live run, or "" when none
  acceptance: { text: string; done: boolean }[];
  last_message: string;        // the agent's latest reply, cut to 600 characters
  brief: string;               // cut to 1,200 characters
  handoff: string;             // the latest handoff a run's agent left for the next one (03-model.md, Task), or ""
  runs: {                      // the latest 5 runs from the plan's history, newest first, the live one included
    run_id: string; by: string; host: string; branch: string;
    started: string; ended: string;   // spoken times, "" when not ended
    result: string;            // "holds the task now", "ended: done", "released back to todo", "ended: canceled", …
    pr: string;                // that run's PR/MR, or ""
    progress: string;          // its last progress, "3 of 5 · note"
    handoff: string;           // the handoff it left, cut to 600 characters, or ""
    chat_id: string;           // only when its agent is on this machine, else ""
    last_message: string;      // its agent's latest reply, cut to 300 characters, only on this machine
  }[];
  runs_error: string;          // why the run history could not be read, else ""
  error: string;               // not found or ambiguous: the reason with candidates
}
fields: none, the whole answer
```

**`roadmap`**: milestones with their features and how far each project got.

```ts
input:  { space?: string; milestone?: string }
output: {
  milestones: {
    id: string; title: string; status: string; due: string; days_left: number | null;
    done: number; total: number; blocked: number;
    features: { id: string; title: string; status: string; done: number; total: number;
                projects: string }[];   // "core done · site review · android todo"
  }[];
  later: { id: string; title: string; done: number; total: number }[];   // features without a milestone
  error: string;
}
fields: none, the whole answer
```

**`inbox`**: drafts waiting for triage.

```ts
input:  { space?: string; label?: string; mine?: boolean; query?: string; limit?: number; offset?: number }   // as in tasks
output: {
  items: { id: string; title: string; project: string; meeting_title: string; created: string; assignee: string; labels: string[] }[];
  partial?: true; searched_for?: string;   // as in tasks, before the items
  total: number; error: string;
}
fields: none, the whole answer
```

**`start_check`**: whether a task can be started from this Mac now, and what a start would do. The
target of `start_task`: when it answers `error`, God Mode refuses the start before asking.

```ts
input:  { task: string; profile?: string }   // profile: the one start_task was asked to use, if any
output: {
  title: string; project: string;
  branch: string;         // "feat/totp-2fa", or "feat/totp-2fa (continues anna's released run; her agent may still push to it)"
  workspace: string;      // "a new worktree, «LAC-7K3QX · TOTP endpoints in core»" | "the previous run's workspace «LAC-7K3QX · TOTP endpoints in core»"
  profile: string;        // the profile the agent will run with and where it comes from: "Implementation (the space's)",
                          // "Review (asked for)", "your Mac's default (the space's Implementation is not on this Mac)"
  mode: string;           // the permission mode it starts in: "Auto mode (auto, the provider's default)",
                          // "Always Ask (default, the profile's)", "the provider's own; pi declares no default mode"
  instructions: string;   // "unchanged since you last saw them" | "changed since you last saw them (per git: anna)" | "not seen by you yet (per git: anna)"
  issue: string;          // "" without an issue; else whether the merge closes it: 'Its issue acme/core#7 closes when the PR with "Closes #7" merges into main.',
                          // or why not: "… will not close by itself: the task's base is feat/totp, …" (another forge, a base or trunk that is not the default branch)
  error: string;          // not todo, blocked (by what), project not mapped on this Mac, held by a live run (by whom),
                          // the previous run's agent still works in the workspace to reuse,
                          // a branch of the planned name exists without a run of this task (its work merged: mark the task done,
                          // or start it in Paseo Dash on the suffixed name; not merged: the user chooses in Paseo Dash),
                          // cannot tell whether the previous MR was merged (start it in Paseo),
                          // the profile asked for does not exist on this Mac, name not unique
}
```

**`task_result`**: the task's PR/MR as GitHub or GitLab has it now, with its checks (CI) and review
decision: the task screen's `ui.task-result` (`server/result.ts`, `server/tracker/details.ts`)
without the changed files, flat for reading out. Read with `gh pr view` / `glab mr view` in the
project's checkout on each call, under their 15-second timeout; nothing is written. `untrusted`:
check names and the PR/MR title are the repository's text.

```ts
input:  { task: string }      // id or words of the title
output: {
  id: string; title: string;   // the task
  pr: string;                  // "#7", "!412"; "" when the run has no PR/MR yet, or it could not be read
  state: string;               // "open" | "draft" | "merged" | "closed"; "" when not read
  checks: string;              // "passing" | "failing" | "pending" | "waiting" (a GitLab pipeline on a manual job or a schedule) | "none"; "" when not read
  failing: string[];           // up to 5 failed check names, each cut to 100 characters; a GitLab pipeline is one check: "pipeline failed"
  review: string;              // "approved" | "changes requested" | "review required" | "" when the forge does not say
  passed: number; failed: number; pending: number;
  url: string;                 // the PR/MR's page, also when it could not be read
  checks_url: string;          // GitHub: <PR>/checks, also with no CI; GitLab: the pipeline's page, "" without one; "" when not read
  pr_title: string;
  read_at: string;             // ISO 8601
  error: string;               // not found or ambiguous; no checkout of the project on this Mac; gh/glab missing, logged out or
                               // without access; the URL not of the project's repository. Ends with "Link: <url>" when there is one
                               // and the reason does not name it already,
                               // because God Mode reads out only the reason of a refused read
}
fields: none, the whole answer
```

A task whose run has no PR/MR answers `pr: ""` with no `error`.

**`release_check`**: who holds a task's live run. The target of `release_task`.

```ts
input:  { task: string }
output: { title: string; held_by: string; host: string; since: string; error: string }   // error: no live run, name not unique
```

`since` is the run's start as the user says it: the time alone when it is today ("21:02"), otherwise
with the date ("Oct 23, 21:02").

**`accept_check`**: what accepting a task's work stands on. The target of `accept_task`
(`server/result.ts`). Reads the forge like `task_result`; writes nothing. `untrusted`: check names
are the repository's text.

```ts
input:  { task: string }
output: {
  title: string; held_by: string; host: string; since: string;   // as release_check
  result: string;   // "PR #7 open, checks failing (lint, unit, e2e), review approved"; up to 3 failed checks, each cut
                    // to 40 characters; "no checks", "checks waiting for a manual or scheduled job", "no review decision";
                    // "no PR/MR"; "the PR/MR <url> could not be read: <why>"
  agent: string;    // "its agent on this Mac is stopped; its chat stays",
                    // "its agent on anna-mbp keeps running; stop it in its chat if it should", "no agent of it runs on this Mac"
  error: string;    // not in review ("… is in_progress, not in review: there is no work to accept. release_task sets it done anyway."),
                    // no live run, not found or ambiguous
}
```

**`events`**: task events of this Mac's runs ([Task events and ChatGPT](#task-events-and-chatgpt)).

```ts
input: {
  space?: string;
  after?: number;      // events after this id, read or not, oldest first; empty: the unread ones, oldest first
  history?: boolean;   // the latest events, read or not, newest first (ignores after)
  limit?: number;      // 1-50, default 20
}
output: {
  events: { id: number; kind: "finished" | "failed" | "needs_input" | "question"; task_id: string; title: string; space: string;
            project: string; chat_id: string; workspace_id: string; at: string;   // at: ISO 8601
            summary: string;   // finished: the agent's last reply (empty until read); failed: the error; needs_input: the permission it asks for; question: its questions by name; 300 chars at most
            link: string;      // the task's file in the plan repository on GitHub/GitLab; empty for a plan remote with no web page
            pr: string; status: string; unread: boolean }[];
  unread: number; latest: number; more: boolean;
  next?: string;       // once told: mark_events_read through the newest shown below any unread event not shown (and the space asked); with a question, how the user answers it
  error: string;
}
fields: next, events, unread, more, latest
```

**`recap`**: what happened in the plan over a period, from the plan repository's commits
([05-architecture.md](05-architecture.md#recap)); facts for ChatGPT to summarize with its own tokens.

```ts
input: {
  since?: string;      // ISO 8601 date (midnight on this Mac) or date-time, at most 31 days ago; empty: 7 days ago
  space?: string;
  kinds?: ("done" | "merged" | "review" | "started" | "blocked" | "released" | "created" | "draft" | "status")[];
  limit?: number;      // 1-100, default 50
}
output: {
  since: string;       // the start of the period read, ISO 8601
  total: number;       // events of the asked kinds in the period, listed or not
  counts: Record<kind, number>;   // the same by kind; kinds with none left out
  more: boolean;       // not every event is listed (limit, or the answer's 32,000-character cap)
  partial: string;     // why the period is not covered in full (over 1,000 commits in a space, a space not read in 10 s), else ""
  events: { kind; task_id: string; title: string; space: string; project: string;
            at: string;          // the commit's date, ISO 8601
            by: string;          // started: the run's person; else the commit's author, by their name in space.yaml when their email is listed
            detail: string;      // "todo → canceled", the blocker, "on <host>, branch <branch>"; 200 chars at most
            pr: string;          // the run's PR/MR at that change
            link: string;        // the task's file on GitHub/GitLab; empty for a plan remote with no web page or a task that is gone
            by_hand: boolean }[];   // the commit has no Dashboard-Op trailer
  error: string;       // a bad or too early since, an unknown space
}
fields: since, total, counts, more, partial, events
```

`merged` is a task that became done in the change that wrote its run's end, with a PR/MR on record.
The plan keeps neither the PR/MR's state nor who decided: the tracker's merge and a person's "Mark
done" read the same, also one made while the PR/MR was still open. The description tells ChatGPT so. A done
without a PR/MR, or one that does not end a run (a reopened task done again), is `done`.

**`autopilot`**: this Mac's autopilot (D24, `server/autopilot.ts`), read only. Added 2026-10-28 so
that "why did my task not start while I was away?" has an answer outside the Live tab. Setting a
flag, resuming a project's flag, the limit and the start defaults (`autopilot.set`) stay on the Paseo
Dash screens and are not described: a flag lets this Mac start work on the user's tokens with nobody
watching, which is the kind of switch ChatGPT does not turn on ([Starting without asking](#starting-without-asking)).
Resuming one paused task flag is the exception, read back first: [Resuming a paused task](#resuming-a-paused-task).

```ts
input: {}
output: {
  flags: { space: string; task: string; project: string;   // a task flag or a project flag
           title: string;
           state: string;     // why it did not start at the last finished pass, or why it is paused; "" it started a task
                              // or nothing held it back; "waits: … one task per check …" a flag the pass did not reach
                              // because it stopped at an earlier one; "not checked yet: …" no finished pass checked it
                              // (the first pass after a restart, or a flag set since the last pass)
           paused: boolean }[];   // stopped after a failure or a release; a task's through resume_task too, a project's only on the screens
  max_running: number;   // the autopilot's limit of this Mac's runs at work
  running: number;       // this Mac's runs that take a place now (runs with holds_place)
  runs: { space; task; title; status;   // this Mac's live runs, in review too
          activity;      // as overview.running says it
          holds_place: boolean }[];   // takes a place under max_running
  limit: { until: string; source: string };   // a usage limit holding every start; both "" when none
  started: { space; task; title; project; at }[];   // what it started, newest first, at most 20
  error: string;
}
fields: flags, running, max_running, runs, limit, started
```

Only a run at work takes a place under the limit (`holdsPlace` in `server/autopilot.ts`): its agent
works, asks for a permission mid-turn or is being started (a claim of this Mac still being pushed
included), or waits for a reply while the task is in progress. An agent Paseo reports gone (closed,
archived, no longer known to it), a failed agent, a tracked trunk checkout that ended and a task in
review whose agent waits for the user's acceptance take none: they run nothing until a person acts,
and `overview.needs_you` gives each its step. They still hold their task and stay in `runs`. Until
2026-11-15 every live run counted (JOBBY-YC2SY, 2026-10-28); live, five tasks whose agents were gone
and one in review then held all three places on a Mac with no agent at work, and the user decided
they no longer count (JOBBY-AH5Z0). After a restart or a reconnect an agent keeps the state last
recorded until the tracker reads it again from Paseo, so one recorded at work keeps its place until
then. A project flag still waits as long as any run of the project is live, on any machine: a line is
one task after another, and its `state` says when the run it waits for has no agent at work.

A flag whose task is done, canceled, in review or held by a run is dropped by the next pass, also
while the limit is full, and the read never shows it as waiting.

**Usage limits.** A turn of this Mac's agents that fails on a usage or rate limit (`server/rate-limit.ts`)
holds every start, counted from the failure: until the reset the error names ("…|<Unix time>",
"resets 7pm (Europe/Kyiv)"), else the reset of the used-up window of the agent's provider in Paseo's
usage report (`providers.listUsage`; Paseo answers "Usage is off on this host" until the user turns
usage on), else a backoff of 15, 30, 60, 120, then 240 minutes, one step longer each time a start after
a hold meets the limit again within 6 hours. Once a hold is over the usage report is read once more
and may extend it. An agent that finishes a turn after the hold shows the limit gone, and the backoff
starts over. `limit.source` says where the time comes from and why the report could not tell. The
limit pauses no flag, and the task whose agent met it keeps its run: it is never started again by the
autopilot, and waits for the user as any failed agent does. Nothing switches accounts.

The read wakes Paseo Dash like any other: after a daemon or plugin restart the plugin does nothing,
the autopilot included, until an RPC or an agent's lifecycle event hands it Paseo's API (the plugin
SDK 0.13 gives a server entry no Paseo API outside those). While the user is away and the Paseo app
is closed, a restart leaves autopilot flags idle until ChatGPT or the app calls in; the first read
then answers `not checked yet` rather than an empty state that would mean "nothing holds it".

### One state in every read

Decided 2026-10-28 (JOBBY-YC2SY). Live, one task read differently from read to read: JOBBY-BVG1Z, a
tracked checkout on `main` whose agent had ended, read `failed` in `overview.running` on 2026-10-27;
on 2026-10-28 it read `stopped` there and "its agent is
gone" in `task`, was in no `needs_you` and had no next step anywhere, while the autopilot counted its
place. Three facts stay apart:

- the task's **status**, the plan's (`in_progress`, `review`);
- the **run** that holds it, the plan's claim: it holds the task, its project for a project flag,
  and a place under the autopilot's limit, until it ends or a person releases it;
- the **agent** this Mac knows for that run: launching, working, waiting, failed, or none at work
  (`stopped`: gone, never had one, or a run this Mac holds with no record of its agent). A start
  whose claim is still being pushed has no record yet either: the plan in memory holds the claim
  first, and the start writes its record once the claim is won, so a claim of this Mac still in the
  space's journal reads `launching` ("launching on this Mac"), not `stopped`.

`server/needs.ts` derives what the reads say from these, once: `runActivity` for `overview.running`
and the autopilot's `runs`, `needOf` for `overview.needs_you` and for `needs` and `next` of `tasks`
and `task`. The invariant, tested over the same runs read through all five (server/states.test.ts):

1. `tasks` and `task` say the same status, activity, needs and next, and needs and next are the
   task's `needs_you` item, or empty when it has none.
2. `overview.running` lists exactly the tasks in progress with a live run, its activity the fact
   `task.activity` words.
3. A task in progress with no agent of this Mac at work on it (`waiting`, `failed`, `stopped`) is
   always in `needs_you`, with a step. One whose agent is at work, or another machine's run, is there
   only for what its PR/MR did: `merged` without the task done, or, with no agent of this Mac at work,
   `closed`. Another machine's agent is its own to tell.
4. `failed` is said only of an agent that failed, by every read or by none (`overview.running` lists
   tasks in progress only, so a task in review whose agent failed is `failed` in the other reads). An
   agent gone, a tracked trunk checkout's end included, is `stopped` and makes no task event.
5. `counts` are the lists' totals, `spaces[].needs_you` adds up to `counts.needs_you`, and
   `counts.events` is the unread `events`.
6. The autopilot's `running` is its `runs`: every run of this Mac's runs.json the plan holds, in
   review too, each with `overview.running`'s activity.

The steps (`next`), per kind:

| Kind | Next |
| --- | --- |
| `permission` | answer it in the agent's chat |
| `question` | the user answers in the agent's chat in Paseo; with God Mode 0.15+ read_approval, then answer_questions with only the user's own choices; never answer_approval |
| `failed` | read the error in the agent's chat; tell it to go on there, or release the task (to todo to start it again) |
| `sync` | fix the plan repository's access on this Mac; the changes then push by themselves |
| `answer` | reply in the agent's chat; if the work is finished, release the task to done |
| `stopped` | check its branch and PR/MR for the work, then release it: to done if it is finished, to todo to start it again |
| `checkout` | by the landed reading: its work is on `origin/<trunk>`, release it to done if it is finished; or commit and push it first; or check that it reached `origin/<trunk>`. Each: or release it to todo to start it again; "its workspace is still open in Paseo" while it is |
| `closed` | reopen it or tell the agent; or release the task (to todo to start it again, or to canceled) |
| `merged` | in review: accept the work if it is finished, otherwise send it back with what is left; in progress: release it to done if the work is finished, otherwise tell the agent what is left |
| `accept` | accept the work, or send it back with what to change (`accept_task`, `send_back`) |
| `qa` | a recorded QA card: say what replaced it, or get its run done and record the result (QA cards below) |

Sending back reaches only this Mac's agent while it is there and waits (`send_back` refuses
otherwise), so that half of the step follows the run: "once its agent waits" while it works, "from
<host>" for another machine's run, and "release it to todo to start it again" with no agent at work.

A task in progress with no agent at work is shown with its step, not hidden. For a tracked trunk
checkout that is a change: its end was left out of `needs_you` as its normal end, so nothing said
what to do, and its run held the autopilot's place unseen. It is now `checkout`, drawn `◐` (no
failure), and a release is the way on: a task in progress cannot start again without one
(`start_task` takes only todo tasks). Work in review is accepted or sent back with `accept_task` and
`send_back` (JOBBY-5YRRY); an agent's questions are `question` (JOBBY-RTWBY).

### Waiting states

Decided 2026-11-25 (JOBBY-YV2QS). ERG-4WT1N read "needs you: answer" while its agent sat idle and a
sub-agent it had started ran `go test` and the review. An agent that ended its turn is not by that
alone waiting for the user. `overview.running[].state` and `task.state` say what a live run waits on
(`server/needs.ts` `waitState`, from the same facts as `needOf`):

| State | Waits for the user | From |
| --- | --- | --- |
| `launching`, `working` | no | the agent's activity |
| `subagent_working` | no | Paseo's child agents of the run's agent (label `paseo.parent-agent-id`) at work, a sub-agent call running on its timeline, or the agent's `task_report waiting_for: subagent` within 30 minutes |
| `waiting_for_ci` | no | its own open PR/MR's checks pending or waiting, or `waiting_for: ci` while the checks have not finished |
| `waiting_for_review` | no | `waiting_for: review` within 30 minutes, or its agent idle in review |
| `needs_user_question`, `approval` | yes (`question`, `permission`) | the agent's own question or permission, else a child agent's (`chat_id` is the child's) |
| `answer` | yes | idle with none of the above: the agent finished its turn; `waiting_for: user` says it asks |
| `blocked` | yes (`answer`) | `task_report state: blocked` |
| `failed`, `stopped`, `checkout` | yes | as before; `stopped` now says its PR/MR, handoff and open acceptance |
| `record_lost` | yes (`stopped`) | this Mac holds the run in the plan with no record of its agent: not an ended run |
| `elsewhere` | no | another machine's run |

A sub-agent at work never hides a question or a permission, the agent's own or a child's. A reported
wait no fact backs counts for 30 minutes; checks that finished contradict a reported CI wait. A turn
that ended while a sub-agent works makes no unread event. Nothing closes, restarts or releases a run
by itself.

### Batches and full text

Decided 2026-11-25 (JOBBY-YV2QS): 107 agent profiles were set one `update_task` and one read-back at a
time, two after errors, and a brief past 1,200 characters could not be read whole.

- `tasks_profiles` reads up to 50 tasks: each one's profile, the model and effort its next start uses
  (`next_start`) apart from the agent at work now (`running`), and the set's `revision`.
- `update_tasks` sets the agent profile of up to 25 tasks and nothing else: no status, order,
  dependency or run changes, and no agent restarts. It carries the `revision` the read-back showed and
  an idempotency `key`. The key's checkpoint on this Mac (`batches.json`) holds each item's value
  before and its result, written before the plan is touched and after. Each item answers `applied`,
  `already`, `refused` (unknown task or profile, a task named twice, or changed since the read: never
  overwritten) or `unknown` (queued while the plan syncs). A call with the same key and items applies
  only what is left; the same key with other items is refused.
- `task_text` reads one section (brief, acceptance, handoff, clarifications, notes) in parts of 4,000
  characters with `next_cursor`, `truncated` and the file's `revision`; a part asked against another
  revision is refused. `task` stays compact and says `brief_chars` when its brief is cut.

### Reconcile, start candidates and delivery

- `reconcile` lists open tasks whose work a merged PR/MR holds (03-model.md, Merged work). A PR/MR
  that names a task in its description only is not its work: for a named task, `note` begins with
  "Mentioned in !N (URL)", and `delivery` says it on the code step. A row holds the PR/MR,
  merge commit, source branch, how it was tied, the acceptance still open and the next step; with
  `task`, it asks that task's forge now. `projects` names a GitLab project whose web host is not the
  one its forge serves, with the fix. It changes nothing; merged with open acceptance is not done.
  In a project this Mac reconciles it also lists the cards the rule holds, each row with `verdict`
  (`closes` or `held`), `diagnosis` (the first thing in the way), `next` (its one step), `sources` (the
  PR/MRs it rests on) and `rule`; named, a card is asked now. It still changes nothing: the closing is
  the rule's, on this Mac (03-model.md, Automatic reconciliation).
- `start_candidates` groups the todo tasks of the board's order by what holds them (`agent`,
  `person`, `decision`, `dependencies`, `qa_environment`, `merged`, `check`: a label that reads like a
  person's work the space does not mark, `not_here`), each with what its next start uses, the day a
  person checked it (or none), and a known overlap (a shared branch; an empty one is not a check).
  `slots`: this Mac's places at work, launching, stopped and in review (holding none) and free, and a
  usage limit's hold. It starts nothing and moves nothing.
- `delivery` says one task's way from its PR/MR to accepted work: each step's state and fact, the stage
  (`in_work`, `waiting_for_merge`, `waiting_for_ci`, `waiting_for_stage`, `waiting_for_setup`,
  `ready_for_qa`, `qa_unclear`, `qa_failed`, `qa_passed`, `ready_to_accept`, `accepted`), who acts next (agent, CI, deploy, owner, QA),
  why Trello cannot be read from here, and a QA handoff text. `task.delivery` has its one line. For an
  app card the steps are Code, one `APK <variant>` each, QA and Google Play, four facts that never stand
  for one another (03-model.md, App delivery), and `app` carries the recorded variants, builds and
  publication for an editor. `update_task` records them (`variants`, `environment`, `builds`, `play`).
- QA cards (03-model.md, QA cards): `update_task` `delivery.trello_cards` records cards as the caller
  just read them with its own Trello access; the plugin calls no Trello. `delivery` then has one
  `Trello <card>` step per card (state, when read, replacement and its evidence, proof, who is next),
  the stage `qa_unclear` for an archived card nothing replaces, and `qa_cards` for the screen.
  `overview.needs_you` has the kind `qa`: such a card, or a done task whose card is not settled, with
  the card's link. So is a held task whose agent is gone with its work merged, when the one step left
  is QA on a card read open (no open PR/MR, stage build, setup, decision or person's step before it): `qa` instead of
  `merged`, with the card's and the PR/MR's links and the same next step in every read.
- Needs you (`overview.needs_you`) has two more kinds for a reconciled project: `merge` is one list of
  every open PR/MR in the order to merge them (the card a PR/MR depends on first; those nothing holds
  back before those something does), each with `ready` and its own `blockers` (CI, review, whether the
  forge would merge it, dependencies; a dependency whose code is merged holds nothing back), and
  `reconcile` groups the cards the rule leaves open that wait for the same thing. Both carry `cards`:
  per card its id and title, `note`, `source` (where the decision comes from) and `links` to the
  PR/MRs and the build, kept whole however many cards share a group. A PR/MR several cards name is one
  row of the list with the others under `also`. A card that only waits (a check running, a dependency,
  a run at work) is not listed; one whose step is an agent's (a draft to finish, a build to make) is,
  since no run is assigned to take it. A live run's own need names the same
  `cards` entry when the rule is on.

### Ready review

`ready_review` is the look at the open cards before a start, in a space or one project (`project`),
or at one card (`task`, which also asks that card's forge now). It puts together what
`start_candidates`, `reconcile`, the PR/MRs, the acceptance lines and the dependencies already say.

| `coverage` | Means |
| --- | --- |
| `confirmed` | the card's own PR/MR is merged, every acceptance line is ticked and QA has not failed |
| `partial` | the card's own facts cover some of it: its merged PR/MR, or ticked lines |
| `possible` | signals only: open lines worded like lines ticked on another card (`basis: similar`), a related card, a PR/MR that may be its own, an earlier run's handoff |
| `none` | nothing found; `incomplete` says what was not read |

- A PR/MR is the card's own when its run reported it, its branch names the card or it closed the
  card's issue; when its title names the card, no other card's run reported it and its branch names no
  other card; or, tied only by a link or the branch, when no other run reported it, it names no other
  card, no other card (canceled ones included) is on its branch, and, for a link, no other card links
  it. A mention in a description is a signal.
- Related cards are of the same project and not before or after the card in a dependency chain: a
  shared branch, an alike title, two open lines worded like ticked ones, or, for work that exists, a
  shared label and title word on top of a card both build on, or a mention with a matching line. A
  criterion that more than three cards of a project carry relates nothing.
- `left`: `accept`, `qa` (code merged, lines open; a line may still need code), `fix` (QA failed),
  `check`, `compare`, `implementation`. A card in review or held by a run keeps that state's own next
  step (accept or send back; follow the run).
- `roots`: the tasks others wait for that wait for nothing themselves, with how many open cards of the
  scope each holds back, directly or through others. A reference to no task is a root; cards on a
  dependency cycle, or behind one, are counted under no root but in `note`, and say so.
- PR/MR facts are this Mac's last reading (`read_at`). A card's `incomplete` says what may be wrong:
  a project not mapped here, a forge that did not answer, a reading over an hour old, a list of latest
  merges that does not reach back to the card's creation, a card that ran before or one without
  acceptance lines.
- It changes no status, closes no card and starts no agent. Starting and accepting stay `start_task`,
  `start_tasks` and `accept_task`.

The default page is eight cards, covered ones first. God Mode's spoken text is cut short, so `note`
and `summary` (one short line per listed card) come first in the answer, before `counts` and `roots`.

### Actions

**`mark_events_read`** (`low`): marks task events read after they were told, so the next `events`
does not repeat them.

```ts
input:  { through: number; space?: string }   // every event up to this id (in this space)
output: { ok: boolean; marked: number; unread: number; error: string }
```

**`add_to_inbox`** (`low`): drafts, for example a meeting's action items the user asked to turn into
tasks. Drafts never start anything; the user triages them.

```ts
input: {
  space?: string;
  items: { title: string; note?: string; project?: string; labels?: string[]; issue?: string }[];   // 1-20 items; title 1-200 chars, note up to 2,000; up to 10 labels;
                                                                                                    // issue: a GitHub/GitLab issue's web URL
  source_url?: string;     // the meeting or document the items come from
  source_title?: string;
}
output: { ok: boolean; created: { id: string; title: string }[]; skipped: string[]; error: string }
```

`source_url` becomes each draft's `meeting` field when it is a Laconote meeting URL
(`<web URL>/meeting/<id>`), otherwise a `links` entry; `source_title` becomes `meeting_title`. An item
whose normalised title already exists as an open draft or task with the same `meeting` is skipped
and listed in `skipped`, so asking twice does not duplicate drafts. An item with an `issue` some task
(any status) already carries is skipped and listed the same way, whatever its title; one issue is
one task (09-forge-issues.md, option a). Issue text is other people's words: drafts start nothing.

**`create_task`** (`low`):

```ts
input: {
  space?: string; title: string; brief?: string; project?: string; feature?: string;
  milestone?: string; priority?: "urgent" | "high" | "medium" | "low";
  labels?: string[];                   // up to 10
  depends_on?: string[];               // ids or titles
  acceptance?: string[];               // up to 30 one-line checklist items, up to 500 chars each
  issue?: string;                      // a GitHub/GitLab issue's web URL; refused when another task carries it
  status?: "todo" | "inbox";           // default "todo" when a project is given, else "inbox"
  agent_profile?: string;              // an agent profile of this Mac; an unknown one creates nothing
  start?: boolean;                     // false: To Do only; absent: this Mac's "Start new ready tasks"
}
output: {
  ok: boolean; id: string; title: string; status: string; error: string;
  start: "" | "queued" | "todo_only" | "waits" | "asks_first"; start_note: string; // Starting new tasks
}
```

**`update_task`** (`low`): change fields of one task. Status accepts `todo` (accept a draft, reopen a
done or canceled task), `done` and `canceled`, and only for a task **without a live run**; a task with
one answers `error: "… is held by anna on anna-mbp since 21:02; use release_task"`. Starting is
`start_task`; review is set by the run itself. `project` changes only while the task was never
started (D19); otherwise nothing is changed and `error` says why: `"«…» (LAC-7K3QX) was started in
core, and its branch belongs to that repository; its project cannot change. Create a task in the
other project instead. Nothing was changed."`, the same reason the dashboard's "Move…" shows.

```ts
input: {
  task: string; title?: string; brief?: string; project?: string; feature?: string;
  milestone?: string; priority?: "urgent" | "high" | "medium" | "low";
  assignee?: string;                   // a person of space.yaml by key or name; anyone else is refused
  add_labels?: string[];               // labels to add; the task's other labels stay
  remove_labels?: string[];            // labels to take off; the others stay
  depends_on?: string[];               // replaces the list; ids or titles
  duplicate_of?: string;               // id or title; with status "canceled" merges a draft into that task
  issue?: string;                      // a GitHub/GitLab issue's web URL; "" takes the link off; refused when another task carries it
  status?: "todo" | "inbox" | "done" | "canceled";   // inbox: an accepted task back to the drafts (2026-11-03)
}
output: { ok: boolean; id: string; title: string; status: string; changed: string[]; error: string }
```

Labels (09-forge-issues.md, Labels for tasks) are named case-insensitively and written as the
space's palette spells them. A label the palette lacks is defined in the same commit with the next
palette color, so ChatGPT can label freely; a name outside 1-40 letters, digits, spaces and
`- _ . / : + &` is refused. `update_task` takes labels to add and to remove rather than a new list:
each becomes one `label` operation, so two people labelling one task never conflict
([05-architecture.md](05-architecture.md#operations)). Labels added no operation.

`issue` (09-forge-issues.md, phases F2 and F3) links a task to one forge issue; its PR/MR is asked to
carry the closing keyword, and the forge closes the issue on merge. The dashboard never writes to the
forge, so these writes stay `low`. The issue's state is runtime state read per machine and only shown:
an issue closed on the forge changes nothing in the plan by itself. Importing issues into the inbox
is offered on the dashboard's screens only (`issues.list`, `issues.import`, not described).

**`start_task`** (`outward`, asks first; `low` with `fixed: { without_asking: true }` and no target
while the machine [starts without asking](#starting-without-asking)): claim the task in the plan
repo, create its worktree workspace and its agent. `mode` and `instructions` in the answer are the
same texts as `start_check`'s: the permission mode the agent is created in, and whether the
instructions sent changed since the user last saw them.

```ts
input:  { task: string; profile?: string }   // profile: a Paseo agent profile name; default: task's, else space's, else this Mac's setting, else Paseo's
output: { ok: boolean; id: string; state: "launching" | ""; branch: string; workspace: string; mode: string; instructions: string; human: string; error: string }
target: { read: "start_check", args: { task: "task", profile: "profile" }, show: ["title", "project", "branch", "workspace", "profile", "mode", "instructions", "issue"] }
confirmText: "Start «{target.title}» in {target.project} on branch {target.branch}: an agent with profile {target.profile}, in mode {target.mode}, will work on it in {target.workspace}. Instructions: {target.instructions}. {target.issue}"
```

The RPC returns once the claim's outcome is known (`state: "launching"`); creating the workspace and
the agent continues in the background and shows in `task.activity`. When the plan repo could not
be reached before the claim was sent, the answer is `ok: false` with "could not reach the plan repo;
nothing was started". When the push's result is unclear (cut midway, or the deciding fetch failed),
the RPC throws, which God Mode reports as "unknown whether it took effect"; the next `task` read shows
what happened ([05-architecture.md](05-architecture.md#invariants), I5).

**`release_task`** (`disruptive`, asks first): end the live run's hold on a task, and stop its agent
(D23): on this Mac at once, through the Paseo CLI's `paseo agent stop` (the plugin SDK has no call
for it), waiting at most four seconds before answering; on another Mac once that machine syncs (runs
that ended before that machine first ran this version are left alone), except for a release to done, which it cannot tell from a merge.
The agent's chat and workspace stay ("Archive workspace" on the task screen is a separate step).

```ts
input:  { task: string; to: "todo" | "canceled" | "done" }
output: { ok: boolean; id: string; status: string; error: string;
          agent: string }   // "its agent on this Mac is stopped; its chat stays", "… stops once that machine syncs", or why not
target: { read: "release_check", args: { task: "task" }, show: ["title", "held_by", "host", "since"] }
confirmText: "Release «{target.title}», held by {target.held_by} on {target.host} since {target.since}, and set it to {to}. Their agent is stopped; its chat stays."
```

**`accept_task`** (`disruptive`, asks first): accept the work of a task in review and mark it
done: `tasks.release` with `to` fixed to `done`, so its agent on this Mac is stopped and on another
Mac keeps running, as above.

```ts
input:  { task: string }
fixed:  { to: "done" }
output: as release_task
target: { read: "accept_check", args: { task: "task" }, show: ["title", "result", "held_by", "host", "since", "agent"] }
confirmText: "Accept the work on «{target.title}» and mark it done: {target.result}. Held by {target.held_by} on {target.host} since {target.since}; {target.agent}. Accept it?"
```

**`send_back`** (`low`): the user's review comment to the task's agent; a task in review goes back
to in progress ([Accepting and sending back](#accepting-and-sending-back)).

```ts
input:  { task: string; comment: string }   // comment: 1-4,000 characters
output: { ok: boolean; status: string;      // the task's status after it
          note: string;                     // sent, but the task did not move, and why; "" otherwise
          error: string }                   // not sent, and why
fields: none, the whole answer
```

**`create_milestone`**, **`update_milestone`** (`low`):

```ts
create input: { space?: string; title: string; due?: string; start?: string; status?: "planned" | "active" }   // dates YYYY-MM-DD
update input: { milestone: string; title?: string; due?: string; start?: string; status?: "planned" | "active" | "done" | "canceled" }
output: { ok: boolean; id: string; title: string; error: string }
```

**`create_feature`**, **`update_feature`** (`low`). A feature's `done` also follows its tasks
automatically (D15); `update_feature` can still set any status by hand:

```ts
create input: { space?: string; title: string; milestone?: string; branch?: string; projects?: string[]; brief?: string }
update input: { feature: string; title?: string; milestone?: string; branch?: string; status?: "planned" | "active" | "done" | "canceled" }
output: { ok: boolean; id: string; title: string; error: string }
```

## Task events and ChatGPT

The task asked for events when a task's agent finishes, fails or waits for the user, delivered to
the phone without checking by hand, and to check first whether ChatGPT can receive them unasked.

### What can reach ChatGPT unasked (checked on 2026-10-27)

- **God Mode 0.12.1 cannot.** Its Site is a stateless `POST /mcp` endpoint: every call connects to
  the daemon through the relay, works and closes, and nothing runs between calls (God Mode
  `docs/architecture.md`, `gpt-site/DESIGN.md`). It answers `server/discover` with protocol
  `2026-07-28`, but its `capabilities` have no `events`.
- **ChatGPT's MCP Events can, in a narrower place.** OpenAI's
  [MCP Events](https://developers.openai.com/plugins/build/mcp-events) lets ChatGPT subscribe to an
  MCP 2.0 server (protocol `2026-07-28`) that declares `events` and implements `events/list`,
  `events/subscribe` and `events/unsubscribe`, with persistent subscription storage; deliveries are
  Standard Webhooks to ChatGPT's callback URL (webhook only: no polling or streaming). OpenAI says it
  is available "in Work chats on ChatGPT web, in Work chats in the desktop app with Cloud selected,
  and with dots", and that "ChatGPT receives the event in the subscribed chat and follows the user's
  instructions for how to respond". The page does not name the phone app or voice, and events of a
  type that cannot be replayed are lost while the server is unreachable.
- **What God Mode would need for it** (a change in God Mode's repository, not made here): declare
  `events` in the Site, keep subscriptions (its D1), verify callbacks and sign deliveries, and find
  out about new events. The Site holds no connection to the Mac, so the last part means a scheduled
  Worker reading this plugin's `events` through the relay with a cursor (the plugin side exists:
  `after` and `latest`), then delivering each new one once. Not checked: whether the user's ChatGPT
  account has Work chats, and how a delivered event appears on the phone.

So ChatGPT gets task events when the user asks (pull), and the push channel is Paseo's own.

### What is built

- **The record.** This Mac's runs make an event wherever their activity changes into `waiting` after
  work (`finished`), `failed`, `needs_input` or `question` ([05-architecture.md](05-architecture.md#task-events)).
  Each has an increasing id, the task, its chat, the time, a short result or reason, and the task's
  page. Repeated checks, reconcile passes, plugin reloads and reconnecting clients make none: only a
  change does. Events are kept until read, or until their run is over (the task done, released or
  started again); reading does not mark them.
- **ChatGPT, on request.** `overview` counts unread events; `events` lists them (the unread ones by
  default, or all after an id for a client that keeps a cursor); `mark_events_read` marks them after
  they were told. "What did I miss?" after a day away reads every event since the last one told, at
  most 500 kept.
- **Paseo, unasked.** The Live tab lists the latest events with the unread ones marked and "Mark
  read"; while the dashboard's sidebar row is mounted, each new event is a toast, and a client that
  lost its connection shows the ones it missed once it is back. Paseo 0.13's protocol also carries
  its own attention notifications for every agent (`finished`, `error`, `permission`) and push token
  registration for its app; the plugin SDK 0.13 has no call to send one, so the phone's system
  notifications are Paseo's, without the task's context, and the dashboard adds the context in the
  app.

### "What did I miss?"

```text
User: What did I miss on the dashboard?
ChatGPT → plugin_read {plugin: "dashboard", operation: "events"}
       ← events: [{id: 41, kind: "finished", task_id: "LAC-7K3QX", title: "TOTP endpoints in core",
                   summary: "Endpoints and tests are done; PR !412 is open.", chat_id: "a1b2…", …},
                  {id: 42, kind: "needs_input", task_id: "LAC-9QW2E", title: "Backoffice export",
                   summary: "asks to run: npm run migrate", chat_id: "c3d4…", …}], unread: 2, more: false
ChatGPT: "TOTP endpoints finished: endpoints and tests are done, PR 412 is open. Backoffice export
          waits for you: it asks to run npm run migrate."
ChatGPT → plugin_action {plugin: "dashboard", operation: "mark_events_read", args: {through: 42}}
User: Allow it.
ChatGPT → answer_approval {chat: "c3d4…", decision: "allow"}
```

## The description, as `meta.describe` returns it (excerpt)

```json
{
  "schema": "paseo.capabilities/1",
  "title": "Paseo Dash",
  "summary": "Paseo Dash (PD for short): tasks, features and releases of your projects, what needs you, what runs, and starting a task as an agent. «PD» always means this plugin: «в PD заведи таску», «подивись PD» and the like go here.",
  "aliases": ["PD", "ПД", "tasks", "task manager", "roadmap", "plan", "backlog", "releases", "milestones", "задачі", "таски", "дорожня карта", "роадмап", "планування", "дашборд", "релізи"],
  "operations": [
    {
      "id": "overview",
      "kind": "read",
      "method": "dashboard.overview",
      "title": "What is going on",
      "description": "Start here: what waits for the user, what runs, how releases go. needs_you: most urgent first; say each next and follow it. checkout: a trunk checkout ended, not a failure.",
      "input": {"type":"object","properties":{"space":{"type":"string"},"limit":{"type":"integer"}}},
      "default": true,
      "output": {"fields":["counts","needs_you","running","review","milestones","spaces"]},
      "outcome": {"error":"error"},
      "untrusted": true
    },
    {
      "id": "start_check",
      "kind": "read",
      "method": "tasks.start-check",
      "title": "Can this task start",
      "description": "Whether one task can start here now, and how: branch, workspace, profile, mode (the agent's permission mode, not a permission to start). human: a person's work. error: why not.",
      "input": {"type":"object","properties":{"task":{"type":"string"},"profile":{"description":"Only if the user named one; empty: the task's, space's or this Mac's choice","type":"string"}},"required":["task"]},
      "outcome": {"error":"error"},
      "untrusted": true
    },
    {
      "id": "start_task",
      "kind": "action",
      "method": "tasks.start",
      "title": "Start a task",
      "description": "Start a todo task here: a worktree on its branch, an agent with its brief. Only when the user asks to start this task, or create_task answered asks_first for it. Say confirm_text, ask nothing else: the user's yes in this chat, or the start asked again after it, confirms it; no dialog elsewhere. Only the user stops read-backs (Paseo Dash: Start tasks without asking); you cannot. Several: start_tasks.",
      "input": {"type":"object","properties":{"task":{"type":"string"},"profile":{"description":"Only if the user named one; empty: the task's, space's or this Mac's choice","type":"string"}},"required":["task"]},
      "risk": "outward",
      "confirmText": "Start «{target.title}» in {target.project} on branch {target.branch}: an agent with profile {target.profile}, in mode {target.mode}, will work on it in {target.workspace}. Instructions: {target.instructions}. {target.issue} Start it?",
      "outcome": {"ok":"ok","error":"error"},
      "target": {"read":"start_check","args":{"task":"task","profile":"profile"},"show":["title","project","branch","workspace","profile","mode","instructions","issue"]}
    }
  ]
}
```

## Exchanges

The plugin's RPC answers are what the plugin returns; God Mode wraps them as shown in
`structuredContent` (God Mode's `pluginReadOn` / `pluginActionOn`). Ids and tokens are illustrative.

### "What needs me?"

`plugin_read {"plugin": "dashboard"}` → God Mode calls `dashboard.overview {}`:

```json
{
  "plugin": "dashboard", "title": "Dashboard", "operation": "overview",
  "about": "Use this first for 'what needs me', ...",
  "untrusted": true,
  "result": {
    "needs_you": [
      { "task": "LAC-7K3QX", "title": "TOTP endpoints in core", "why": "asks to run: npm test -- totp", "kind": "permission", "next": "answer it in the agent's chat", "chat_id": "9f1c2a7e-4b0d-4c51-9a3e-2d8b7c6e1f00", "space": "LAC", "since": "2026-10-26T09:41:07Z" }
    ],
    "running": [
      { "task": "LAC-3MZ8P", "title": "TOTP enrollment screen on site", "activity": "working", "host": "ergo-mbp", "chat_id": "c07e…", "since": "2026-10-26T08:12:40Z" },
      { "task": "LAC-8HD2W", "title": "Backoffice: force 2FA for managers", "activity": "working", "host": "anna-mbp", "chat_id": "", "since": "2026-10-26T08:30:02Z" }
    ],
    "review": [ { "task": "LAC-5RT2M", "title": "TOTP contract in docs/api", "since": "2026-10-25T17:02:11Z", "pr": "!410 open" } ],
    "counts": { "needs_you": 1, "running": 2, "review": 1, "inbox": 4 },
    "milestones": [ { "id": "LAC-W4N8C", "title": "Release 2.3", "due": "2026-11-30", "done": 7, "total": 18, "blocked": 3 } ],
    "spaces": [ { "key": "LAC", "name": "Laconote", "synced": "just now", "conflicts": 0, "problems": 0 } ]
  },
  "actions": [ { "id": "add_to_inbox", "...": "..." }, { "id": "start_task", "risk": "outward", "asks_first": true, "...": "..." } ]
}
```

ChatGPT then answers the approval with God Mode's own tool:
`answer_approval {"chat": "9f1c2a7e-4b0d-4c51-9a3e-2d8b7c6e1f00", "decision": "allow"}`.

### "Turn yesterday's sync into tasks"

ChatGPT reads the meeting through the Laconote connector, then:

```json
{ "plugin": "dashboard", "operation": "add_to_inbox", "args": {
  "items": [
    { "title": "Android: show the TOTP enrollment QR", "project": "android" },
    { "title": "Backoffice: force 2FA for managers on every deployment", "project": "backoffice", "note": "Mandatory for managers, cloud and on-prem." },
    { "title": "Decide recovery-code count with security" }
  ],
  "source_url": "https://laconote.com/meeting/0d4c…7e", "source_title": "Weekly sync, 24 Oct" } }
```

`low`, so it runs at once:

```json
{
  "plugin": "dashboard", "title": "Dashboard", "operation": "add_to_inbox",
  "outcome": "done", "delivered": true,
  "result": { "ok": true, "created": [
    { "id": "LAC-Q2N7D", "title": "Android: show the TOTP enrollment QR" },
    { "id": "LAC-V9K4T", "title": "Backoffice: force 2FA for managers on every deployment" },
    { "id": "LAC-H6P3R", "title": "Decide recovery-code count with security" } ], "skipped": [], "error": "" }
}
```

### "Start the TOTP endpoints task"

First call, `plugin_action {"plugin": "dashboard", "operation": "start_task", "args": {"task": "TOTP endpoints"}}`.
God Mode reads the target (`tasks.start-check {"task": "TOTP endpoints"}`), runs nothing else, and
answers:

```json
{
  "plugin": "dashboard", "title": "Dashboard", "operation": "start_task",
  "outcome": "needs_confirmation", "delivered": false, "risk": "outward",
  "confirm_text": "Start «TOTP endpoints in core» in core on branch feat/totp-2fa: an agent with profile Implementation (the space's), in mode Auto mode (auto, the provider's default), will work on it in a new worktree. Instructions: changed since you last saw them (per git: anna).",
  "target": { "title": "TOTP endpoints in core", "project": "core", "branch": "feat/totp-2fa", "workspace": "a new worktree", "profile": "Implementation (the space's)", "mode": "Auto mode (auto, the provider's default)", "instructions": "changed since you last saw them (per git: anna)" },
  "confirmation": "mvobuse0.Hk3…Q.p7Z…w",
  "expires_at": "2026-10-25T21:16:03.000Z"
}
```

(The token starts with the expiry in base 36: `mvobuse0` is 2026-10-25T21:16:03Z.) ChatGPT reads
`confirm_text` aloud; the user may ask to hear the brief first (`plugin_read … task`). After "yes",
the same call with `"confirmation": "mvobuse0.Hk3…Q.p7Z…w"`. God Mode reads the target again; the
facts are unchanged, so it calls `tasks.start`:

```json
{
  "plugin": "dashboard", "title": "Dashboard", "operation": "start_task",
  "outcome": "done", "delivered": true,
  "result": { "ok": true, "id": "LAC-7K3QX", "state": "launching", "branch": "feat/totp-2fa", "workspace": "LAC-7K3QX · TOTP endpoints in core", "mode": "Auto mode (auto, the provider's default)", "instructions": "changed since you last saw them (per git: anna)", "error": "" }
}
```

`start_task` declares no `output.fields`, so `result` is the whole answer; God Mode's spoken text
leaves out the empty `error`. A minute later, `plugin_read {"plugin": "dashboard", "operation":
"task", "args": {"task": "LAC-7K3QX"}}` answers `activity: "working on this Mac"`, `chat_id`, and
`progress: "1 of 5 · migration added"`.

### Refusals

A task that cannot start is refused on the **first** call, before anything is read aloud, because
its target answers `error`:

```json
{ "plugin": "dashboard", "title": "Dashboard", "operation": "start_task",
  "outcome": "refused", "delivered": false,
  "reason": "its target could not be read: blocked by LAC-5RT2M «TOTP contract in docs/api» (review)" }
```

Someone else claimed it between the confirmation and the run (the target facts did not change, so
God Mode called the RPC; the handler refused):

```json
{ "plugin": "dashboard", "title": "Dashboard", "operation": "start_task",
  "outcome": "refused", "delivered": false, "reason": "already started by anna on anna-mbp at 21:02",
  "result": { "ok": false, "id": "LAC-7K3QX", "state": "", "branch": "feat/totp-2fa", "workspace": "", "error": "already started by anna on anna-mbp at 21:02" } }
```

Ambiguous name on a read (`tasks.get` answers `error`, which its `outcome` declares):

```json
{ "plugin": "dashboard", "title": "Dashboard", "operation": "task", "about": "A task by id or title words: ...",
  "untrusted": true, "refused": true,
  "reason": "2 tasks match «login»: LAC-1A2B3 «Fix flaky login test» (todo), LAC-4C5D6 «Login page redesign» (in_progress). Ask which one, or use the id.",
  "result": { "id": "", "title": "", "...": "the other fields, empty" } }
```

The same answer from `start_check` makes God Mode refuse a start with
`reason: "its target could not be read: 2 tasks match «login»: ..."`; nothing runs. If the title or
the instructions fact changes between the two calls (someone renamed the task, or a sync brought a
new brief), God Mode answers `needs_confirmation` again with `target_changed: true`; nothing runs.

### "Take the backoffice task back, Anna is off today"

```json
{ "plugin": "dashboard", "operation": "release_task", "args": { "task": "force 2FA", "to": "todo" } }
```

First call:

```json
{
  "plugin": "dashboard", "title": "Dashboard", "operation": "release_task",
  "outcome": "needs_confirmation", "delivered": false, "risk": "disruptive",
  "confirm_text": "Release «Backoffice: force 2FA for managers», held by anna on anna-mbp since 21:02, and set it to todo. Their agent is stopped; its chat stays.",
  "target": { "title": "Backoffice: force 2FA for managers", "held_by": "anna", "host": "anna-mbp", "since": "21:02" },
  "confirmation": "mvobuse0.Rt…x.Fq…2", "expires_at": "2026-10-25T21:16:03.000Z"
}
```

After "yes", the task is `todo` again, its run is recorded as ended, and any machine can start it.

## Tests the plugin ships

From God Mode's authoring guide, as `node --test` suites (the claude-accounts plugin's
`capabilities.test.ts` is a working reference):

- The description parses with the plugin's own zod schema of `paseo.capabilities/1` and survives a
  JSON round trip.
- Every operation's `method` is an RPC the plugin registers and matches `^[a-z][a-z0-9._-]*$`, the
  rule both `defineRpc` and God Mode enforce (lower case only: `tasks.start-check`, not
  `tasks.startCheck`).
- For each operation, an example input passes its `input`, and merged under `fixed` passes the real
  contract.
- One default read; only `low` actions skip confirmation; `start_task` and `release_task` ask, and
  `start_task` runs at once only in the description rendered with the switch on, with the fixed
  `without_asking` (`server/capabilities.test.ts`). The handler refuses that flag while the switch is
  off, a repeat starts nothing, and the answer carries `mode` and `instructions`
  (`server/api/start-without-asking.test.ts`); God Mode's own `plugin_action` drives both forms
  (`server/api/godmode.test.ts`).
- Every `target` names a read of the plugin, maps all its required arguments, and shows fields the
  read returns non-empty whenever its `error` is empty; every `outcome` field exists in the RPC's
  output.
- No `output.fields` entry or result key matches God Mode's redaction pattern.
- God Mode's own parser accepts it with nothing dropped: `parseCapabilities(describe()).capabilities.skipped`
  is `[]`, run against a separate God Mode checkout (not the copy Paseo manages under `~/.paseo`).
- The spoken text of a full `task` read, rendered with God Mode's `resultLines`, still contains
  `status`, `activity`, `progress` and `chat_id` within its 1,500 characters; that of a `recap` with
  many events contains `since`, `total`, `counts` and `more`; a `task_result` read through God Mode's
  `plugin_read` reads out `pr`, `state`, `checks`, `failing` and `review`, and one refused for a
  project without a checkout here reads out the link (`server/api/godmode.test.ts`).
- God Mode's `plugin_action` reviews a task (`server/api/godmode.test.ts`): `send_back` refused
  while the agent works says why and sends nothing, then delivers the comment and moves the task to
  in progress; `accept_task` reads back the checks, the review and the holder, asks again when CI
  finished between the read-back and the yes, then marks the task done; it refuses a task not in
  review, and says that another Mac's agent keeps running.
- God Mode's `plugin_action` resumes a paused task (`server/api/godmode.test.ts`): `resume_task`
  reads back the task and its pause and resumes nothing before the yes; a yes given before the pause
  was written again is read back again (`target_changed`); a task the user started meanwhile is
  refused with its state; the same confirmed call after the resume is refused and starts nothing.
  `server/autopilot-resume.test.ts` checks that only that one pause goes (the limit, the start
  defaults, other task flags and a paused project stay), and the queued, blocked, not found, not
  on the autopilot and project-only answers.

And live, from that God Mode checkout's `gpt-site/` with the plugin reloaded:

```sh
node core/probe.mjs plugins                                              # Dashboard listed, nothing dropped
node core/probe.mjs plugin-read dashboard --json                         # overview
node core/probe.mjs plugin-act dashboard add_to_inbox --args '{"items":[{"title":"probe draft"}]}'
node core/probe.mjs plugin-act dashboard start_task --args '{"task":"probe task"}' --json   # needs_confirmation only
```

The last command is not run with `--confirm` outside a test space: it starts a real agent.
