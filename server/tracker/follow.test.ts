import { test } from "node:test";
import assert from "node:assert/strict";
import type { GitResult, GitRunner } from "../sync/git.ts";
import type { PaseoApi } from "../paseo.ts";
import type { RunRecord, RunStore } from "../runner/runs.ts";
import { CHANGED_MAX, mergeCall, program, repoPath, RunFollower } from "./follow.ts";
import { overlapsByTask } from "../api/view.ts";

/**
 * Events in the shapes the live daemon sent during a probe: Claude's
 * absolute paths that arrive a moment after the call, Codex's relative paths, a sub-agent whose last
 * event falls back to `unknown`, and prompts that show as `agent_message` calls.
 */

const ROOT = "/repo";
const T0 = Date.parse("2026-11-13T13:17:25.000Z");
const at = (ms: number) => new Date(T0 + ms).toISOString();

const call = (callId: string, name: string, status: string, detail: Record<string, unknown>) => ({ type: "tool_call", callId, name, status, detail, error: null });
const timeline = (item: unknown, ms: number) => ({ agentId: "a1", event: { type: "timeline", provider: "claude", item, timestamp: at(ms) } });
const settle = () => new Promise((resolve) => setImmediate(resolve));

class FakeTimeline {
  handler: ((message: unknown) => void) | undefined;
  history: { item: unknown; timestamp: string }[] = [];
  subscribes = 0;
  refetches = 0;
  released = 0;
  subscribe(handler: (message: unknown) => void) {
    this.subscribes += 1;
    this.handler = handler;
    const release = () => {
      this.released += 1;
    };
    return Object.assign(release, { ready: Promise.resolve(), subscriptionId: "s1", release: async () => release() });
  }
  async refetch() {
    this.refetches += 1;
    return { entries: this.history.map(({ item, timestamp }) => ({ item, timestamp, provider: "claude" })) };
  }
  send(message: unknown) {
    this.handler?.(message);
  }
}

function gitFake(answers: Record<string, string>): GitRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async run(_cwd: string, args: string[]): Promise<GitResult> {
      calls.push(args);
      const key = args.filter((arg) => arg !== "--no-optional-locks").join(" ");
      const stdout = answers[key];
      return stdout === undefined ? { code: 1, stdout: "", stderr: `no answer for ${key}`, timedOut: false } : { code: 0, stdout, stderr: "", timedOut: false };
    },
  };
}

const nul = (...paths: string[]) => paths.map((path) => `${path}\0`).join("");

const GIT = {
  "rev-parse --show-toplevel": `${ROOT}\n`,
  "symbolic-ref --quiet --short refs/remotes/origin/HEAD": "origin/master\n",
  "merge-base HEAD origin/master": "abc123\n",
  "diff --name-only -z abc123": nul("notes.txt", "src/math.ts"),
  "ls-files -z --others --exclude-standard": nul("src/greet.ts"),
};

function setup(git = gitFake(GIT), throttleMs = 0) {
  const tl = new FakeTimeline();
  const run = { run_id: "r1", agentId: "a1", activity: "working" } as RunRecord;
  let store: RunStore | undefined = { runs: new Map([["r1", run]]) } as unknown as RunStore;
  const paseo = { agents: { ref: () => ({ timeline: tl }) } } as unknown as PaseoApi;
  let clock = T0 + 60_000;
  let changes = 0;
  const follower = new RunFollower({ runs: () => store, paseo: () => paseo, git, throttleMs, now: () => clock, onChange: () => (changes += 1) });
  return { tl, run, follower, git, tick: (ms: number) => (clock += ms), changes: () => changes, loseData: () => (store = undefined) };
}

/** Git with no changes, for tests about the stream only. */
const quiet = () => gitFake({ ...GIT, "diff --name-only -z abc123": "", "ls-files -z --others --exclude-standard": "" });

