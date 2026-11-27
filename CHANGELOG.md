# Changelog

## Unreleased

### Automatic reconciliation of finished work

- Settings → Automatic closing (per project, per machine, off by default): **Report** says what is
  left of each card whose work is on the forge, **Close** also closes the card, once, when its own
  merged PR/MR, its checks, its acceptance, its scope and the plan all hold. The closing is written on
  the card (`auto_closed`: when, on which machine, which PR/MRs, the facts). A merge with QA open, an
  unreadable forge, a manual step, an open decision, a changed scope, another card's PR/MR, a PR/MR
  still open or not read, a linked fork's PR/MR or an active run closes nothing and stops or restarts
  nothing. A run's own merged PR/MR in such a project ends it only the same way under Close, and never
  by itself under Report; it stays open and says what holds it otherwise.
- The closing is a plan operation (`close`): it applies only on the card revision it was checked on,
  with facts at most 15 minutes old, with the plan's holds and this machine's rule read again, so a
  card the owner changed meanwhile, a replay after a restart or a second machine writes nothing twice.
- Needs you: one `merge` list of every open PR/MR in the order to merge them, each with its own
  blockers (CI, review, mergeability, dependencies), and `reconcile` groups for the cards left open,
  with the links to each card's evidence and where its decision comes from. `reconcile` and the
  overview carry the same facts for ChatGPT.
- Apps: delivery keeps the code, a build per variant (phone, wear), QA and Google Play apart. One
  recorded build covers every card whose merge commit it holds, when it is on the target branch and its
  variant and environment match; a merge publishes nothing and an available build passes no test.
- `meta.describe` grows from 22,431 to 23,108 bytes; its ceiling goes from 22 to 23 KiB (the fields
  `update_task` records for apps, and two lines of description).

### Managed queue (pilot)

- Settings → "Managed queue (pilot)", off by default: for one project, a switch, a limit of starts per
  24 hours, a pause and optional labels the queue is narrowed to. Live's "Managed queue" previews, per
  card of the project, what the queue would do and why (next, queued, forge read first, waits for a
  card, duplicate, waits for you), also while the queue is off, and lists the cases that wait for you
  with the step each needs.
- The autopilot starts the queue's ready cards one per check after its own flags, under the same
  places and usage limit. The limit of starts, the pause and turning the queue off count again right
  before a start and inside the claim, on the plan it fetched, so a start that was only waiting for
  its turn stops too; a card changed meanwhile, or taken by another machine, is not started and is
  no failure. A start that fails, or a run a person releases, pauses the queue; a card that ran once is
  not started again by it.
- A card enters the queue only when nothing holds it: it waits for no card, is not a person's work,
  needs no decision, access, device or QA, has no open question, shows no merged or earlier work,
  reads like no other card, its forge data was read, and you have seen its instructions as they are
  now. A card that becomes ready when its dependency is done joins the queue by itself. A proven
  duplicate (same issue, or same title, brief and acceptance) is held; a text match is only a
  proposal until you record a check (`readiness_note`). Text on a card gives no permission.
- Nothing is described to ChatGPT: `meta.describe` is unchanged.

### Delegated planning (pilot)

- Settings → "Delegated planning (pilot)", off by default: appoint an open agent as the coordinator of
  one project and choose what it may do: write its own drafts, set priority, set dependencies. Its next
  session gets the tools `coordinate_find`, `coordinate_task`, `coordinate_draft` and
  `coordinate_plan`; no other agent gets anything new.
- Changes go through the plan's journal with the permission, the card's rules and its revision
  checked again before they are pushed: a revocation, a run, a mark of manual work or a newer edit
  that arrives first refuses them, and a repeated call writes nothing twice.
- Settings and the task screen show who changed or asked to change what, when and under which
  permission; commits carry a `Dashboard-Delegated` trailer.
- The limit covers these tools, not an agent with an unrestricted shell on the same Mac.

### Review before starting

- Live's "Review before starting" and ChatGPT's `ready_review` look at the open cards of a space or a
  project before a start: per card what covers it already and how that is known (confirmed, partly,
  a possible match, nothing found), its PR/MRs, the related cards, the open acceptance lines, what
  remains and the next step, with missing data said. Only the card's own merged PR/MR and ticked lines
  confirm anything; a similar title, a shared branch or a mention is a signal.
- It names the tasks that hold the most cards back through dependencies, so the next step for a
  project is visible. It changes no status, closes no card and starts no agent.
  `meta.describe` grows from 21,910 to 22,431 bytes; its ceiling is raised from 21.5 to 22 KiB.

### Tasks and chats from voice

- `create_task` takes `agent_profile`: a profile you name goes with the new task, so a start queued by
  that create uses it; an unknown name creates nothing.
