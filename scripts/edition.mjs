import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Writes shared/edition.generated.ts: which copy of the plugin this checkout is. Paseo does not tell a
 * plugin the id it was installed under, so the checkout says it instead. Paseo installs the plugin
 * from git with the `build` commands of paseo-plugin.json, the last of which runs this with
 * `release`; `npm install` in a working copy runs it with `dev` (package.json, postinstall).
 *
 *   node scripts/edition.mjs release|dev [file]
 *
 * The file defaults to shared/edition.generated.ts; tests write elsewhere.
 */

const edition = process.argv[2];
if (edition !== "release" && edition !== "dev") {
  console.error("usage: node scripts/edition.mjs release|dev [file]");
  process.exit(2);
}
const target = process.argv[3] ?? fileURLToPath(new URL("../shared/edition.generated.ts", import.meta.url));
writeFileSync(
  target,
  `// Written by scripts/edition.mjs; not in git.\nexport const EDITION: "release" | "dev" = "${edition}";\n`,
);
