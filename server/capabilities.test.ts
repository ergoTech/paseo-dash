import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { PluginRpcContract } from "@getpaseo/plugin";
import { z } from "zod";
import contribute from "../index.server.ts";
import { overviewRpc } from "../shared/overview.ts";
import { resumeCheckRpc, resumeTaskRpc, tasksGetRpc, tasksResultRpc, tasksStartSetRpc } from "../shared/api.ts";
import { tasksSendBackRpc } from "../shared/ui.ts";
import { QUESTION_NEXT } from "./needs.ts";
import { START_RULES } from "./api/start-set.ts";
import { autopilotReadRpc, autopilotSetRpc } from "../shared/ui.ts";
import { VERSION } from "../shared/version.ts";
import { compactSchema, describeDashboard, describeRpc, identity, OPERATIONS, operations } from "./capabilities.ts";
import { TIER_SETTINGS } from "./runner/model-policy.ts";
import { DEV, PLUGIN_NAME } from "../shared/edition.ts";
import { Dashboard } from "./dashboard.ts";
import { readOverview } from "./overview.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// What a caller would send for each operation.
const EXAMPLES: Record<string, Record<string, unknown>> = {
  overview: {},
  tasks: { space: "Laconote", status: "open", query: "totp", label: "bug", mine: true, limit: 5 },
  task: { task: "LAC-7K3QX" },
  task_result: { task: "TOTP endpoints" },
  roadmap: { milestone: "Release 2.3" },
  inbox: { limit: 10 },
  start_check: { task: "TOTP endpoints", profile: "Implementation" },
  release_check: { task: "force 2FA" },
  accept_check: { task: "TOTP contract" },
  autopilot: {},
  add_to_inbox: {
    items: [{ title: "Android: show the TOTP enrollment QR", project: "android" }, { title: "Decide recovery-code count", note: "with security" }],
    source_url: "https://laconote.com/meeting/0d4c7e",
    source_title: "Weekly sync, 24 Oct",
  },
  create_task: { title: "TOTP endpoints in core", project: "core", feature: "TOTP", priority: "high", labels: ["backend"], depends_on: ["LAC-5RT2M"] },
  update_task: { task: "LAC-7K3QX", status: "todo", project: "core", add_labels: ["security"], remove_labels: ["ui"] },
  update_tasks: { items: [{ task: "LAC-7K3QX", agent_profile: "Sonnet 5.5 High" }, { task: "LAC-5RT2M", agent_profile: "" }], revision: "0f3a9c2b1d4e5f60", key: "batch-2026-11-25-1" },
  task_text: { task: "LAC-7K3QX", section: "brief", cursor: 4000, revision: "0f3a9c2b1d4e5f60" },
  delivery: { task: "LAC-7K3QX" },
  reconcile: { space: "LAC", task: "LAC-7K3QX" },
  start_candidates: { space: "LAC", group: "agent", limit: 20 },
  tasks_profiles: { tasks: ["LAC-7K3QX", "TOTP contract"] },
  start_task: { task: "LAC-7K3QX" },
  start_plan: { tasks: ["LAC-7K3QX", "TOTP contract"] },
  start_tasks_check: { tasks: ["LAC-7K3QX", "LAC-5RT2M"] },
  resume_check: { task: "LAC-7K3QX" },
  resume_task: { task: "LAC-7K3QX" },
  start_tasks: { tasks: ["LAC-7K3QX", "LAC-5RT2M"] },
  release_task: { task: "force 2FA", to: "todo" },
  accept_task: { task: "TOTP contract" },
  send_back: { task: "LAC-5RT2M", comment: "Name the recovery-code endpoint as in the API guide." },
  create_milestone: { title: "Release 2.4", due: "2026-12-15" },
  update_milestone: { milestone: "Release 2.3", status: "active" },
  create_feature: { title: "TOTP two-factor authentication", branch: "feat/totp-2fa", projects: ["core", "site"] },
  update_feature: { feature: "TOTP", status: "done" },
  events: { space: "LAC", after: 3, limit: 10 },
  mark_events_read: { through: 7 },
  recap: { since: "2026-10-23", space: "LAC", kinds: ["done", "merged"], limit: 20 },
};