test("a path is made relative to the repository root, absolute or relative, and /private is the same place", () => {
  assert.equal(repoPath("/repo/src/a.ts", "/repo", "/repo"), "src/a.ts");
  assert.equal(repoPath("src/a.ts", "/repo/pkg", "/repo"), "pkg/src/a.ts");
  assert.equal(repoPath("/private/tmp/w/src/a.ts", "/tmp/w", "/tmp/w"), "src/a.ts");
  assert.equal(repoPath("/Users/me/.codex/skills/x/SKILL.md", "/repo", "/repo"), null);
  assert.equal(repoPath("../other/a.ts", "/repo", "/repo"), null);
});

test("a shell command reads as its program, past cd and variable assignments", () => {
  assert.equal(program("sed -i.bak 's/foo/bar/' notes.txt && rm notes.txt.bak"), "sed");
  assert.equal(program("cd pkg && NODE_ENV=test npm test"), "npm");
  assert.equal(program("cat a; cat b"), "cat");
});

test("a call keeps its latest status and the latest detail that says something", () => {
  const first = mergeCall(undefined, call("c1", "Edit", "running", { type: "unknown", input: {} }), 1, ROOT, ROOT);
  assert.deepEqual([first.op, first.target, first.inRepo], ["tool", "Edit", false]);
  const known = mergeCall(first, call("c1", "Edit", "running", { type: "edit", filePath: "/repo/src/greet.ts" }), 2, ROOT, ROOT);
  assert.deepEqual([known.op, known.target, known.inRepo, known.startedAt], ["edit", "src/greet.ts", true, 1]);
  // An empty path says nothing: the known one stays.
  const empty = mergeCall(known, call("c1", "Edit", "running", { type: "edit", filePath: "" }), 3, ROOT, ROOT);
  assert.equal(empty.target, "src/greet.ts");
  // A Claude sub-agent's last event comes back as `unknown`; what was known stays.
  const sub = mergeCall(undefined, call("c2", "Task", "running", { type: "sub_agent", subAgentType: "Explore", description: "Read README first line" }), 3, ROOT, ROOT);
  const done = mergeCall(sub, call("c2", "Agent", "completed", { type: "unknown", input: { description: "x" } }), 4, ROOT, ROOT);
  assert.deepEqual([done.op, done.target, done.status, done.name], ["agent", "Read README first line", "completed", "Agent"]);
});

test("following refetches the tail once subscribed, so a turn's start before it is not lost, skips prompts and reads git", async () => {
  const t = setup();
  t.tl.history = [
    { item: call("p1", "agent_message", "completed", { type: "plain_text", text: "Do the steps" }), timestamp: at(0) },
    { item: call("c1", "Read", "completed", { type: "read", filePath: "/repo/src/index.ts", content: "x".repeat(5000) }), timestamp: at(100) },
  ];
  await t.follower.follow(t.run, ROOT);
  assert.equal(t.tl.refetches, 1);
  const view = t.follower.view("r1")!;
  assert.deepEqual(view.now, { op: "read", target: "src/index.ts", status: "completed", at: at(100) });
  // An idle run after a reload: git is read without waiting for a turn's end.
  assert.deepEqual(view.changed, ["notes.txt", "src/greet.ts", "src/math.ts"]);
});

test("live events update the latest call, and completed edits count as changed until git answers again", async () => {
  const t = setup(quiet());
  await t.follower.follow(t.run, ROOT);
  t.tick(1);
  t.tl.send(timeline(call("c1", "Write", "running", { type: "unknown", input: {} }), 61_000));
  t.tl.send(timeline(call("c1", "Write", "running", { type: "write", filePath: "/repo/src/bye.ts" }), 61_500));
  assert.deepEqual(t.follower.view("r1")!.now, { op: "write", target: "src/bye.ts", status: "running", at: at(61_000) });
  assert.deepEqual(t.follower.view("r1")!.changed, []);
  t.tl.send(timeline(call("c1", "Write", "completed", { type: "write", filePath: "/repo/src/bye.ts", content: "export {}" }), 62_500));
  // Codex: a relative path from the first event, an edit that takes milliseconds.
  t.tl.send(timeline(call("c2", "apply_patch", "running", { type: "edit", filePath: "src/greet.ts" }), 63_000));
  t.tl.send(timeline(call("c2", "apply_patch", "completed", { type: "edit", filePath: "src/greet.ts", unifiedDiff: "@@" }), 63_018));
  // A file outside the repository is not one of the run's.
  t.tl.send(timeline(call("c3", "Write", "completed", { type: "write", filePath: "/tmp/scratch.txt" }), 63_100));
  assert.deepEqual(t.follower.view("r1")!.changed, ["src/bye.ts", "src/greet.ts"]);
});

