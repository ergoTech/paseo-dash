import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { TASK_STATUSES } from "../../shared/model.ts";
import { VIEW_FILES } from "./views.ts";

test("the Obsidian Bases views are valid YAML in the Bases shape, with a kanban of the task statuses", () => {
  assert.deepEqual(Object.keys(VIEW_FILES).sort(), ["views/roadmap.base", "views/tasks.base"]);
  for (const [path, text] of Object.entries(VIEW_FILES)) {
    const base = parse(text) as { filters: unknown; views: { type: string; name: string }[] };
    assert.ok(base.filters, path);
    assert.ok(base.views.length > 0 && base.views.every((v) => v.type && v.name), path);
  }
  const board = (parse(VIEW_FILES["views/tasks.base"]!) as { views: { type: string; groupBy?: { property: string }; groupOrder?: string[] }[] }).views.find(
    (v) => v.type === "kanban",
  );
  assert.equal(board?.groupBy?.property, "note.status");
  for (const status of board!.groupOrder!) assert.ok((TASK_STATUSES as readonly string[]).includes(status), status);
});
