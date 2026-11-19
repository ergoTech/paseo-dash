import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyOperation } from "../sync/ops.ts";
import { loadPlan } from "./load.ts";

function repo(space: string) {
  const root = mkdtempSync(join(tmpdir(), "dashboard-space-file-"));
  writeFileSync(join(root, "space.yaml"), space);
  return { root, plan: loadPlan(root), text: () => readFileSync(join(root, "space.yaml"), "utf8") };
}

const NOW = "2026-10-26T10:00:00.000Z";

test("the first project of a new space turns `projects: {}` into a block map", () => {
  const r = repo("schema: paseo-dashboard/1\nkey: ERG\nname: Ergo\nprojects: {}\ndefaults:\n  priority: medium\n");
  const outcome = applyOperation(r.root, r.plan, { op_id: "o1", kind: "project", key: "core", value: { remote: "git@x:core.git", trunk: "main" }, expect: null }, NOW);
  assert.equal(outcome.status, "applied");
  assert.equal(r.text(), "schema: paseo-dashboard/1\nkey: ERG\nname: Ergo\nprojects:\n  core: { remote: git@x:core.git, trunk: main }\ndefaults:\n  priority: medium\n");
  assert.deepEqual(loadPlan(r.root).space!.projects.core, { remote: "git@x:core.git", trunk: "main" });
  const removed = applyOperation(r.root, r.plan, { op_id: "o2", kind: "project", key: "core", value: null, expect: { remote: "git@x:core.git", trunk: "main" } }, NOW);
  assert.equal(removed.status, "applied");
  assert.deepEqual(loadPlan(r.root).space!.projects, {}, "the last project removed leaves an empty map, not null");
});