test("at a turn's end git is the truth: shell writes and untracked files count, a reverted file does not", async () => {
  const t = setup();
  await t.follower.follow(t.run, ROOT);
  t.tick(1);
  t.tl.send(timeline(call("c1", "Edit", "completed", { type: "edit", filePath: "/repo/src/math.ts" }), 61_000));
  t.tl.send(timeline(call("c2", "Bash", "completed", { type: "shell", command: "sed -i.bak 's/foo/bar/' notes.txt && rm notes.txt.bak" }), 62_000));
  t.tl.send(timeline(call("c4", "Write", "completed", { type: "write", filePath: "/repo/src/reverted.ts" }), 62_500));
  assert.ok(t.follower.view("r1")!.changed.includes("src/reverted.ts"));
  t.tick(10_000);
  await t.follower.turnEnded("r1");
  assert.deepEqual(t.follower.view("r1")!.changed, ["notes.txt", "src/greet.ts", "src/math.ts"]);
  assert.ok(t.git.calls.every((args) => args[0] === "--no-optional-locks" || ["rev-parse", "symbolic-ref"].includes(args[0]!)));
  // An edit completed after git read counts again until the next turn's end.
  t.tl.send(timeline(call("c5", "Edit", "completed", { type: "edit", filePath: "/repo/src/new.ts" }), 80_000));
  assert.deepEqual(t.follower.view("r1")!.changed, ["notes.txt", "src/greet.ts", "src/math.ts", "src/new.ts"]);
});

test("without a remote default branch the changes are read against HEAD", async () => {
  const { "symbolic-ref --quiet --short refs/remotes/origin/HEAD": _gone, ...rest } = GIT;
  const t = setup(gitFake({ ...rest, "diff --name-only -z HEAD": nul("src/math.ts") }));
  await t.follower.follow(t.run, ROOT);
  assert.deepEqual(t.follower.view("r1")!.changed, ["src/greet.ts", "src/math.ts"]);
});

test("a Codex path relative to a cwd under the repository root is the root's path, as git lists it", async () => {
  const t = setup(gitFake({ ...GIT, "diff --name-only -z abc123": nul("pkg/src/a.ts"), "ls-files -z --others --exclude-standard": "" }));
  await t.follower.follow(t.run, "/repo/pkg");
  t.tick(1);
  t.tl.send(timeline(call("c1", "apply_patch", "completed", { type: "edit", filePath: "src/b.ts" }), 61_000));
  assert.deepEqual(t.follower.view("r1")!.changed, ["pkg/src/a.ts", "pkg/src/b.ts"]);
});