- ChatGPT is told to file project work, asked by voice too, as a task with a short brief and concrete
  acceptance lines unless you ask for a chat, and to pass a start profile only when you named one. For
  a separate Claude chat where you named no runtime, model or effort, it is asked to choose by the
  model pick's tiers: Sonnet 5.5 Medium for a clear local fix, Sonnet 5.5 High for harder local work,
  Opus 5.5 High for unclear, architectural, cross-repository or risky work.
  `meta.describe` grows from 21,380 to 21,910 bytes.

### Honest states, batches and the way to QA

- Work merged while its task stayed open is found by the task's id too: a merged PR/MR whose title,
  description or source branch names it (site !412 for ERG-7MRG1, on a branch the plan did not name),
  or the one the forge says closed the task's issue in its own project. An issue number or a similar
  title alone never ties one. The board card, the task screen and ChatGPT's `reconcile` show the
  PR/MR, its merge commit and branch, the acceptance still open and what to do; nothing changes the
  task by itself. A start of such a task says what was merged and nothing starts it on its own; a
  start of it alone tells its agent to do only what is left.
- Projects says when a GitLab project's web host is not the one its forge serves (GitLab's `web_url`
  for the project), with a button to set it; `start_check` names the host to check when only the host
  of an issue differs.
- ChatGPT reads the profiles, models and efforts of up to 50 tasks at once (`tasks_profiles`: the next
  start's apart from the running agent's) and sets the profiles of up to 25 (`update_tasks`): only the
  profile changes, each task answers on its own, the revision of the read guards the call, and a retry
  with the same key applies nothing twice and never undoes a change made in between. `task_text` reads
  a long brief, acceptance or handoff whole, in parts; `task` stays short and says when its brief is cut.
- What can start: Live's "What can start" and ChatGPT's `start_candidates` group the todo tasks, in the
  board's order, by what holds them: for an agent now, a person's work, a decision, other tasks, QA or
  an environment, merged already, a label that reads like a person's work the space does not mark,
  not on this Mac; with what each start would use, the day a person checked it, and this Mac's places
  at work, launching, stopped, in review and free. Reading it starts nothing. Tasks carry `requires`
  (owner, decision, environment, device, access, QA, each with a reason and a day) and a readiness
  check, set with `update_task`.
- Waiting states: an agent idle while a sub-agent of it works (Paseo's child agents, or a sub-agent call
  on its timeline), while its PR/MR's checks run, or after it reported a wait (task_report
  `waiting_for`) no fact contradicts, is no longer "needs you: answer"; a sub-agent's question or
  permission is. `overview.running` and `task` say the state; a stopped run says its PR/MR, handoff
  and open acceptance, and a lost run record is said apart from an ended run. A turn that ends while a
  sub-agent works makes no unread event.
- Delivery: the task screen and ChatGPT's `delivery` show the way from the PR/MR to accepted work: the
  merge commit, checks, the stage build and whether it holds the merge, flags, access, device, the
  Trello card and QA's result, the stage it is at and who acts next, with a QA handoff text. Merged is
  not accepted; passing checks tick no manual check. Paseo Dash has no Trello access: the card is
  linked, its state is the one recorded, and the handoff is ready to post. `update_task` records these
  facts with their day.
- `meta.describe` grows from 17,667 to 21,380 bytes; its ceiling goes from 17.5 to 21.5 KiB.

### Board

- A task in progress that no run of Paseo Dash holds (set by a session outside the dashboard, a hub's
  plan MR or an edit of the plan) is no longer stuck: its screen says so and offers Mark done, Back to
  todo, Cancel and Start, and its board card says no run holds it. Nothing changes it by itself.
  Start claims it for a new run with the same branch check as a todo task: a merged branch offers
  Mark done or a fresh run with a suffix, a branch not merged offers continuing on it or the suffix.
  Work merged on its branch or a PR/MR among its links shows "Work already merged" with Mark done, as
  for todo tasks. ChatGPT's `update_task` moves it to done, todo or canceled, and `start_task` starts
  it with the same checks; `start_check` says why the start is allowed. The autopilot never starts it.
  `meta.describe` grows from 17,420 to 17,506 bytes.
- Sync: the space screen's header has a Sync button that fetches the plan now, outside the
  one-minute loop, and says when it last synced ("Synced 14:03") or why it failed; Command Center has
  "Sync Paseo Dash". `spaces.sync` answers each space's last sync and problem.
