import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCodeMap, candidates, importsOf } from "./codemap.ts";

test("a script's relative imports are found in every form; packages are not", () => {
  const text = [
    'import { a } from "./a";',
    "import type { T } from '../types/t.ts';",
    'export { b } from "./b.js";',
    'import "./side-effect";',
    "const c = await import('./lazy');",
    'const d = require("../d");',
    'import React from "react";',
    'import { x } from "@scope/pkg/./x";',
  ].join("\n");
  assert.deepEqual(
    importsOf("src/main.ts", text).map((i) => i.spec).sort(),
    ["../d", "../types/t.ts", "./a", "./b.js", "./lazy", "./side-effect"],
  );
  assert.deepEqual(importsOf("README.md", text), [], "a file that is not code has none");
});

test("Python's relative imports, with each name of a package import an edge of its own", () => {
  const text = "from .models import User\nfrom ..core.db import session\nfrom . import views, urls\nimport os\nfrom django import forms\n";
  assert.deepEqual(importsOf("app/api/handlers.py", text), [
    { spec: ".models", names: ["User"] },
    { spec: "..core.db", names: ["session"] },
    { spec: ".", names: ["views"] },
    { spec: ".", names: ["urls"] },
  ]);
  assert.deepEqual(candidates("app/api/handlers.py", ".models", ["User"]).slice(0, 2), ["app/api/models.py", "app/api/models/__init__.py"]);
  assert.deepEqual(candidates("app/api/handlers.py", "..core.db").slice(0, 2), ["app/core/db.py", "app/core/db/__init__.py"]);
  assert.ok(candidates("app/api/handlers.py", ".", ["views"]).includes("app/api/views.py"));
});

test("a script's import resolves as TypeScript does: extensions, index files, and .js naming a .ts", () => {
  assert.ok(candidates("src/a.ts", "./b").includes("src/b.tsx"));
  assert.ok(candidates("src/a.ts", "./dir").includes("src/dir/index.ts"));
  assert.ok(candidates("src/a.ts", "../lib/c.js").includes("lib/c.ts"));
  assert.ok(candidates("src/a.mts", "./d.mjs").includes("src/d.mts"));
});

test("the map links the run's files by their imports; a changed file's import it did not touch is linked, one step out", () => {
  const texts: Record<string, string> = {
    "src/a.ts": 'import { b } from "./b";\nimport { util } from "./util";\nimport x from "../../outside";',
    "src/b.ts": 'import { c } from "./c";',
    "docs/readme.md": "",
  };
  const exists = (path: string) => ["src/a.ts", "src/b.ts", "src/c.ts", "src/util.ts", "docs/readme.md"].includes(path);
  const map = buildCodeMap(
    [
      { path: "src/a.ts", state: "changed", at: "2026-11-13T10:00:00.000Z" },
      { path: "src/b.ts", state: "read", at: "2026-11-13T10:00:01.000Z" },
      { path: "docs/readme.md", state: "changed", at: "" },
      { path: "../elsewhere.ts", state: "read", at: "" },
    ],
    (path) => texts[path],
    exists,
  );
  assert.deepEqual(
    map.nodes.map((n) => [n.path, n.state, n.imports]),
    [
      ["docs/readme.md", "changed", []],
      ["src/a.ts", "changed", ["src/b.ts", "src/util.ts"]],
      // A read file's imports are drawn among the run's files, but add none of their own.
      ["src/b.ts", "read", []],
      ["src/util.ts", "linked", []],
    ],
  );
  assert.equal(map.more, 0);
});

test("the map keeps the changed files first within its limit and counts the rest", () => {
  const files = Array.from({ length: 5 }, (_, i) => ({ path: `f${i}.ts`, state: (i < 2 ? "read" : "changed") as "read" | "changed", at: "" }));
  const map = buildCodeMap(files, () => "", () => false, 3);
  assert.deepEqual(map.nodes.map((n) => n.path), ["f2.ts", "f3.ts", "f4.ts"]);
  assert.equal(map.more, 2);
});

test("Python's parenthesised imports, as Black writes them, are read", () => {
  const text = "from . import (\n    views,\n    urls,\n)\nfrom .models import (\n    User,\n)\n";
  assert.deepEqual(importsOf("app/a.py", text), [
    { spec: ".", names: ["views"] },
    { spec: ".", names: ["urls"] },
    { spec: ".models", names: ["User"] },
  ]);
});

test("from a TypeScript file a .js name finds its .ts source first; from JavaScript the .js", () => {
  assert.equal(candidates("src/a.ts", "./b.js")[0], "src/b.ts");
  assert.equal(candidates("src/a.js", "./b.js")[0], "src/b.js");
});

test("only scripts and Python are read; a file left out is counted once however many import it", () => {
  const asked: string[] = [];
  const map = buildCodeMap(
    [
      { path: "a.ts", state: "changed", at: "" },
      { path: "b.ts", state: "changed", at: "" },
      { path: "notes.md", state: "changed", at: "" },
    ],
    (path) => (asked.push(path), 'import { x } from "./x";'),
    (path) => path === "x.ts",
    3,
  );
  assert.deepEqual(asked.sort(), ["a.ts", "b.ts"], "notes.md is not read");
  assert.equal(map.more, 1, "x.ts once, though two files import it");
});

test("a long text without quotes or semicolons is read in linear time", () => {
  const text = `export ${"a ".repeat(170_000)}`;
  const start = Date.now();
  importsOf("big.ts", text);
  assert.ok(Date.now() - start < 1_000, `took ${Date.now() - start} ms`);
});

test("a comment inside a parenthesised Python import does not eat the next name", () => {
  assert.deepEqual(importsOf("p/a.py", "from . import (\n    a,  # first\n    b,\n)\n"), [
    { spec: ".", names: ["a"] },
    { spec: ".", names: ["b"] },
  ]);
});
