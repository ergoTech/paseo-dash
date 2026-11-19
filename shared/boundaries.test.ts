import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Paseo compiles the client and server entries separately and refuses imports across them
 * (docs/design/task-manager-v1/05-architecture.md, Platform facts). This test fails here, before a
 * reload fails in the daemon.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// The only modules the host provides to client code (Paseo 0.13 plugin reference, Runtime modules).
const CLIENT_HOST_MODULES = new Set([
  "react",
  "react/jsx-runtime",
  "react-native",
  "@tanstack/react-query",
  "zod",
  "@getpaseo/plugin",
  "@getpaseo/plugin/client",
  "@getpaseo/plugin/client/ui",
]);
const SHARED_MODULES = new Set(["zod", "@getpaseo/plugin"]);

// HTML elements and DOM APIs that break native clients; allowed only in client/web.ts.
const DOM_USE = /<(div|span|button|input|a|p|img|ul|li|form)\b|className=|onClick=|localStorage|\bdocument\.|\bwindow\./;

async function sources(dir: string): Promise<string[]> {
  const entries = await readdir(join(ROOT, dir), { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [path] : [];
    }),
  );
  return files.flat();
}

/** Every module a file loads: static, side-effect and dynamic imports, re-exports and require. */
function imports(text: string): string[] {
  const patterns = [
    /^\s*(?:import|export)\s[^'"]*?from\s+["']([^"']+)["']/gm,
    /^\s*import\s+["']([^"']+)["']/gm,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  ];
  return patterns.flatMap((pattern) => [...text.matchAll(pattern)].map((m) => m[1]));
}

// What the daemon refuses in server bundles besides client code (Paseo 0.13 plugin reference).
const SERVER_FORBIDDEN = /^(react|react\/.*|react-native|@tanstack\/react-query|@getpaseo\/plugin\/client.*)$/;

test("client code imports only host modules, shared and client code", async () => {
  for (const file of ["index.client.tsx", ...(await sources("client"))]) {
    const text = await readFile(join(ROOT, file), "utf8");
    for (const spec of imports(text)) {
      if (spec.startsWith(".")) {
        assert.ok(!/(^|\/)server\//.test(spec), `${file} imports server code: ${spec}`);
        continue;
      }
      assert.ok(CLIENT_HOST_MODULES.has(spec), `${file} imports ${spec}, which the host does not provide`);
    }
    if (relative("client", file) !== "web.ts") assert.doesNotMatch(text, DOM_USE, `${file} uses DOM or HTML`);
  }
});

test("server code never imports client code", async () => {
  for (const file of ["index.server.ts", ...(await sources("server"))]) {
    const text = await readFile(join(ROOT, file), "utf8");
    for (const spec of imports(text)) {
      assert.ok(!/(^|\/)client\//.test(spec), `${file} imports client code: ${spec}`);
      assert.doesNotMatch(spec, SERVER_FORBIDDEN, `${file} imports ${spec}, which server bundles cannot load`);
    }
  }
});

/**
 * A plugin installed from git gets its `dependencies` installed and nothing else, and Paseo's build
 * refuses even a type import it cannot resolve there; the host supplies only the SDK entries and zod,
 * and lets type-only imports of `@getpaseo/protocol/*` through. A dev checkout with node_modules hides
 * a violation, so it is checked here.
 */
const SERVER_HOST_MODULES = new Set([
  "zod",
  "@getpaseo/plugin",
  "@getpaseo/plugin/server",
  "@getpaseo/plugin/server/provider",
  "@getpaseo/plugin/server/usage",
  "@getpaseo/plugin/server/acp",
]);

test("server code imports only what a plugin installed from git can resolve", async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  const dependencies = new Set(Object.keys(manifest.dependencies ?? {}));
  const packageOf = (spec: string) => spec.split("/").slice(0, spec.startsWith("@") ? 2 : 1).join("/");
  for (const file of ["index.server.ts", ...(await sources("server")), ...(await sources("shared"))]) {
    const text = await readFile(join(ROOT, file), "utf8");
    // Every statement counts on its own: a type-only import of a module does not excuse a runtime one.
    // Only the binding shapes of a type-only import or re-export, so an `export type Alias = …;` never
    // reaches into the next statement's specifier.
    const typeOnly = [
      ...text.matchAll(/^\s*(?:import|export)\s+type\s+(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?|\w+)\s+from\s+["']([^"']+)["']/gm),
    ].map((m) => m[1]);
    const remaining = [...typeOnly];
    for (const spec of imports(text)) {
      if (spec.startsWith(".") || spec.startsWith("node:") || SERVER_HOST_MODULES.has(spec) || dependencies.has(packageOf(spec))) continue;
      const typed = remaining.indexOf(spec);
      if (spec.startsWith("@getpaseo/protocol/") && typed !== -1) {
        remaining.splice(typed, 1);
        continue;
      }
      assert.fail(`${file} imports ${spec}, which an install from git cannot resolve (not supplied by the host, not in dependencies)`);
    }
  }
});

test("shared code imports only zod, the SDK root and other shared code", async () => {
  for (const file of await sources("shared")) {
    const text = await readFile(join(ROOT, file), "utf8");
    for (const spec of imports(text)) {
      if (spec.startsWith(".")) {
        const target = relative(join(ROOT, "shared"), join(ROOT, dirname(file), spec));
        assert.ok(!target.startsWith(".."), `${file} imports ${spec}, outside shared/`);
        continue;
      }
      assert.ok(SHARED_MODULES.has(spec), `${file} imports ${spec}`);
    }
  }
});

/**
 * Paseo's client registry accepts ids, slash command names, timeline kinds and button ids only of the
 * form `^[a-z][a-z0-9-]*$`. This is a text scan: an id taken from a lowercase variable or computed
 * otherwise is not seen, and loading the plugin in the app stays the real check. A registration made in `contribute` throws there and takes the whole
 * client down; a button added later is refused. Every literal one in client code, and every
 * `*_ID` constant, is checked here; an id built from a template or by concatenation could carry a
 * Paseo id (`wks_…`) and is refused outright.
 */
const PASEO_ID = /^[a-z][a-z0-9-]*$/;

test("client registration ids, names and kinds have the form Paseo accepts", async () => {
  const { STARTED_CARD } = await import("./timeline.ts");
  assert.match(STARTED_CARD.kind, PASEO_ID);
  for (const file of ["index.client.tsx", ...(await sources("client"))]) {
    const text = await readFile(join(ROOT, file), "utf8");
    assert.doesNotMatch(text, /\b(?:id|name|kind):\s*`/, `${file} builds an id, name or kind from a template`);
    assert.doesNotMatch(text, /\b(?:id|name|kind):\s*(["'])[^"']*\1\s*\+/, `${file} builds an id, name or kind by concatenation`);
    for (const m of text.matchAll(/\b(id|name|kind):\s*(["'])([^"']*)\2/g)) {
      assert.match(m[3]!, PASEO_ID, `${file}: ${m[1]} ${JSON.stringify(m[3])}`);
    }
    assert.doesNotMatch(text, /\bconst\s+[A-Z_]+_ID\s*(?::[^=]+)?=\s*`/, `${file} builds an *_ID constant from a template`);
    for (const m of text.matchAll(/\bconst\s+[A-Z_]+_ID\s*(?::[^=]+)?=\s*(["'])([^"']*)\1/g)) assert.match(m[2]!, PASEO_ID, `${file}: ${m[2]}`);
    // Ids passed by name are always *_ID constants, so the check above covers them. (Two capitals at
    // least: a one-letter name is a type parameter, as in `{ id: T }`.)
    for (const m of text.matchAll(/\b(?:id|name|kind):\s*([A-Z][A-Z0-9_]+)\b/g)) assert.match(m[1]!, /_ID$/, `${file}: id constant ${m[1]} is not named *_ID`);
  }
});

test("no other code module sits in the plugin root", async () => {
  const entries = await readdir(ROOT);
  const code = entries.filter((name) => /\.(ts|tsx)$/.test(name));
  assert.deepEqual(code.sort(), ["index.client.tsx", "index.server.ts"]);
});
