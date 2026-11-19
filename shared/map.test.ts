import { test } from "node:test";
import assert from "node:assert/strict";
import { type MetroMap, overlapLinks } from "./map.ts";

const station = (key: string, tasks: { id: string; overlaps?: { task: string; files: string[]; more: number }[] }[]) =>
  ({ key, column: 0, slot: 0, row: 0, feature: "", glyph: "working", tasks: tasks.map((t) => ({ title: t.id, status: "in_progress", glyph: "working", labels: [], ...t })) }) as MetroMap["stations"][number];

test("stations whose tasks share changed files are linked once; tasks of one station are not", () => {
  const files = { files: ["a.ts"], more: 0 };
  const map = {
    stations: [
      station("s1", [{ id: "T1", overlaps: [{ task: "T2", ...files }, { task: "T3", ...files }] }, { id: "T3", overlaps: [{ task: "T1", ...files }] }]),
      station("s2", [{ id: "T2", overlaps: [{ task: "T1", ...files }] }]),
      station("s3", [{ id: "T4", overlaps: [{ task: "GONE", ...files }] }]),
    ],
  } as unknown as MetroMap;
  assert.deepEqual(
    overlapLinks(map).map((link) => [link.key, link.from.key, link.to.key]),
    [["s1|s2", "s1", "s2"]],
  );
});
