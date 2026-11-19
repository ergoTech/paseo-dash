import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sh } from "../sync/testing.ts";
import { planOptions } from "../views.ts";
import { getTask, listInbox, listTasks } from "./reads.ts";
import { putLabel, putPerson, removeLabel, removePerson } from "./team.ts";
import { setup } from "./testing.ts";
import { addToInbox, createTask, updateTask } from "./writes.ts";

/** People and labels through the plan API (09-forge-issues.md, Labels for tasks; phase F1). */

const PEOPLE = `people:
  me: { name: Ergo, emails: [ME@Example.com] }
  anna: { name: Anna K, emails: [anna@example.com], github: anna-k, gitlab: { gitlab.example.com: anna } }
labels:
  bug: { color: "#e5484d", description: Broken }
`;

async function withPeople() {
  const s = await setup();
  s.f.external("ergo", (root) => {
    const path = join(root, "space.yaml");
    writeFileSync(path, `${readFileSync(path, "utf8")}${PEOPLE}`);
    const assign = (file: string, who: string) => {
      const task = join(root, "tasks", file);
      writeFileSync(task, readFileSync(task, "utf8").replace("status: todo\n", `status: todo\nassignee: ${who}\n`));
    };
    assign("TST-TASK1-one.md", "me");
    // Written by hand with the person's name instead of the key.
    assign("TST-TASK2-two.md", "Ergo");
    assign("TST-FX001-fix-flaky-login-test.md", "anna");
  });
  await s.sync().sync();
  // The plugin's clone answers who this machine is.
  sh(s.sync().root, "config", "user.email", "me@example.com");
  return s;
}