test("a restored subscription refetches: a call in flight during the gap gets its completion", async () => {
  const t = setup(quiet());
  await t.follower.follow(t.run, ROOT);
  t.tick(1);
  t.tl.send(timeline(call("c1", "Edit", "running", { type: "edit", filePath: "/repo/src/a.ts" }), 61_000));
  t.tl.history = [{ item: call("c1", "Edit", "completed", { type: "edit", filePath: "/repo/src/a.ts" }), timestamp: at(62_000) }];
  t.tl.send({ agentId: "a1", subscriptionId: "s1", event: { type: "subscription_restored" } });
  await settle();
  assert.equal(t.tl.refetches, 2);
  assert.deepEqual(t.follower.view("r1")!.now?.status, "completed");
  assert.deepEqual(t.follower.view("r1")!.changed, ["src/a.ts"]);
  // An older event never overwrites a newer state, from a page or from the stream.
  t.tl.send(timeline(call("c1", "Edit", "running", { type: "edit", filePath: "/repo/src/a.ts" }), 61_500));
  assert.equal(t.follower.view("r1")!.now?.status, "completed");
  t.tl.history = [{ item: call("c1", "Edit", "running", { type: "edit", filePath: "/repo/src/a.ts" }), timestamp: at(61_000) }];
  t.tl.send({ agentId: "a1", subscriptionId: "s1", event: { type: "subscription_restored" } });
  await settle();
  assert.equal(t.follower.view("r1")!.now?.status, "completed");
});

test("a subscription error unfollows, so the next turn follows again", async () => {
  const t = setup(quiet());
  await t.follower.follow(t.run, ROOT);
  t.tl.send({ agentId: "a1", event: { type: "error", error: "socket closed" } });
  assert.equal(t.follower.isFollowing("r1"), false);
  assert.equal(t.tl.released, 1);
  await t.follower.follow(t.run, ROOT);
  assert.equal(t.tl.subscribes, 2);
  assert.equal(t.follower.isFollowing("r1"), true);
});

test("a stopped run, another agent on the run, or lost data ownership is no longer followed", async () => {
  const t = setup(quiet());
  await t.follower.follow(t.run, ROOT);
  t.run.agentId = "a2";
  t.follower.sweep();
  assert.equal(t.follower.isFollowing("r1"), false);
  await t.follower.follow(t.run, ROOT);
  assert.equal(t.follower.isFollowing("r1"), true);
  t.loseData();
  t.follower.sweep();
  assert.equal(t.follower.isFollowing("r1"), false);
  assert.equal(t.tl.released, 2);
});

test("following twice subscribes once", async () => {
  const t = setup(quiet());
  await t.follower.follow(t.run, ROOT);
  await t.follower.follow(t.run, ROOT);
  assert.equal(t.tl.subscribes, 1);
});

test("the revision moves only when what a screen shows moves, and at most once per throttle window", async () => {
  const t = setup(quiet(), 40);
  await t.follower.follow(t.run, ROOT);
  const base = t.changes();
  t.tl.send(timeline(call("c1", "Bash", "running", { type: "shell", command: "npm test" }), 61_000));
  t.tl.send(timeline(call("c2", "Bash", "running", { type: "shell", command: "npm run lint" }), 61_100));
  // Only the status moves: a screen shows the same call, nothing new to read.
  t.tl.send(timeline(call("c2", "Bash", "completed", { type: "shell", command: "npm run lint" }), 61_200));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok(t.changes() - base <= 2, `changes: ${t.changes() - base}`);
  assert.ok(t.changes() - base >= 1);
});

test("a new call with the same operation and target moves the revision: a screen shows its age", async () => {
  const t = setup(quiet());
  await t.follower.follow(t.run, ROOT);
  t.tl.send(timeline(call("c1", "Bash", "completed", { type: "shell", command: "git status" }), 61_000));
  const before = t.follower.revision;
  t.tl.send(timeline(call("c2", "Bash", "running", { type: "shell", command: "git diff" }), 64_000));
  assert.equal(t.follower.view("r1")!.now?.at, at(64_000));
  assert.equal(t.follower.nowOf("r1")?.at, at(64_000));
  assert.ok(t.follower.revision > before);
});

test("changed files beyond the cap are counted, not listed", async () => {
  const many = Array.from({ length: CHANGED_MAX + 5 }, (_, i) => `f${String(i).padStart(4, "0")}.ts`);
  const t = setup(gitFake({ ...GIT, "diff --name-only -z abc123": nul(...many), "ls-files -z --others --exclude-standard": "" }));
  await t.follower.follow(t.run, ROOT);
  const view = t.follower.view("r1")!;
  assert.equal(view.changed.length, CHANGED_MAX);
  assert.equal(view.more, 5);
});