// The SDK's and God Mode's rule for RPC names (lower case only).
const RPC_NAME = /^[a-z][a-z0-9._-]*$/;
// God Mode's rule for field names whose text it never passes on.
const SECRET = /token|secret|password|passwd|credential|cookie|bearer|authorization|api.?key|private.?key/i;

/** The RPC names index.server.ts registers, collected through a fake server context. */
function registeredMethods(): string[] {
  const names: string[] = [];
  const server = {
    handle: (contract: PluginRpcContract) => {
      names.push(contract.name);
    },
    on: () => () => undefined,
    before: () => () => undefined,
  };
  const cleanup = contribute(server as never);
  assert.equal(typeof cleanup, "function", "contribute returns its cleanup synchronously");
  return names;
}

/** Top-level keys of a zod object schema; anything else fails the test that asked. */
function keysOf(schema: unknown, what: string): string[] {
  assert.ok(schema instanceof z.ZodObject, `${what} is a zod object`);
  return Object.keys(schema.shape);
}

/**
 * Every property name in a schema at any depth, read from its rendered JSON Schema, so unions,
 * defaults, records and pipes are walked too.
 */
function allKeys(schema: z.ZodType): string[] {
  const names: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (record.properties && typeof record.properties === "object") {
      names.push(...Object.keys(record.properties));
    }
    Object.values(record).forEach(walk);
  };
  walk(z.toJSONSchema(schema, { io: "output" }));
  return names;
}

test("the description matches its own contract and travels as plain JSON", () => {
  const described = describeDashboard();
  assert.deepEqual(describeRpc.output.parse(described), described);
  assert.deepEqual(JSON.parse(JSON.stringify(described)), described);
  assert.equal(describeRpc.name, "meta.describe");
  assert.equal(describeDashboard(), described, "rendered once");
});

test("the plugin is Paseo Dash to ChatGPT, PD for short; a development copy names itself apart and claims neither", () => {
  const release = identity(false);
  assert.equal(release.title, "Paseo Dash");
  assert.ok(release.aliases.includes("PD") && release.aliases.includes("ПД"));
  assert.match(release.summary, /«PD» always means this plugin/);
  assert.match(release.summary, /«в PD заведи таску», «подивись PD»/);
  const dev = identity(true);
  assert.equal(dev.title, "Paseo Dash Dev");
  assert.match(dev.summary, /«PD» and «Paseo Dash» mean the installed plugin/);
  const shared = dev.aliases.filter((alias) => release.aliases.some((other) => other.toLowerCase() === alias.toLowerCase()));
  assert.deepEqual(shared, [], "no name both copies answer to");
  // God Mode keeps 300 characters of a summary, 20 aliases and 60 characters of each.
  for (const own of [release, dev]) {
    assert.ok(own.summary.length <= 300, String(own.summary.length));
    assert.ok(own.aliases.length <= 20 && own.aliases.every((alias) => alias.length <= 60));
  }
  for (const on of [false, true]) {
    assert.equal(describeDashboard(on, false).title, "Paseo Dash");
    assert.equal(describeDashboard(on, true).title, "Paseo Dash Dev");
    assert.deepEqual(describeDashboard(on, true).operations, describeDashboard(on, false).operations, "the same operations");
  }
  assert.equal(describeDashboard().title, PLUGIN_NAME, "this checkout describes itself as its edition");
  assert.equal(PLUGIN_NAME, DEV ? "Paseo Dash Dev" : "Paseo Dash");
});

test("every operation points at a registered RPC with a valid lower-case name", () => {
  const registered = registeredMethods();
  assert.ok(registered.includes("meta.describe"), "meta.describe is registered");
  for (const name of registered) assert.match(name, RPC_NAME, `${name} is a valid RPC name`);
  for (const op of describeDashboard().operations) {
    assert.ok(registered.includes(op.method), `${op.id}: ${op.method} is registered`);
    assert.ok(!op.method.startsWith("meta."), `${op.id}: meta.* is reserved`);
  }
});

test("adding and removing spaces, ChatGPT's own settings and the plan tools' switch are registered but not described (06-god-mode.md)", () => {
  const registered = registeredMethods();
  for (const name of ["spaces.add", "spaces.create", "spaces.disconnect", "godmode.settings", "godmode.settings.set", "agents.plan_tools", "agents.plan_tools.set"]) {
    assert.ok(registered.includes(name), `${name} is registered`);
    for (const on of [false, true]) assert.ok(!describeDashboard(on).operations.some((op) => op.method === name), `${name} is not described`);
  }
});

