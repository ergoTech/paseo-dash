import { test } from "node:test";
import assert from "node:assert/strict";
import { compareTable } from "../scripts/response-sizes.ts";
import { budgetOf, CEILING, DESCRIBE_CEILING, MEASURED, overBudget } from "./response-budget.ts";
import { measureResponseSizes, RESPONSES } from "./response-sizes.ts";

test("the plan tools' budget stays under their ceilings: the tool list 1 KB, a page of plan_find 1.5 KB", () => {
  assert.deepEqual(Object.keys(CEILING), ["plan_tools", "plan_find"]);
  for (const [name, ceiling] of Object.entries(CEILING) as [keyof typeof CEILING, number][]) {
    assert.ok(budgetOf(name) <= ceiling, `${name}: budget ${budgetOf(name)} is over ${ceiling}`);
  }
});

test("meta.describe, overview, tasks, task and the plan tools on the large plan stay within their budget", async () => {
  const sizes = await measureResponseSizes();
  assert.deepEqual(overBudget(sizes), [], "shrink the reply, or raise fixtures/response-budget.ts explicitly in the PR");
});

test("the budget is what was measured plus 5%, and a reply over it by one byte is reported", () => {
  assert.deepEqual(Object.keys(MEASURED), [...RESPONSES]);
  for (const name of RESPONSES) {
    const room = Math.ceil(MEASURED[name] * 1.05);
    assert.equal(budgetOf(name), name === "meta.describe" ? Math.min(room, DESCRIBE_CEILING) : room);
    const within = { ...MEASURED, [name]: budgetOf(name) };
    assert.deepEqual(overBudget(within), []);
    const over = { ...MEASURED, [name]: budgetOf(name) + 1 };
    assert.deepEqual(overBudget(over), [`${name}: ${budgetOf(name) + 1} bytes, budget ${budgetOf(name)}`]);
  }
});

test("meta.describe has a ceiling of 23.5 KiB that the room never lifts", () => {
  assert.equal(DESCRIBE_CEILING, 24064);
  assert.ok(budgetOf("meta.describe") <= DESCRIBE_CEILING);
  assert.ok(MEASURED["meta.describe"] <= DESCRIBE_CEILING, "the measured description itself fits");
});

test("the comparison table gives both sizes, the change and the budget, and marks what is over it", () => {
  const head = { ...MEASURED, overview: budgetOf("overview") + 1 };
  const table = compareTable({ label: "base abc", sizes: MEASURED }, { label: "head def", sizes: head });
  const rows = table.split("\n");
  assert.equal(rows[0], "| Response | base abc | head def | Change | Budget |");
  assert.equal(rows.length, 2 + RESPONSES.length);
  const delta = budgetOf("overview") + 1 - MEASURED.overview;
  assert.equal(rows[3], `| overview | ${MEASURED.overview} | ${budgetOf("overview") + 1} | +${delta} (+5.0%) | ${budgetOf("overview")} **over** |`);
  assert.equal(rows[2], `| meta.describe | ${MEASURED["meta.describe"]} | ${MEASURED["meta.describe"]} | 0 (0.0%) | ${budgetOf("meta.describe")} |`);
});