- Archive: done and canceled tasks can be archived off the board, one at a time (card or task screen),
  all of a space (the Done column's "Archive all…") or all of a feature (its screen's "Archive
  finished…"). The board's Archived chip lists them, each with Unarchive; search and the Tasks tab find
  them as before. The task keeps its file, status, run, branch and PR/MR; it gets an `archived` field,
  which a reopen clears. Open tasks cannot be archived.

### Autopilot

- Claude's model and effort are picked per task, the same way for the start dialog, the autopilot and
  ChatGPT's starts: Sonnet 5.5 Medium for a short brief with a few acceptance lines, Sonnet 5.5 High
  for a bigger one, Opus 5.5 High for a task without acceptance, with an open question or more than
  six acceptance lines, or whose title or labels name architecture, more than one repository, a
  migration, security, research or a spike, an audit, a rewrite or concurrency. Only where no agent profile applies; a task's or space's profile
  keeps its model. The start dialog shows the model and why, and offers other models and this Mac's
  agent profiles; a pick there wins. A model this Mac does not offer leaves the provider's default,
  said in the dialog. A usage limit never swaps the model. Settings → Autopilot → "Pick Claude's model
  and effort per task" turns it off. `meta.describe` grows from 17,506 to 17,529 bytes.
- ChatGPT's `update_task` takes `agent_profile`: the name of one of this Mac's agent profiles, which
  every start of the task then uses for its model and effort (a profile outranks the model policy;
  the start dialog's pick still wins). An empty value takes it off, so the policy and the defaults
  decide again. A name this Mac has no profile for is refused with the profiles it has, and nothing
  else in the call is changed. `get_task` shows the profile. `meta.describe` grows from 17,529 to
  17,667 bytes.
- A task you create in To Do with nothing to wait for starts on its own: once a slot of the autopilot
  is free, it starts once, in Auto mode with effort High. "To Do only" in the new task form keeps it
  there. A task that waits for other tasks, one whose brief lists open questions, and one labeled as a
  person's work are not started, also not later: start them yourself when they are ready. With the limit full the task waits in the autopilot's queue in Live and starts once a run
  stops. Settings → Autopilot has "Start new ready tasks" and this Mac's mode and effort of every
  start; the effort is passed to the agent explicitly instead of the model's default (Medium), a
  profile's or a picked effort still wins, and a model without it says so instead of swapping it
  silently. The task screen's Run section shows the mode and effort the agent was started with, and
  what Paseo reports when that changed.
- A ready task ChatGPT creates starts the same way while "Start tasks without asking" is on; otherwise
  `create_task` answers `asks_first` and ChatGPT calls `start_task` for that task, whose read-back you
  answer. `start_check`'s read-back says the effort with the mode.

- ChatGPT can resume one task the autopilot paused, as Resume in Live → Autopilot does (God Mode's
  `resume_task`). It reads back the task, why it was paused and that it may then start on its own, and
  resumes only after your yes, also while "Start tasks without asking" is on; a yes given before the pause or the task changed is read back again,
  and a task already started, no longer paused, blocked or not found is refused with its state and
  what to do instead. Nothing else changes: the limit, the start defaults and other flags stay, and a
  project's flag is still resumed only in Paseo Dash. The answer says whether the task waits in the
  queue (and for what), is being started, or has its agent at work. `meta.describe` grows from 16,355
  to 17,420 bytes; its ceiling goes from 16 to 17.5 KiB.

- A Settings button at the right end of the top bar opens how runs start on this Mac: the autopilot's
  limit of runs at work (1 to 20, default 3), how many slots are in use (`2 of 6`), and every live run
  with whether it holds a slot and why, stopped and failed agents included. A new limit counts at once,
  without a restart, and is kept after one; it changes no task or project flag, and a lower one stops
  no run. The same section is in Settings → Paseo Dash, together with "Start tasks without asking",
  now labeled as reaching only starts ChatGPT makes through God Mode.
- Only agents at work take a place under the autopilot's limit of runs: an agent that works, asks for
  a permission or is being started, or waits for a reply while its task is in progress. A task whose
  agent is gone, one whose agent failed, and a task in review waiting for you to accept it no longer
  block other ready tasks. They still hold their task, and Needs you still says what to do with them
  (release it to done or todo, accept it, tell the agent to go on). The Live tab and ChatGPT's
  `autopilot` read list every run with whether it takes a place.
- A flag whose task is done, canceled, in review or started some other way is dropped at once, also
  while the limit is full, and is never shown as waiting.
- When an agent's turn fails on a usage limit (Claude's 5-hour limit, a 429), the autopilot starts
  nothing until the limit resets, then goes on with the queue. The reset comes from the error when it
  names one, else from Paseo's usage report when usage is on in Paseo, else a wait of 15 minutes that
  doubles, up to 4 hours, each time a start meets the limit again. The Live tab and the `autopilot` read
  say until when and where that comes from. A limit no longer pauses the project line, and the task
  whose agent met it is not started again: it waits for you, as a failed agent does.

### Issue mirror

- The mirror makes issues only in repositories your forge login can push to (Developer or above on
  GitLab). Anyone may open an issue in a public repository, so a project that is someone else's
  public repository used to get the space's briefs as public issues there, or fail on its labels.
  Such repositories are listed in Settings as "Not mirrored", also in the warning shown before the
  mirror is turned on, and their tasks no longer show as problems or waiting. An issue the mirror
  made there before is no longer written either: it stays as it is.

### What a running task's agent does, live

- A task whose agent runs on this Mac shows the agent's latest step under its card on the board, under
  its station on the map and on the task screen: the file it reads, edits or writes, the command it
  runs, a sub-agent's task or a tool, and how long ago it started ("✎ src/auth/session.ts · 12 s"; the
  map shows the file name only, and only for a station whose task is working). The line is in the
  accent color for its first 5 seconds. It follows the agent's own steps: a sub-agent's steps do not
  show, and files changed through shell commands do not show as steps.