test("starting without asking describes start_task and start_tasks as low actions with the fixed flag, and changes nothing else", () => {
  const off = describeDashboard(false);
  const on = describeDashboard(true);
  assert.equal(describeDashboard(true), on, "each form rendered once");
  assert.deepEqual(describeRpc.output.parse(on), on);
  const start = (c: typeof on) => c.operations.find((op) => op.id === "start_task")!;
  assert.equal(start(off).risk, "outward", "God Mode asks first for every risk above low");
  assert.equal(start(off).fixed, undefined, "asking first, the start is not marked");
  assert.equal(start(on).risk, "low", "and never for a low one");
  assert.deepEqual(start(on).fixed, { without_asking: true });
  assert.equal(start(on).target, undefined, "God Mode reads no target for an action that does not ask");
  assert.equal(start(on).confirmText, undefined);
  assert.deepEqual(start(on).input, start(off).input, "the caller supplies the same arguments");
  assert.equal(start(on).method, "tasks.start");
  assert.match(start(on).description!, /permission mode/);
  const set = (c: typeof on) => c.operations.find((op) => op.id === "start_tasks")!;
  assert.equal(set(off).risk, "outward");
  assert.equal(set(on).risk, "low");
  assert.deepEqual(set(on).fixed, { without_asking: true });
  assert.equal(set(on).target, undefined);
  assert.deepEqual(set(on).input, set(off).input);
  const others = (c: typeof on) => c.operations.filter((op) => op.id !== "start_task" && op.id !== "start_tasks");
  assert.deepEqual(others(on), others(off));
});

