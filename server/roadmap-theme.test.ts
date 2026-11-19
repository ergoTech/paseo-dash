import { test } from "node:test";
import assert from "node:assert/strict";
import { DARK_CLASSES, forTheme, isDark } from "../client/roadmap-theme.ts";
import { setup } from "./api/testing.ts";
import { renderRoadmap } from "./plan/roadmap.ts";

test("on a dark theme every ROADMAP.md diagram state gets a dark fill; a light theme keeps the file's", async () => {
  const s = await setup();
  try {
    const text = renderRoadmap(s.sync().plan)!;
    const names = [...text.matchAll(/^ *classDef (\w+) /gm)].map((m) => m[1]!);
    assert.ok(names.length > 0);
    for (const name of names) assert.ok(DARK_CLASSES[name], `no dark colors for classDef ${name}`);
    const dark = forTheme(text, true);
    assert.doesNotMatch(dark, /fill:#ffffff|fill:#f3f3f3|color:#111\b/);
    assert.equal(dark.split("\n").length, text.split("\n").length, "only classDef lines change");
    assert.equal(forTheme(text, false), text);
  } finally {
    s.stop();
  }
});

test("dark and light backgrounds", () => {
  assert.equal(isDark("#1c1c1c"), true);
  assert.equal(isDark("#111"), true);
  assert.equal(isDark("#ffffff"), false);
  assert.equal(isDark("#f5f5f5"), false);
  assert.equal(isDark("#1c1c1cff"), true, "a plugin theme may give an alpha");
  assert.equal(isDark("rgb(0,0,0)"), false, "not a hex color: treated as light, the file's own colors");
});