- The task screen also lists the files the run changed: the branch's changes since it forked from the
  checkout's default branch, plus untracked files, as git shows them at each turn's end, plus the files
  edited since.
- Only runs on this Mac show; a run on another machine shows its status as before.
- The task screen of a running task draws its code map: the files the run changed (✓) or its agent
  read (◉), each under the files that import it, and the files a changed file imports that the run
  did not touch (·). A file the agent touched in the last seconds is in the accent color. Imports are
  read from the run's checkout: JavaScript and TypeScript, and Python's relative imports. An import
  written inside a comment counts too.
- When two running tasks on this Mac, in the same Paseo project, change the same file, both say so:
  the board's cards ("⚠ Also changed here by ERG-X: session.ts"), the task screen with the shared
  files, and the map, which gives both stations a dashed red ring and, when both are on the same
  map, draws a red link between them. ChatGPT reads it in the task's `shares_files_with`. It
  compares the files git and the agents' edits show for each run. A merged, released or stopped
  task's run is not compared, nor are runs on other machines or in another checkout of the same
  repository.

### Work done outside Paseo Dash

- A todo task or draft that never ran, whose branch (the task's or its feature's) or a PR/MR among
  its links was merged after the task was created, shows "✓ Work already merged" with the PR/MR on
  the board and the task screen, and offers "Mark done…". Its status changes only when you confirm;
  a draft is accepted on the way. Each task is looked up in its own project, so a branch name two
  repositories share is told apart; GitLab links on a `web_host` count.
- Start no longer fails on a branch that already exists for a task that never ran. When that branch's
  work is merged (its latest PR/MR, or a merge into the trunk), the confirmation offers "Mark done"
  or a new run on the branch with a suffix (`-2`, `-3`, …). When it is not merged, it says where the
  branch is (this Mac, origin, another worktree) and offers continuing on it or the suffix. Nothing is
  claimed until you choose.
- A start whose workspace Paseo could not create says so ("Creating the workspace on … failed")
  instead of "Starting the agent failed"; its claim goes back to todo as before.

### Search in a top bar on every screen

- The space, line, feature and task screens start with a top bar: the search, and on the line,
  feature and task screens "‹ Back" and how many things wait for you. `/` focuses it on the web and
  desktop apps while the bar is on view.
- Results come while you type: tasks with their id, section and where they matched, the words in
  bold, then features, releases and projects by name. Enter opens the first, so an id and Enter opens
  its task; ↑ ↓ choose; Esc clears. The search covers the screen's space, with a chip to search every
  space, and says when nothing was found, when the other keyboard layout was used, or when only some
  words matched.
- With the field empty it offers the ten places you opened last, kept on this Mac.
- From anywhere in Paseo: a search icon on the sidebar's Paseo Dash row opens the search in a
  popover, and Command Center has "Search Paseo Dash".
- Board, Tasks and Inbox filter by one query, kept when you switch tabs or come back; the inbox has a
  filter field.

### Search that finds tasks

- One search (server/search) serves the Tasks tab and the board, ChatGPT's `tasks`, the inbox and
  agents' `plan_find`; before, `plan_find` had its own rules and found other tasks for the same words.
- A task is found by its id however it is typed (`LAC-7K3QX`, `lac7k3qx`, `LAC 7K3QX`, `7K3QX`,
  Cyrillic look-alike letters), and by its labels, project, feature, release and assignee, besides
  its title, text and links.
- Words match in other forms (Ukrainian, Russian and English: «логіну» finds «логін»), by their
  beginning, and with a typo when a word is in no task as typed. With nothing found the query is tried
  as typed on the other keyboard layout (`kjusy` → «логін»), then the tasks with some of the words
  are shown as partial matches; the Tasks tab and the board say when either happened.
- Results come best first: the id, the exact title, words in the title, then in labels and the like,
  then in the text and links; open before done before canceled.