test("runs of one repository that changed the same files overlap; another repository's run does not", async () => {
  const diffs: Record<string, string[]> = { "/w1": ["src/a.ts", "src/b.ts"], "/w2": ["src/b.ts", "src/c.ts", "src/a.ts"], "/w3": ["src/a.ts"] };
  const git: GitRunner = {
    async run(cwd: string, args: string[]): Promise<GitResult> {
      const key = args.filter((arg) => arg !== "--no-optional-locks").join(" ");
      const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", timedOut: false });
      if (key === "rev-parse --show-toplevel") return ok(`${cwd}\n`);
      if (key === "diff --name-only -z HEAD") return ok(nul(...(diffs[cwd] ?? [])));
      if (key === "ls-files -z --others --exclude-standard") return ok("");
      return { code: 1, stdout: "", stderr: "no origin/HEAD", timedOut: false };
    },
  };
  const runs = new Map(["r1", "r2", "r3"].map((id, i) => [id, { run_id: id, agentId: `a${i + 1}`, activity: "working" } as RunRecord]));
  const timelines = new Map<string, FakeTimeline>();
  const paseo = { agents: { ref: (id: string) => ({ timeline: timelines.get(id) ?? timelines.set(id, new FakeTimeline()).get(id)! }) } } as unknown as PaseoApi;
  const follower = new RunFollower({ runs: () => ({ runs }) as unknown as RunStore, paseo: () => paseo, git, throttleMs: 0 });
  await follower.follow(runs.get("r1")!, "/w1");
  await follower.follow(runs.get("r2")!, "/w2");
  await follower.follow(runs.get("r3")!, "/w3");
  const groups: Record<string, string> = { r1: "prj_core", r2: "prj_core", r3: "prj_site" };
  const overlaps = follower.overlaps((id) => groups[id]);
  assert.deepEqual(overlaps.get("r1"), [{ runId: "r2", files: ["src/a.ts", "src/b.ts"] }]);
  assert.deepEqual(overlaps.get("r2"), [{ runId: "r1", files: ["src/a.ts", "src/b.ts"] }]);
  assert.equal(overlaps.get("r3"), undefined);
});

test("a run counts in the radar only while it is its task's live run, not stopped, with a project; two runs of a task are no collision", () => {
  const run = (run_id: string, task: string, extra: Partial<RunRecord> = {}) => ({ run_id, task, projectId: "prj_core", activity: "working", ...extra }) as RunRecord;
  const all = [
    run("r1", "T1"),
    run("r2", "T2"),
    run("r3", "T3", { activity: "stopped" }),
    run("r4", "T4"),
    run("r5", "T5", { projectId: "" }),
    run("r6", "T1"),
  ];
  const runs = { runs: new Map(all.map((r) => [r.run_id, r])) } as unknown as RunStore;
  const files: Record<string, string[]> = { r1: ["a.ts"], r2: ["a.ts", "b.ts"], r3: ["a.ts"], r4: ["a.ts"], r5: ["a.ts"], r6: ["a.ts", "c.ts"] };
  // As RunFollower.overlaps does: runs of one group that share files.
  const follower = {
    overlaps(groupOf: (runId: string) => string | undefined) {
      const ids = Object.keys(files).filter((id) => groupOf(id));
      return new Map(
        ids.map((id) => [id, ids.filter((o) => o !== id && files[o]!.some((f) => files[id]!.includes(f))).map((o) => ({ runId: o, files: files[o]!.filter((f) => files[id]!.includes(f)) }))]),
      );
    },
  };
  // T4's run is no longer its task's live run (merged, its agent still open).
  const isLive = (r: RunRecord) => r.task !== "T4";
  const overlaps = overlapsByTask({ runs, follower, isLive });
  assert.deepEqual(overlaps.get("T1"), [{ task: "T2", files: ["a.ts"], more: 0 }]);
  assert.deepEqual(overlaps.get("T2"), [{ task: "T1", files: ["a.ts"], more: 0 }]);
  for (const gone of ["T3", "T4", "T5"]) assert.equal(overlaps.get(gone), undefined, gone);
});