test("project operations replay safely: same result is already, a stale expectation is refused", () => {
  const r = repo("schema: paseo-dashboard/1\nkey: ERG\nname: Ergo\nprojects:\n  core: { remote: git@x:core.git, trunk: main, owner: anna } # hand note\n  site: { remote: git@x:site.git }\n");
  const value = { remote: "git@x:core.git", trunk: "main", color: "#3e8eed" };
  const expect = { remote: "git@x:core.git", trunk: "main" };
  assert.equal(applyOperation(r.root, r.plan, { op_id: "o1", kind: "project", key: "core", value, expect }, NOW).status, "applied");
  assert.match(r.text(), /core: \{ remote: git@x:core\.git, trunk: main, owner: anna, color: "#3e8eed" \} # hand note/, "unknown keys and comments stay");
  assert.equal(applyOperation(r.root, r.plan, { op_id: "o1", kind: "project", key: "core", value, expect }, NOW).status, "already");
  const stale = applyOperation(r.root, r.plan, { op_id: "o2", kind: "project", key: "core", value: { ...expect, group: "x" }, expect }, NOW);
  assert.deepEqual(stale, { status: "refused", reason: "project core changed meanwhile" });
  const web = applyOperation(r.root, r.plan, { op_id: "o3", kind: "project", key: "web", value: { remote: "https://x/web" }, expect: null }, NOW);
  assert.equal(web.status, "applied");
  const same = applyOperation(r.root, r.plan, { op_id: "o4", kind: "project", key: "web2", value: { remote: "ssh://git@x/site.git" }, expect: null }, NOW);
  assert.deepEqual(same, { status: "refused", reason: "ssh://git@x/site.git is already listed as site" }, "another URL form of a listed repository");
  const order = applyOperation(r.root, r.plan, { op_id: "o5", kind: "project_order", order: ["web", "core", "site"], expect: ["core", "site", "web"] }, NOW);
  assert.equal(order.status, "applied");
  assert.deepEqual(Object.keys(loadPlan(r.root).space!.projects), ["web", "core", "site"]);
  const late = applyOperation(r.root, r.plan, { op_id: "o6", kind: "project_order", order: ["core", "web", "site"], expect: ["core", "site", "web"] }, NOW);
  assert.deepEqual(late, { status: "refused", reason: "the list of projects changed meanwhile" });
});

test("the same change in another key order replays as already; inherited and non-text keys are never projects", () => {
  const r = repo("schema: paseo-dashboard/1\nkey: ERG\nname: Ergo\nprojects:\n  core: { remote: git@x:core.git, color: \"#3e8eed\" }\n  123: { remote: git@x:n.git }\n");
  const expect = { remote: "git@x:core.git", color: "#3e8eed" };
  const value = { remote: "git@x:core.git", color: "#3e8eed", trunk: "main" };
  assert.equal(applyOperation(r.root, r.plan, { op_id: "o1", kind: "project", key: "core", value, expect }, NOW).status, "applied");
  assert.equal(applyOperation(r.root, r.plan, { op_id: "o1", kind: "project", key: "core", value, expect }, NOW).status, "already");
  const before = r.text();
  for (const key of ["toString", "constructor", "__proto__"]) {
    const outcome = applyOperation(r.root, r.plan, { op_id: `x-${key}`, kind: "project", key, value: null, expect: { remote: "x" } }, NOW);
    // Nothing to remove: never "applied", which would commit nothing and stall the queue.
    assert.equal(outcome.status, "already", key);
  }
  const numeric = applyOperation(r.root, r.plan, { op_id: "o2", kind: "project", key: "123", value: null, expect: { remote: "git@x:n.git" } }, NOW);
  assert.equal(numeric.status, "refused", "a key YAML holds as a number is not removed silently");
  assert.equal(r.text(), before, "nothing was written");
});

test("a listed key YAML reads as another scalar is refused, not duplicated", () => {
  const r = repo("schema: paseo-dashboard/1\nkey: ERG\nname: Ergo\nprojects:\n  true: { remote: git@x:t.git }\n");
  const before = r.text();
  const outcome = applyOperation(r.root, r.plan, { op_id: "o1", kind: "project", key: "true", value: { remote: "git@x:t.git", group: "G" }, expect: { remote: "git@x:t.git" } }, NOW);
  assert.equal(outcome.status, "refused");
  assert.equal(r.text(), before);
});

test("labels and people are written into space.yaml as flow maps; comments and other keys stay", () => {
  const r = repo("schema: paseo-dashboard/1\nkey: ERG\nname: Ergo # the name\nprojects: {}\nlabels:\n  bug: # typed by hand\n");
  const defined = applyOperation(r.root, r.plan, { op_id: "o1", kind: "label_def", name: "bug", value: { color: "#E5484D", description: "Broken" }, expect: {} }, NOW);
  assert.equal(defined.status, "applied");
  const ui = applyOperation(r.root, r.plan, { op_id: "o2", kind: "label_def", name: "ui: web", value: { color: "#3e8eed" }, expect: null }, NOW);
  assert.equal(ui.status, "applied");
  const person = { name: "Anna K", emails: ["anna@example.com"], github: "anna", gitlab: { "gitlab.example.com": "anna" } };
  assert.equal(applyOperation(r.root, r.plan, { op_id: "o3", kind: "person", key: "anna", value: person, expect: null }, NOW).status, "applied");
  assert.equal(applyOperation(r.root, r.plan, { op_id: "o3", kind: "person", key: "anna", value: person, expect: null }, NOW).status, "already");
  const text = r.text();
  assert.match(text, /^name: Ergo # the name$/m);
  assert.match(text, /^  bug: { color: "#e5484d", description: Broken }/m);
  assert.match(text, /^  "ui: web": { color: "#3e8eed" }$/m);
  assert.match(text, /^  anna: { name: Anna K, emails: \[ anna@example.com \], github: anna, gitlab: { gitlab.example.com: anna } }$/m);
  const again = loadPlan(r.root);
  assert.deepEqual(again.problems, []);
  assert.equal(again.space!.labels["ui: web"]!.color, "#3e8eed");
  assert.deepEqual(again.space!.people.anna!.gitlab, { "gitlab.example.com": "anna" });

  // An `if_absent` definition of a label that exists in another case is already there.
  assert.equal(applyOperation(r.root, r.plan, { op_id: "o4", kind: "label_def", name: "BUG", value: { color: "#30a46c" }, expect: null, if_absent: true }, NOW).status, "already");
  const stale = applyOperation(r.root, r.plan, { op_id: "o5", kind: "label_def", name: "bug", value: { color: "#30a46c" }, expect: { color: "#3e8eed" } }, NOW);
  assert.deepEqual(stale, { status: "refused", reason: "label bug changed meanwhile" });
  assert.equal(applyOperation(r.root, r.plan, { op_id: "o6", kind: "person", key: "Not A Key", value: {}, expect: null }, NOW).status, "refused");
  assert.equal(applyOperation(r.root, r.plan, { op_id: "o7", kind: "label_def", name: "ui: web", value: null, expect: { color: "#3e8eed" } }, NOW).status, "applied");
  assert.equal(applyOperation(r.root, r.plan, { op_id: "o8", kind: "person", key: "anna", value: null, expect: person }, NOW).status, "applied");
  assert.doesNotMatch(r.text(), /ui: web|anna/);
});

test("short forms written by hand read as entries, are rewritten in full on an edit, and a list section is never replaced", () => {
  const r = repo('schema: paseo-dashboard/1\nkey: ERG\nname: Ergo\nlabels:\n  bug: "#E5484D"\npeople:\n  ergo: Ergo\n');
  assert.deepEqual(r.plan.problems, []);
  assert.equal(r.plan.space!.labels.bug!.color, "#e5484d");
  assert.equal(r.plan.space!.people.ergo!.name, "Ergo");
  const described = applyOperation(r.root, r.plan, { op_id: "o1", kind: "label_def", name: "bug", value: { color: "#e5484d", description: "Broken" }, expect: { color: "#e5484d" } }, NOW);
  assert.equal(described.status, "applied");
  assert.match(r.text(), /^  bug: { color: "#e5484d", description: Broken }$/m);
  const emailed = applyOperation(r.root, r.plan, { op_id: "o2", kind: "person", key: "ergo", value: { name: "Ergo", emails: ["e@x.io"] }, expect: { name: "Ergo" } }, NOW);
  assert.equal(emailed.status, "applied");
  const twin = applyOperation(r.root, r.plan, { op_id: "o3", kind: "person", key: "ERGO", value: {}, expect: null }, NOW);
  assert.equal(twin.status, "refused");

  const list = repo("schema: paseo-dashboard/1\nkey: ERG\nname: Ergo\nlabels: [bug, ui]\n");
  assert.deepEqual(Object.keys(list.plan.space!.labels), ["bug", "ui"]);
  const added = applyOperation(list.root, list.plan, { op_id: "o4", kind: "label_def", name: "docs", value: { color: "#3e8eed" }, expect: null }, NOW);
  assert.equal(added.status, "refused");
  assert.match((added as { reason: string }).reason, /labels is not a map/);
  assert.match(list.text(), /^labels: \[bug, ui\]$/m, "the hand-written list stays");
});