- ChatGPT: `task` takes an id in those forms and, when no id or title matches, the one task search
  points to clearly, saying so in `found_by`; a name that matches nothing names the closest tasks with
  their ids. Writes still need an exact name. `tasks` with a query also lists the features, releases
  and projects whose names match (`also`). `inbox` takes `query` and `offset`.
- `meta.describe` grows from 15,888 to 16,109 bytes, under its 16 KiB ceiling; a `tasks` search is
  measured too (`tasks_query`, 6,881 bytes on the large plan).

### Plan tools for any agent

- Settings → Agents → "Plan tools for every agent", off by default. When on, every agent session on
  this machine opened in a repository that is a project of a connected space gets three tools:
  `plan_find` (tasks of those spaces by words, 20 lines by default), `plan_task` (status, brief and
  acceptance of one task) and `plan_add_draft` (a draft in that project's Inbox).
- The agent's git origin decides which spaces it reads; other spaces stay out of reach. The tools
  cannot start, move or edit a task, plan text comes marked as written by people, and a draft an agent
  adds is not marked seen.
- The tools come at every session open (new, resumed, refreshed), from Paseo 0.14 on, for Claude,
  Codex, Copilot and OpenCode agents (Paseo fails the open of a provider without MCP support that is
  given a server), and are not saved with the agent. The origin is read when the session opens.
- Their list is 881 bytes and a full page of `plan_find` on the large plan 782; `npm test` holds
  them under 1 KB and 1.5 KB.

### The board opens first on desktop

- A new Board tab shows a space's tasks in columns: Drafts, Ready to start, Blocked, Running, Review
  and Done. On desktop the space opens on it; the metro map is the next tab. On a phone the space
  still opens on Lines.
- A column holds what the Tasks tab lists under the same heading, in the same order. Done shows the
  50 latest finished tasks and counts the rest.
- Drag a draft onto Ready or Blocked to accept it (a draft without a project opens the accept form),
  a ready or blocked task onto Drafts to send it back, and a card onto another in its column to put it
  before or after. Each card has the same as buttons, the only way on iOS and Android. Running,
  review and done move only with their run, as before.
- Keys on the web and desktop apps: n for a new task, / for the search, f for the filters.
- `tasks.update` (God Mode's `update_task`) takes `status: "inbox"`: an accepted task without a live
  run goes back to the drafts.

### Lighter reads for ChatGPT

- `meta.describe` is half its size (30,919 to 15,888 bytes on the large plan) and is held under 16 KiB by
  `npm test`. God Mode shows ChatGPT the arguments of every operation with every read, so each read
  through God Mode 0.17.0 carries about 12 KB of catalog instead of 27 KB.
- Operation descriptions say what to use the operation for and the rules ChatGPT has to keep; the
  rest moved to the answers that meet the moment: events answer `next` (mark them read, never past an
  unread event not shown; how the user answers an agent's question), and `start_plan` keeps its `rules`.
- Argument schemas drop bounds and defaults (the handler still enforces them, and its refusal names
  them) and most argument descriptions; `confirm` and `output.fields` that God Mode derives by itself
  are left out.
- A `tasks` row leaves out empty fields (`assignee`, `blocked_by`, `matched_in`, `quote`, `needs`,
  `next`, `labels` and the like): on the real plans a row went from 341 to 209 bytes in one space and
  from 446 to 340 in the other, whose titles and release names are long Cyrillic text.

### Changes show in under 3 seconds, on less traffic

- A visible screen polls a tiny token, `dashboard.changes`, and reads in full only when it moved: a
  plan operation, a run's activity or a task event shows about 2.5 s later rather than up to 10 s.
- The polling reads drop from every 10 s to a reserve once a minute. Measured idle on the map of all
  spaces (two spaces, 69 KB a round), a client exchanged 81% fewer bytes with the daemon; on a small
  space's map, where a round is 17 KB, it is 75%.
- The token is not polled while the app is in the background, and a slow daemon never gets
  overlapping token requests. The reserve reads pause in the background on the web and desktop apps.

### Work that only a person can do

- `defaults.human_labels` in `space.yaml` names the labels that mark a person's work. Without it
  nothing changes; the README says how to turn it on.
- Start next, Start ready tasks, the autopilot and `start_tasks` pass such a todo task over and name
  it with the label. Turning the autopilot on for that task is refused; a flag set earlier waits,
  unpaused, and says why.
- `start_plan` and `start_check` say `needs_owner` with the reason and `needs: human_label`.
- A start of that one task still works: its dialog, read-back (`human`) and answer say the label.

### Starting tasks from ChatGPT by the user's word

- `start_plan` (new read) says for the tasks the user named what a start does now: `can_start`,
  `after_prerequisites`, `blocked`, `needs_owner`, `already_started`, `finished` or `refused`, with
  the reason, the next step, what each waits for and the order to start them in. It carries the
  rules ChatGPT follows to start tasks for the user: only an explicit request counts, drafts and ideas
  never do, no questions of its own beyond the read-back, the start permission is not the agent's
  mode, what waits for the user is never decided for them.
- `start_tasks` (new action) starts such a set with one read-back: what can start starts now
  (`launching`), what waits for tasks of the set or under way is queued on this Mac's autopilot and
  starts once they are done, the rest is said with its reason. A set of which nothing would start is
  refused before the read-back. A queued task whose instructions changed after the yes waits until it
  is opened once.
- `start_check` adds `decision`, `next`, `waits_for` and `asks_first`.

### One task state in every read

- `overview`, `tasks`, `task` and the autopilot read take a task's state from one place, so they no
  longer contradict each other. A test reads the same runs through all of them and `events`.
- A tracked checkout on the trunk whose agent ended is listed under Needs you as `checkout` ("mark
  done once landed", drawn ◐): no failure, but only the user moves the task on. It says whether its
  work landed on `origin/<trunk>` and what to do: release it to done if it is finished, or to todo to
  start it again. Before, such a task sat in progress with no next step anywhere.
- Every Needs you item carries `next`, the user's step for it, and `tasks` and `task` carry the same
  `needs` and `next`, so ChatGPT can say what to do about any task in progress without a working agent.
- A run the plan says this Mac holds, with no record of its agent here, reads `stopped` and is listed
  under Needs you, instead of `working`; a start whose claim is still being pushed reads `launching`.
- In Live's Needs you, an agent gone is drawn `!` as on the map, no longer ✕ as if it failed.
- The autopilot read lists the runs it counts against its limit (`runs`). A run whose agent is gone
  still holds its place, and its project, until it is released; a full limit or a waiting project now
  names such runs, and Live's autopilot heading counts them. The rule itself did not change.
- God Mode's description of `task` was longer than the 600 characters it keeps and is shortened; a
  test now checks that every description and read-back fits.

### A faster start confirmation

- Picking a mode, an effort or "Start anyway" in the start confirmation shows the result at once:
  nothing is asked of git, the forge or Paseo again, and Start stays usable while the facts are
  read again in the background.
- The task screen reads the start facts ahead for a task that can start, so the confirmation opens
  with them. Its lookups of origin's branches and of an earlier run's PR/MR are kept for a minute
  and made at the same time as the agent settings and the instructions.
- The start itself looks everything up again and refuses when the project, branch, workspace,
  agent or issue it would use is not the one the confirmation showed; the confirmation then shows
  the new ones.

### Accepting and sending back work from ChatGPT

- God Mode's new `send_back` sends a task back for changes as the task screen's Send back does: the
  user's comment reaches the task's agent as review feedback and a task in review is in progress
  again. It runs at once, like `send_message`. A refusal says why (the agent still works, is gone,
  or runs on another Mac); a comment sent while the task could not move says so in `note`.
- God Mode's new `accept_task` accepts the work of a task in review and marks it done. Its read-back
  says what the user decides on: "Accept the work on «…» and mark it done: PR #7 open, checks
  passing, review approved. Held by … on … since …; its agent on this Mac is stopped; its chat
  stays. Accept it?" CI finishing before the yes reads it back again. A task not in review is
  refused; `release_task` still sets one done.
- Send back on the task screen shows a move that failed after the comment was sent as before; the
  RPC now answers it in `note` instead of `error`.

### ChatGPT reads the autopilot

- God Mode can read this Mac's autopilot (`autopilot`): which tasks and projects are on it, what
  each waits for or why it is paused, live runs against the limit, and what it started. Turning it
  on or off, resuming and the limit stay in Paseo Dash.
- A flag no finished pass has checked (after a daemon or plugin restart, or set since the last pass)
  says `not checked yet`, and one a pass did not reach because it stopped at an earlier flag says so,
  instead of an empty state that read as "nothing holds it". A read during a pass shows the last
  finished pass.

### Paseo Dash

- The plugin is called Paseo Dash: in Paseo's plugin list, its sidebar row, screens and settings,
  messages, and to ChatGPT. To ChatGPT «PD» means Paseo Dash: the description says so («в PD заведи
  таску», «подивись PD» go here) and `PD` is an alias God Mode matches the plugin by.
- Nothing technical changed name: the plugin id stays `dashboard`, and plans, spaces, settings, runs
  and the agents' `dashboard` tools carry over as they are.
- A working copy installed for development (`--id dashboard-dev`) calls itself Paseo Dash Dev and
  does not answer to «PD». `npm install` marks it so; an install from git runs
  `node scripts/edition.mjs release` as its last build command, so `node` must be on the daemon's
  `PATH`.

### PR/MR checks and review for ChatGPT

- God Mode's new `task_result` read answers "did CI pass", "is the PR approved": a task's PR/MR as
  GitHub or GitLab has it now (state; checks passing, failing, pending, waiting or none, with up to
  five failed check names and the checks page; the review decision), read with the `gh` / `glab`
  already logged in on this Mac. It writes nothing and is marked untrusted. Without a checkout of
  the project on this Mac, or with `gh` / `glab` unable to read it, the answer is an error that ends
  with the PR/MR's link.
- The examples in `06-god-mode.md` no longer show "checks passing" in `task.pr` and
  `overview.review[].pr`: those say the PR/MR's number and state only.

### Starting from ChatGPT with the read-back

- While Start tasks without asking is off, God Mode's read-back of a start ends with "Start it?",
  and `start_task` tells ChatGPT that the user's yes in the chat (spoken or typed, or the start
  request said again after the read-back) is the confirmation, that there is no dialog on the Mac to
  confirm in, and where the user turns the read-back off. Both forms of `start_task` say that
  creating a task is not a request to start it.

### An agent's questions apart from its permissions

- An agent that asks the user questions (Claude's AskUserQuestion, Codex's request_user_input, a
  request of Paseo's kind `question`) is listed in Needs you as `question` ("asks you") and makes a
  `question` event, named by its questions as God Mode names them ("2 questions: Release, Daemon").
  Permissions stay `permission` and `needs_input`.
- `overview` and `events` tell ChatGPT to read the questions with God Mode's `read_approval` and to
  send only the user's own choices with `answer_questions` (God Mode 0.15 or newer), never an
  `answer_approval` allow: before 0.15, God Mode answered a Codex question that way with the first
  option of each.

### Recap of a period

- God Mode's new `recap` read answers "what happened since Friday": the plan's changes from a date
  (at most 31 days back, 7 days by default), newest first: tasks done, merged (done with their run's
  PR/MR), sent to review, started, blocked (`blocked: …` progress), released, created, new drafts and
  any other status change, each with who, when, the change, the PR/MR and a link to the task's page.
  Counts by kind come first; `kinds` and `limit` narrow it. The plugin calls no model.
- It is read from the plan repository's commits when asked, nothing new is stored: a status a person
  changed by hand in the file shows like one changed in the dashboard, flagged "by hand".
- The Live tab has a Recap block with the same answer for the last 24 h, 3, 7 or 30 days.

### Start: effort and clarifications

- The start confirmation names the agent's effort and where it comes from (the profile's, else the
  model's default) and offers the model's other efforts as chips. The start passes the effort it
  showed.
- A clarifications field in the start confirmation: what you type is kept on the task under
  `## Clarifications`, with your name and the time, and every later run's agent gets it in its first
  prompt and from `task_brief`, told to follow it where it disagrees with the brief or acceptance.
  The task screen shows it. A space start template places it with `{{clarifications}}`, or at its end.

### Task states after a merge

- A run's own merged PR/MR with acceptance lines not ticked finishes the task once its workspace is
  archived in Paseo: the person ended the run. With the workspace kept, the task waits for the ticks
  or a person's "Mark done" as before.
- Merges show sooner: every live run's PR/MR is checked once this machine's projects are read after
  a start, right after the run's workspace is archived, and at most once a minute while a dashboard
  screen or the sidebar is open (besides after each turn and every five minutes).
- Needs you names the run's merged PR/MR before an agent that waits or is gone, and a closed one
  before a gone agent, so the reason shown is the decision to make.
- Task events of a run that is over (its task done, released or claimed again) read as read, and
  such a run makes no new events when someone goes on talking to its agent. A start whose claim
  never landed keeps its failed event.

### Inspector

- Tasks, a station's tasks, features and lines opened from the space screen show in a panel beside
  the map and lists (over them on phones) instead of a screen of their own: the map keeps its
  scroll and filters, and the row on view is marked in the Live, Tasks and Inbox lists.
- The panel has its own back and forward, previous and next in the list a task was opened from
  ("3/12"), "⤢" for the full screen and close; on the web and desktop apps Escape, ↑/↓ (k/j) and
  Alt+←/→ do the same.
- A screen opened from the panel leads back to the space with the panel open; a link to the space
  with `peek` opens it. The station sheet over the map is gone.

### Task events

- A task's agent finishing its turn, failing or waiting for an answer is recorded once as an event
  with the task, its chat, the time, the reply or reason and the task's page; checks, reloads and
  reconnects do not repeat it.
- The Live tab lists the latest events with the unread ones marked and "Mark read"; while the
  sidebar is mounted each new event is a toast, and a client catches up on the ones it missed.
- God Mode: `events` and `mark_events_read` (eighteen operations); `overview` counts unread events.
  ChatGPT reads them when asked: God Mode's Site cannot reach a chat by itself, and ChatGPT's MCP
  Events would need a God Mode change (06-god-mode.md, Task events and ChatGPT).

### Search of the plan

- `tasks.list` `query` and the Tasks tab filter search a task's title, brief, acceptance, Notes,
  progress note, PR/MR, links, issue and branch, in memory; with a query both look through every
  status unless one is picked. A PR/MR link or branch name finds the task that owns it.
- Each found task says which field matched and quotes it; the Tasks tab shows the quote under the
  row.

### Run history

- The task screen's "Earlier runs" lists every run of the task the plan's commits know, newest first:
  who, host, branch, start and end, what became of it, its PR/MR, last progress note and handoff. A
  run this machine started opens its chat and workspace and shows its agent's latest reply; another
  machine's run says where its agent ran.
- God Mode's `task` read carries the latest five runs (`runs`), with `chat_id` where the agent is on
  this Mac, and `runs_error` when git could not be read.
- The history is read from the plan's clone on demand and cached per clone HEAD; a task file renamed
  by hand is followed by its `id`.

## 0.1.0 (2026-10-27)

The first release: the v1 design in [docs/design/task-manager-v1/](docs/design/task-manager-v1/README.md)
built through its phases 0 to 5, and the work that followed them. Requires Paseo 0.13.0 or newer.

### Plan and sync

- The plan lives in a git repository (a space): `space.yaml`, releases, features, tasks with
  acceptance checklists, and inbox drafts, as Markdown files with front matter that keeps comments
  and key order on rewrite.
- Every change is an operation in a journal, pushed to the plan repository's default branch and
  applied idempotently, so a lost answer or a restart never applies it twice.
- Starting a task claims it with a push: two machines never run the same task, and the loser is
  told who holds it.
- Several spaces at once, shown in one dashboard; one personal plan repository can hold every
  project, grouped by umbrella.
- Create a plan repository on GitHub from the dashboard, connect an existing one (also an empty
  one, or one with only a README), and disconnect one from this machine.
- Plan repositories you can join are found by the topic `paseo-dashboard-plan`; "Share this space"
  invites and removes people on GitHub and GitLab with your own login; a setup check reports a
  GitLab default branch that Developers cannot push to.
- People and labels in `space.yaml`, with the "mine" filter resolved from this machine's git email.
- A feature becomes `done` when all its tasks are done, and `active` again when one reopens.

### Runs and progress

- Starting a task creates a worktree workspace and an agent whose first message is the brief, with
  the task's or the space's agent profile, and its mode or the provider's default; a released task started again continues
  on its branch and PR/MR.
- The agent gets `task_brief` and `task_report`; reports tick acceptance lines and show the
  agent's latest message.
- Progress from Paseo's lifecycle, the agent's reports and the pull or merge request on GitHub and
  GitLab: a ready PR/MR moves the task to `review`, a draft keeps it in progress, and a merge with
  the acceptance ticked moves it to `done`.
- The task screen's Result block shows the PR/MR's changes, checks and review state, with "Accept
  and mark done…" and "Send back to the agent".
- Work started directly in Paseo is listed per line, and a workspace can be tracked as a task.

### Views

- The metro map: repositories as lines, releases as columns, features as interchanges, tasks as
  stations, with feature and line views, on desktop and phone, in light and dark themes.
- Tasks (ready to start first, blockers linked), Inbox, Live, Roadmap, Projects, and People and
  labels tabs; a move action for a task's release, feature or line.
- A sidebar row with the needs-you count, Command Center items, a workspace panel, a composer
  pill, and timeline cards.
- `ROADMAP.md` with tables and Mermaid charts, and Obsidian Bases views, in the plan repository.

### Imports

- Laconote meetings to inbox drafts, from the meeting list with an API key or from a pasted export,
  with de-duplication per meeting.
- Open GitHub and GitLab issues to inbox drafts. A task can link to an issue; the start prompt asks
  the agent for the closing reference, so a merge into the default branch closes the issue.

### Forge issues

- A one-way mirror of tasks to GitHub and GitLab issues, off by default and switched on per space on
  one machine: open tasks (todo, in progress, review) in a project get an issue in that project's
  repository with the title, brief, labels and assignee; done and canceled close it and reopening
  reopens it. The mirror writes only issues it created, never linked or imported ones, and the plan
  stays the source. Not yet checked against a real GitHub or GitLab repository.

### ChatGPT through God Mode

- Sixteen operations in `meta.describe`: reads of the overview, tasks, a task, the roadmap, the
  inbox and the start and release checks, plan edits without a read-back, and `start_task` and
  `release_task` with a confirmation.
