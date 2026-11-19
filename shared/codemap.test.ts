import { test } from "node:test";
import assert from "node:assert/strict";
import { codeTree, type MapNode, TREE_DEPTH } from "./codemap.ts";

const node = (path: string, imports: string[] = [], state: MapNode["state"] = "changed"): MapNode => ({ path, state, at: "", imports });

test("each file sits under the files that import it; one met again is not repeated", () => {
  const { rows, cut } = codeTree([node("settings.tsx", ["logout.ts", "Button.tsx"]), node("logout.ts", ["session.ts"]), node("session.ts"), node("Button.tsx", [], "linked"), node("Header.tsx", ["logout.ts"])]);
  assert.deepEqual(
    rows.map((r) => `${"  ".repeat(r.depth)}${r.path}${r.again ? " (again)" : ""}`),
    ["Header.tsx", "  logout.ts", "    session.ts", "settings.tsx", "  logout.ts (again)", "  Button.tsx"],
  );
  assert.equal(cut, false);
});

test("a cycle is drawn once, and a chain deeper than TREE_DEPTH is cut", () => {
  const cycle = codeTree([node("a.ts", ["b.ts"]), node("b.ts", ["a.ts"])]);
  assert.deepEqual(cycle.rows.map((r) => [r.path, r.depth, r.again]), [["a.ts", 0, false], ["b.ts", 1, false], ["a.ts", 2, true]]);
  const chain = Array.from({ length: TREE_DEPTH + 2 }, (_, i) => node(`f${i}.ts`, i < TREE_DEPTH + 1 ? [`f${i + 1}.ts`] : []));
  const deep = codeTree(chain);
  assert.equal(deep.cut, true);
  assert.equal(Math.max(...deep.rows.map((r) => r.depth)), TREE_DEPTH - 1);
});

test("a subtree cut at TREE_DEPTH is not drawn again as trees of its own; each row names its parent", () => {
  const chain = Array.from({ length: TREE_DEPTH + 2 }, (_, i) => node(`f${i}.ts`, i < TREE_DEPTH + 1 ? [`f${i + 1}.ts`] : []));
  const { rows } = codeTree(chain);
  assert.equal(rows.filter((r) => r.depth === 0).length, 1, "one tree only");
  assert.deepEqual(rows.slice(0, 2).map((r) => [r.path, r.parent]), [["f0.ts", ""], ["f1.ts", "f0.ts"]]);
});

test("a file cut at TREE_DEPTH and reached from another tree is drawn there, with its imports", () => {
  const chain = Array.from({ length: TREE_DEPTH }, (_, i) => node(`a${i}.ts`, [i < TREE_DEPTH - 1 ? `a${i + 1}.ts` : "x.ts"]));
  const { rows } = codeTree([...chain, node("x.ts", ["y.ts"]), node("y.ts"), node("b.ts", ["x.ts"])]);
  const x = rows.find((r) => r.path === "x.ts")!;
  assert.equal(x.again, false, "not 'shown above': it was cut, never drawn");
  assert.equal(x.parent, "b.ts");
  assert.ok(rows.some((r) => r.path === "y.ts" && r.parent === "x.ts"));
});