test("both forms of start_task fit God Mode's 600 characters and say what counts as the user's request", () => {
  const start = (on: boolean) => describeDashboard(on).operations.find((op) => op.id === "start_task")!;
  for (const on of [false, true]) {
    assert.ok(start(on).description!.length <= 600, `${on}: ${start(on).description!.length}`);
    assert.match(start(on).description!, on ? /a task create_task queued starts on its own/ : /or create_task answered asks_first for it/);
  }
  // Asking first: the confirmation is the user's word in the chat, never a dialog somewhere else,
  // and only the user stops the read-back, never ChatGPT. The full rules travel with start_plan.
  assert.match(start(false).description!, /Say confirm_text, ask nothing else: the user's yes in this chat, or the start asked again after it, confirms it; no dialog elsewhere/);
  assert.match(start(false).description!, /Only the user stops read-backs \(Paseo Dash: Start tasks without asking\); you cannot/);
  assert.match(start(false).confirmText!, /Start it\?$/, "the read-back ends with the question the user answers");
});

test("the arguments ChatGPT is given keep the contract's names, types, enums and required, without bounds (JOBBY-NY4D4)", () => {
  const props = (schema: unknown) => (schema as { properties: Record<string, Record<string, unknown>> }).properties;
  for (const on of [false, true]) {
    for (const op of describeDashboard(on).operations) {
      const spec = operations(on).find((o) => o.id === op.id)!;
      const full = z.toJSONSchema(spec.input, { io: "input" }) as { properties: Record<string, Record<string, unknown>>; required?: string[] };
      assert.deepEqual(Object.keys(props(op.input)), Object.keys(full.properties), `${op.id}: the same arguments`);
      assert.deepEqual((op.input as { required?: string[] }).required, full.required, `${op.id}: the same required`);
      for (const [name, prop] of Object.entries(props(op.input))) {
        const whole = full.properties[name]!;
        if (whole.enum) assert.deepEqual(prop.enum, whole.enum, `${op.id}.${name}: enum`);
        else assert.deepEqual(prop.type, whole.type, `${op.id}.${name}: type`);
      }
      const text = JSON.stringify(op.input);
      for (const bound of ["minLength", "maxLength", "minItems", "maxItems", "minimum", "maximum", "pattern", "default"]) {
        assert.ok(!text.includes(`"${bound}":`), `${op.id}: no ${bound}`);
      }
    }
  }
  // A property that happens to be named like a keyword is a name and stays.
  assert.deepEqual(
    compactSchema({ type: "object", properties: { default: { type: "string", maxLength: 3 }, kind: { type: "string", enum: ["a"] } }, required: ["default"] }),
    { type: "object", properties: { default: { type: "string" }, kind: { enum: ["a"] } }, required: ["default"] },
  );
});

test("example inputs pass the advertised input and, with fixed, the real contract", () => {
  for (const op of [...OPERATIONS, ...operations(true)]) {
    const example = EXAMPLES[op.id];
    assert.ok(example, `${op.id} has an example`);
    op.input.parse(example);
    op.contract.input.parse({ ...example, ...(op.fixed ?? {}) });
    for (const key of Object.keys(op.fixed ?? {})) {
      assert.ok(!keysOf(op.input, `${op.id} input`).includes(key), `${op.id}: fixed ${key} is not offered`);
    }
  }
});

test("meta.describe offers the label and mine filters and labels on the writes (09-forge-issues.md, F1)", () => {
  const described = describeDashboard();
  const op = (id: string) => described.operations.find((o) => o.id === id)!;
  const props = (id: string) => (op(id).input as { properties: Record<string, { type?: string; items?: unknown; description?: string }> }).properties;
  for (const read of ["tasks", "inbox"]) {
    assert.equal(props(read).label?.type, "string", `${read} filters by label`);
    assert.equal(props(read).mine?.type, "boolean", `${read} filters to the user's own`);
  }
  assert.equal(props("create_task").labels?.type, "array");
  assert.equal(props("update_task").add_labels?.type, "array");
  assert.equal(props("update_task").remove_labels?.type, "array");
  assert.equal(props("update_task").labels, undefined, "no list-valued replacement that would undo another machine's label");
  const item = (props("add_to_inbox").items as { items: { properties: Record<string, { type?: string }> } }).items;
  assert.equal(item.properties.labels?.type, "array");
  // No output.fields: God Mode passes the whole answer of the read.
  assert.equal(op("task").output, undefined);
  for (const field of ["labels", "issue", "issue_state"]) assert.ok(field in tasksGetRpc.output.shape, field);
  assert.ok(op("start_task").target!.show.includes("issue"), "the start confirmation says whether the issue closes");
});

test("every description and read-back fits the 600 characters God Mode keeps, with or without asking", () => {
  for (const on of [false, true]) {
    for (const op of describeDashboard(on).operations) {
      assert.ok((op.description ?? "").length <= 600, `${op.id}: description ${op.description?.length}`);
      if (op.confirmText) assert.ok(op.confirmText.length <= 600, `${op.id}: confirmText ${op.confirmText.length}`);
    }
  }
});

test("work from voice is filed as a task, and a direct chat picks by the model policy's tiers (JOBBY-YDNB7)", () => {
  for (const on of [false, true]) {
    const op = (id: string) => describeDashboard(on).operations.find((o) => o.id === id)!;
    const said = op("create_task").description!;
    assert.match(said, /^A chat only if asked: project work, by voice too, is a task here with a short brief and concrete acceptance\./);
    assert.match(said, /start_chat on Claude, no runtime, model or effort named: pass model, thinking/);
    assert.ok("agent_profile" in (op("create_task").input as { properties: object }).properties, "a profile the user names goes with the task");
    const { clear, localized, complex } = TIER_SETTINGS;
    assert.ok(said.includes(`clear local fix ${clear.model} ${clear.effort};`), "the clear tier");
    assert.ok(said.includes(`harder local ${localized.model} ${localized.effort};`), "the localized tier");
    assert.ok(said.includes(`unclear, architecture, cross-repo or risky ${complex.model} ${complex.effort}.`), "the complex tier");
    for (const id of ["start_check", "start_task"]) {
      const profile = (op(id).input as { properties: { profile: { description: string } } }).properties.profile.description;
      assert.match(profile, /^Only if the user named one/);
      assert.ok(profile.length <= 80, `God Mode shows 80 characters of an argument's description: ${profile.length}`);
    }
  }
});

test("the reads name what waits for the user and the next step, the same way", () => {
  const ops = describeDashboard().operations;
  const op = (id: string) => ops.find((o) => o.id === id)!;
  assert.match(op("overview").description!, /checkout: a trunk checkout ended, not a failure/);
  assert.match(op("overview").description!, /say each next and follow it/);
  assert.ok("needs" in tasksGetRpc.output.shape && "next" in tasksGetRpc.output.shape);
  assert.match(op("tasks").description!, /needs, next/);
  assert.ok(op("autopilot").output!.fields.includes("runs"));
  assert.match(op("autopilot").description!, /a stopped or failed one, or review awaiting acceptance, does not/);
});

test("the recap's description fits the 600 characters God Mode keeps of a description", () => {
  const recap = describeDashboard().operations.find((op) => op.id === "recap")!;
  assert.ok(recap.description!.length <= 600, String(recap.description!.length));
  assert.match(recap.description!, /narrow with kinds or a later since/);
});

test("an agent's question leads to God Mode's question tools through the answers that meet it (JOBBY-RTWBY)", () => {
  // Not promised to a God Mode without them, and never answered for the user. Overview's needs_you,
  // tasks and task say it as a question's next, events as its next (server/states.test.ts).
  assert.match(QUESTION_NEXT, /read_approval, then answer_questions/);
  assert.match(QUESTION_NEXT, /God Mode 0\.15\+/);
  assert.match(QUESTION_NEXT, /only the user's own choices/);
  assert.match(QUESTION_NEXT, /never answer_approval/);
  const op = (id: string) => describeDashboard().operations.find((o) => o.id === id)!;
  assert.match(op("overview").description!, /say each next and follow it/);
  assert.match(op("events").description!, /next: what to do once they are told; follow it/);
  assert.ok(op("events").output!.fields.includes("next"), "events' next reaches ChatGPT");
});

test("ChatGPT reads the autopilot and may resume one paused task, but is offered no way to set it (JOBBY-TGHP0)", () => {
  for (const on of [false, true]) {
    const ops = describeDashboard(on).operations;
    const autopilot = ops.find((op) => op.id === "autopilot")!;
    assert.equal(autopilot.kind, "read");
    assert.equal(autopilot.method, autopilotReadRpc.name);
    assert.ok(autopilot.description!.length <= 600, String(autopilot.description!.length));
    assert.match(autopilot.description!, /only the user sets it, in Paseo Dash\. A paused task: resume_task/);
    assert.ok(!ops.some((op) => op.method === autopilotSetRpc.name), "autopilot.set stays on the Paseo Dash screens");
    const resume = ops.find((op) => op.id === "resume_task")!;
    assert.equal(resume.method, resumeTaskRpc.name);
    // One task, by name: no project, no limit, no start defaults, no switch.
    assert.deepEqual(Object.keys((resume.input as { properties: object }).properties), ["task"]);
    assert.deepEqual(Object.keys(resumeTaskRpc.input.shape), ["task"]);
    assert.ok(resume.description!.length <= 600);
    assert.match(resume.description!, /queued \(waits\), launching \(not yet working\), working/);
    // A resume may start an agent with nobody watching: always read back, whatever the start switch says.
    assert.deepEqual([resume.risk, resume.fixed], ["outward", undefined]);
    assert.deepEqual(resume.target, { read: "resume_check", args: { task: "task" }, show: ["title", "paused", "then"] });
    assert.match(resume.confirmText!, /^Resume «\{target\.title\}» on this Mac's autopilot\. Paused: \{target\.paused\}\. \{target\.then\} Resume it\?$/);
    const check = ops.find((op) => op.id === "resume_check")!;
    assert.deepEqual([check.kind, check.method, check.untrusted], ["read", resumeCheckRpc.name, true]);
  }
});

test("task_result is an untrusted read of the PR/MR's checks and review that fits 600 characters", () => {
  const op = describeDashboard().operations.find((o) => o.id === "task_result")!;
  assert.equal(op.kind, "read");
  assert.equal(op.method, "tasks.result");
  assert.equal(op.untrusted, true, "check names and the PR/MR title are written by the repository, not the user");
  assert.deepEqual(op.outcome, { error: "error" });
  assert.ok(op.description!.length <= 600, String(op.description!.length));
  assert.match(op.description!, /Changes nothing/);
  assert.equal(op.output, undefined, "the whole answer");
  for (const field of ["pr", "state", "checks", "failing", "review"]) assert.ok(field in tasksResultRpc.output.shape, field);
});

test("accepting work reads back the PR/MR's checks and who holds the task; sending it back runs at once (06-god-mode.md)", () => {
  for (const on of [false, true]) {
    const ops = describeDashboard(on).operations;
    const op = (id: string) => ops.find((o) => o.id === id)!;
    for (const id of ["overview", "release_task", "accept_check", "accept_task", "send_back"]) {
      assert.ok((op(id).description ?? "").length <= 600, `${id}: ${op(id).description?.length}`);
    }
    const accept = op("accept_task");
    assert.equal(accept.method, "tasks.release", "the same release the task screen's Accept and mark done makes");
    assert.deepEqual(accept.fixed, { to: "done" });
    assert.equal(accept.risk, "disruptive", "as release_task: it ends the hold and stops the agent");
    assert.deepEqual(accept.target, { read: "accept_check", args: { task: "task" }, show: ["title", "result", "held_by", "host", "since", "agent"] });
    assert.match(accept.confirmText!, /^Accept the work on «\{target\.title\}» and mark it done: \{target\.result\}\. Held by \{target\.held_by\}/);
    assert.match(accept.confirmText!, /Accept it\?$/);
    assert.ok(accept.confirmText!.length <= 600);
    assert.equal(op("accept_check").untrusted, true, "check names are the repository's text");
    const back = op("send_back");
    assert.equal(back.method, "tasks.send-back", "the task screen's Send back");
    assert.equal(back.risk, "low", "decided with the user on 2026-10-28: like God Mode's send_message; it runs without asking");
    assert.deepEqual(back.outcome, { ok: "ok", error: "error" }, "God Mode reads the reason of a refusal only from error");
    assert.equal(back.output, undefined, "the whole answer, note included: sent but not moved is read out, not a refusal");
    assert.ok("note" in tasksSendBackRpc.output.shape);
    assert.deepEqual(Object.keys((back.input as { properties: object }).properties).sort(), ["comment", "task"], "never reply: ChatGPT sends review feedback");
    assert.match(back.description!, /not send_message/);
    assert.match(op("release_task").description!, /use accept_task/);
  }
});

test("one default read, and only low-risk actions skip confirmation", () => {
  for (const on of [false, true]) {
    const ops = describeDashboard(on).operations;
    assert.equal(ops.filter((op) => op.default).length, 1);
    for (const op of ops.filter((o) => o.kind === "action")) {
      assert.ok(op.risk, `${op.id} declares a risk`);
      // God Mode derives it: a low action runs at once, any other asks first.
      assert.equal(op.confirm, undefined, `${op.id}: no confirm of its own`);
      if (op.risk !== "low") assert.ok(op.confirmText, `${op.id}: what the user hears before it`);
    }
  }
});

test("every target names a read of the plugin, maps its required arguments and shows fields it returns", () => {
  for (const op of OPERATIONS.filter((o) => o.target)) {
    const target = op.target!;
    const read = OPERATIONS.find((o) => o.id === target.read);
    assert.ok(read && read.kind === "read", `${op.id}: ${target.read} is a read`);
    const required = (z.toJSONSchema(read.input, { io: "input" }) as { required?: string[] }).required ?? [];
    for (const arg of required) assert.ok(arg in target.args, `${op.id}: ${target.read}'s required ${arg} is mapped`);
    const actionArgs = keysOf(op.input, `${op.id} input`);
    for (const from of Object.values(target.args)) assert.ok(actionArgs.includes(from), `${op.id}: maps from its own ${from}`);
    const answer = keysOf(read.contract.output, `${read.id} output`);
    for (const field of target.show) assert.ok(answer.includes(field), `${op.id}: shows ${field}`);
    for (const [, key] of op.confirmText?.matchAll(/\{([a-z_.]+)\}/g) ?? []) {
      if (key!.startsWith("target.")) assert.ok(target.show.includes(key!.slice(7)), `${op.id}: confirmText names shown ${key}`);
      else assert.ok(actionArgs.includes(key!), `${op.id}: confirmText names argument ${key}`);
    }
  }
});

test("output fields and outcome fields exist in the RPC's answer, none of them secret-looking", () => {
  for (const op of OPERATIONS) {
    const answer = keysOf(op.contract.output, `${op.id} output`);
    for (const field of op.fields ?? []) assert.ok(answer.includes(field), `${op.id}: ${field} exists`);
    const outcome = [op.outcome?.ok, op.outcome?.error].flat().filter((f): f is string => Boolean(f));
    for (const field of outcome) assert.ok(answer.includes(field), `${op.id}: outcome ${field} exists`);
    const keys = allKeys(op.contract.output as z.ZodType);
    assert.ok(keys.length > 0, `${op.id}: the walk found the answer's fields`);
    for (const key of keys) assert.doesNotMatch(key, SECRET, `${op.id}: ${key}`);
  }
});

test("God Mode's own parser accepts the description and drops nothing", async (t) => {
  const checkout = process.env.GODMODE_CHECKOUT;
  if (!checkout) {
    t.skip("set GODMODE_CHECKOUT to a God Mode checkout (not the copy Paseo manages under ~/.paseo)");
    return;
  }
  const url = pathToFileURL(join(checkout, "gpt-site/core/capabilities.mjs")).href;
  const { parseCapabilities } = (await import(url)) as {
    parseCapabilities: (raw: unknown) => { invalid?: string; capabilities?: { title: string; aliases: string[]; skipped: unknown[]; operations: unknown[] } };
  };
  for (const [on, dev] of [[false, false], [true, false], [false, true]]) {
    const parsed = parseCapabilities(JSON.parse(JSON.stringify(describeDashboard(on, dev))));
    assert.equal(parsed.invalid, undefined);
    assert.deepEqual(parsed.capabilities?.skipped, []);
    assert.equal(parsed.capabilities?.operations.length, OPERATIONS.length);
    assert.equal(parsed.capabilities?.title, dev ? "Paseo Dash Dev" : "Paseo Dash");
    assert.equal(parsed.capabilities?.aliases.includes("PD"), !dev, "only the installed plugin answers to PD");
  }
});

test("the empty overview answers a valid shape, and an unknown space is an error, not an empty list", async () => {
  const dashboard = new Dashboard({ dataDir: mkdtempSync(join(tmpdir(), "dashboard-overview-")) });
  await dashboard.start();
  try {
    const all = readOverview(dashboard, {});
    assert.deepEqual(overviewRpc.output.parse(all), all);
    assert.equal(all.error, "");
    assert.deepEqual(all.spaces, []);
    const named = readOverview(dashboard, { space: "Laconote" });
    assert.match(named.error, /Laconote/);
  } finally {
    dashboard.stop();
  }
});

test("the version constant matches package.json", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(VERSION, pkg.version);
});

test("the start of a set reads back what starts now, later and not at all, and the plan read carries the rules", () => {
  for (const on of [false, true]) {
    const ops = describeDashboard(on).operations;
    const plan = ops.find((op) => op.id === "start_plan")!;
    assert.equal(plan.kind, "read");
    assert.ok(plan.output!.fields.includes("rules") && plan.output!.fields.includes("permission"));
    assert.match(plan.description!, /rules: how to start tasks for the user; follow them/);
    assert.match(START_RULES, /Permission to start is not the agent's permission mode/, "the rule travels with the plan's answer");
    assert.match(ops.find((op) => op.id === "start_check")!.description!, /not a permission to start/);
    const set = ops.find((op) => op.id === "start_tasks")!;
    assert.match(set.description!, /launching, not yet working/);
    assert.match(set.description!, /[Dd]rafts are not a request/);
    assert.equal(set.output, undefined, "the whole answer: a start whose claim is unknown reaches ChatGPT");
    assert.ok("unclear" in tasksStartSetRpc.output.shape);
    assert.match(set.description!, /unclear/);
  }
  const asking = describeDashboard(false).operations.find((op) => op.id === "start_tasks")!;
  assert.deepEqual(asking.target, { read: "start_tasks_check", args: { tasks: "tasks" }, show: ["start_now", "after", "not_started", "agents", "instructions"] });
  assert.match(asking.confirmText!, /Start them\?$/);
  for (const field of asking.target!.show) assert.match(asking.confirmText!, new RegExp(`\\{target\\.${field}\\}`));
});