test("files beyond the cap a screen lists are compared all the same", async () => {
  const many = Array.from({ length: CHANGED_MAX + 3 }, (_, i) => `f${String(i).padStart(4, "0")}.ts`);
  const git: GitRunner = {
    async run(cwd: string, args: string[]): Promise<GitResult> {
      const key = args.filter((arg) => arg !== "--no-optional-locks").join(" ");
      const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", timedOut: false });
      if (key === "rev-parse --show-toplevel") return ok(`${cwd}\n`);
      if (key === "diff --name-only -z HEAD") return ok(cwd === "/w1" ? nul(...many) : nul(many[CHANGED_MAX + 2]!));
      if (key === "ls-files -z --others --exclude-standard") return ok("");
      return { code: 1, stdout: "", stderr: "", timedOut: false };
    },
  };
  const runs = new Map(["r1", "r2"].map((id, i) => [id, { run_id: id, agentId: `a${i}`, activity: "working" } as RunRecord]));
  const timelines = new Map<string, FakeTimeline>();
  const paseo = { agents: { ref: (id: string) => ({ timeline: timelines.get(id) ?? timelines.set(id, new FakeTimeline()).get(id)! }) } } as unknown as PaseoApi;
  const follower = new RunFollower({ runs: () => ({ runs }) as unknown as RunStore, paseo: () => paseo, git, throttleMs: 0 });
  await follower.follow(runs.get("r1")!, "/w1");
  await follower.follow(runs.get("r2")!, "/w2");
  assert.ok(!follower.view("r1")!.changed.includes(many[CHANGED_MAX + 2]!));
  assert.deepEqual(follower.overlaps(() => "prj").get("r1"), [{ runId: "r2", files: [many[CHANGED_MAX + 2]!] }]);
});

test("a run's code files: changed ones from git and edits, read ones apart, a reverted edit not, at most 300 touched", async () => {
  const t = setup(gitFake({ ...GIT, "diff --name-only -z abc123": nul("src/a.ts"), "ls-files -z --others --exclude-standard": "" }));
  await t.follower.follow(t.run, ROOT);
  t.tick(1);
  t.tl.send(timeline(call("c1", "Read", "completed", { type: "read", filePath: "/repo/src/b.ts" }), 61_000));
  t.tl.send(timeline(call("c2", "Edit", "completed", { type: "edit", filePath: "/repo/src/a.ts" }), 61_500));
  t.tl.send(timeline(call("c3", "Edit", "completed", { type: "edit", filePath: "/repo/src/gone.ts" }), 61_600));
  t.tl.send(timeline(call("c4", "Read", "completed", { type: "read", filePath: "/outside/x.ts" }), 61_700));
  t.tick(10_000);
  await t.follower.turnEnded("r1");
  const code = t.follower.codeFiles("r1")!;
  assert.equal(code.root, ROOT);
  assert.deepEqual(
    code.files.map((f) => [f.path, f.state, Boolean(f.at)]),
    [
      ["src/a.ts", "changed", true],
      ["src/b.ts", "read", true],
    ],
    "src/gone.ts was edited and reverted: git no longer lists it",
  );
  for (let i = 0; i < 301; i++) t.tl.send(timeline(call(`r${i}`, "Read", "completed", { type: "read", filePath: `/repo/many/f${i}.ts` }), 90_000 + i));
  const paths = t.follower.codeFiles("r1")!.files.map((f) => f.path);
  assert.ok(!paths.includes("src/b.ts"), "the oldest touched file went first");
  assert.ok(paths.includes("many/f300.ts"));
  assert.equal(t.follower.codeFiles("nope"), undefined);
});