test("mine lists exactly the tasks assigned to the person whose emails hold this machine's git email", async () => {
  const s = await withPeople();
  try {
    const mine = await listTasks(s.ctx, { mine: true, status: "all", limit: 50 });
    assert.equal(mine.error, "");
    assert.deepEqual(mine.tasks.map((t) => t.id).sort(), ["TST-TASK1", "TST-TASK2"]);
    const options = await planOptions(s.dashboard, { space: "TST" });
    assert.deepEqual(options.me, { key: "me", email: "me@example.com" });
    assert.deepEqual(
      options.people.map((p) => [p.key, p.open_tasks, p.github, p.gitlab]),
      [
        ["me", 1, "", []],
        ["anna", 1, "anna-k", [{ host: "gitlab.example.com", login: "anna" }]],
      ],
    );
    assert.deepEqual((await listTasks(s.ctx, { assignee: "Anna K", status: "all", limit: 50 })).tasks.map((t) => t.id), ["TST-FX001"]);

    // A draft assigned to this machine's person shows in the inbox's "mine"; others do not.
    const drafts = await addToInbox(s.ctx, { items: [{ title: "Mine to triage" }, { title: "Someone else's" }] });
    await updateTask(s.ctx, { task: drafts.created[0]!.id, assignee: "ergo" });
    const inbox = await listInbox(s.ctx, { mine: true, limit: 20 });
    assert.deepEqual(inbox.items.map((i) => [i.title, i.assignee]), [["Mine to triage", "me"]]);

    sh(s.sync().root, "config", "user.email", "nobody@example.com");
    const nobody = await listTasks(s.ctx, { mine: true, status: "all", limit: 50 });
    assert.deepEqual(nobody.tasks, []);
    assert.match(nobody.error, /No person in space.yaml has this machine's git email \(nobody@example.com\)/);
  } finally {
    s.stop();
  }
});

test("labels on create, update and inbox drafts: palette spelling, a new label defined in the same commit, removal of one", async () => {
  const s = await withPeople();
  try {
    const created = await createTask(s.ctx, { title: "Labelled", project: "core", labels: ["BUG", "needs design", "bug"] });
    assert.equal(created.ok, true, created.error);
    assert.deepEqual(getTask(s.ctx, { task: created.id }).labels, ["bug", "needs design"]);
    const space = s.sync().plan.space!;
    assert.equal(space.labels["needs design"]!.color, "#3e8eed", "the first palette color no label uses");
    const file = await s.remoteFile(new RegExp(`${created.id}-`));
    assert.match(file ?? "", /^labels: \[bug, needs design\]$/m);
    const commit = sh(s.f.remote, "show", "--stat", "--format=%s", "main");
    assert.match(commit, /space\.yaml/, "the definition went in with the task");

    const updated = await updateTask(s.ctx, { task: created.id, add_labels: ["ui"], remove_labels: ["Needs Design", "never there"], assignee: "anna k" });
    assert.equal(updated.ok, true, updated.error);
    assert.deepEqual(updated.changed.sort(), ["assignee", "labels"]);
    const read = getTask(s.ctx, { task: created.id });
    assert.deepEqual([read.labels, read.assignee], [["bug", "ui"], "anna"]);
    assert.ok(s.sync().plan.space!.labels.ui?.color, "ui is defined with a color");

    assert.match((await updateTask(s.ctx, { task: created.id, add_labels: ["#hash"] })).error, /«#hash» is not a usable label/);
    assert.match((await updateTask(s.ctx, { task: created.id, assignee: "zed" })).error, /No person «zed»; people of Test space: me, anna/);
    assert.deepEqual((await listTasks(s.ctx, { label: "UI", status: "all", limit: 50 })).tasks.map((t) => [t.id, t.labels]), [[created.id, ["bug", "ui"]]]);

    const drafts = await addToInbox(s.ctx, { items: [{ title: "Draft with labels", labels: ["triage"] }] });
    assert.equal(drafts.ok, true, drafts.error);
    const inbox = await listInbox(s.ctx, { label: "triage", limit: 20 });
    assert.deepEqual(inbox.items.map((i) => [i.title, i.labels]), [["Draft with labels", ["triage"]]]);
    assert.ok(s.sync().plan.space!.labels.triage);
  } finally {
    s.stop();
  }
});

test("the palette and people change one entry at a time; a label in use and a person with open tasks stay", async () => {
  const s = await withPeople();
  try {
    await createTask(s.ctx, { title: "Uses bug", project: "core", labels: ["bug"] });
    assert.deepEqual(await putLabel(s.ctx, { space: "tst", name: "Bug", color: "#30a46c" }), { ok: true, error: "" });
    assert.deepEqual(s.sync().plan.space!.labels.bug, { color: "#30a46c", description: "Broken" }, "the description stays");
    assert.match((await removeLabel(s.ctx, { space: "TST", name: "bug" })).error, /1 task\(s\) carry bug/);
    assert.equal((await putLabel(s.ctx, { space: "TST", name: "spare" })).ok, true);
    assert.equal((await removeLabel(s.ctx, { space: "TST", name: "SPARE" })).ok, true);
    assert.equal(s.sync().plan.space!.labels.spare, undefined);
    assert.match((await putLabel(s.ctx, { space: "TST", name: "x", color: "red" })).error, /not a color/);

    assert.equal((await putPerson(s.ctx, { space: "TST", key: "bo", name: "Bo", emails: ["bo@example.com"], gitlab: [{ host: "gitlab.example.com", login: "bo" }] })).ok, true);
    assert.deepEqual({ ...s.sync().plan.space!.people.bo }, { name: "Bo", emails: ["bo@example.com"], gitlab: { "gitlab.example.com": "bo" } });
    assert.match((await putPerson(s.ctx, { space: "TST", key: "Bad Key", emails: [], gitlab: [] })).error, /is not a person key/);
    assert.match((await putPerson(s.ctx, { space: "TST", key: "bo", emails: ["not-an-email"], gitlab: [] })).error, /is not an email/);
    assert.match((await removePerson(s.ctx, { space: "TST", key: "anna" })).error, /1 open task\(s\) are assigned to anna/);
    assert.equal((await removePerson(s.ctx, { space: "TST", key: "bo" })).ok, true);
    assert.equal(s.sync().plan.space!.people.bo, undefined);
  } finally {
    s.stop();
  }
});
