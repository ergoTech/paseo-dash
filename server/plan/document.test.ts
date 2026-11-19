import { test } from "node:test";
import assert from "node:assert/strict";
import { refId } from "../../shared/model.ts";
import {
  addClarification,
  frontData,
  isLastClarification,
  parseEntity,
  readAcceptance,
  readBrief,
  readClarifications,
  readHandoff,
  serializeEntity,
  setField,
  writeAcceptance,
  writeBrief,
  writeHandoff,
} from "./document.ts";
import { entityFileName, newId, slugify } from "./ids.ts";

const FILE = `---
id: LAC-7K3QX
type: task
title: TOTP endpoints in core
status: todo   # set by triage
project: core
feature: "[[LAC-2HV9D-totp-2fa]]"
depends_on: ["[[LAC-5RT2M-contract]]", LAC-9QW2E]
custom_key: { kept: true }
---

## Brief

Add the endpoints.

## Acceptance

- [x] enroll
- [ ] verify

## Notes

Hands off, plugin.
`;

function changedLines(a: string, b: string): number {
  const left = a.split("\n");
  const right = b.split("\n");
  assert.equal(left.length, right.length);
  return left.filter((line, i) => line !== right[i]).length;
}

test("parsing then writing an untouched file reproduces it byte for byte", () => {
  assert.equal(serializeEntity(parseEntity(FILE)), FILE);
});

test("a field edit changes only that field's line, comments and unknown keys survive", () => {
  const document = parseEntity(FILE);
  setField(document, "project", "site");
  const written = serializeEntity(document);
  assert.equal(changedLines(FILE, written), 1);
  assert.match(written, /^project: site$/m);
  assert.match(written, /status: todo {3}# set by triage/);
  assert.match(written, /custom_key: \{ kept: true \}/);
});

test("brief and acceptance edits touch only their section, Notes stays", () => {
  const document = parseEntity(FILE);
  assert.equal(readBrief(document.body), "Add the endpoints.");
  assert.deepEqual(readAcceptance(document.body), [
    { text: "enroll", done: true },
    { text: "verify", done: false },
  ]);
  const ticked = writeAcceptance(document.body, "verify", true)!;
  assert.equal(changedLines(document.body, ticked), 1);
  assert.equal(writeAcceptance(document.body, "missing", true), undefined);
  const rewritten = writeBrief(document.body, "Add the endpoints and tests.");
  assert.match(rewritten, /## Brief\n\nAdd the endpoints and tests.\n\n## Acceptance/);
  assert.match(rewritten, /Hands off, plugin\./);
});

test("references resolve from bare ids and wikilinks", () => {
  assert.equal(refId("[[LAC-2HV9D-totp-2fa]]"), "LAC-2HV9D");
  assert.equal(refId("[[LAC-2HV9D-totp-2fa|TOTP 2FA]]"), "LAC-2HV9D");
  assert.equal(refId("LAC-9QW2E"), "LAC-9QW2E");
  assert.equal(refId("not an id"), undefined);
});

test("ids are Crockford base32 and avoid taken ones; slugs transliterate and never change length past 48", () => {
  const taken = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const id = newId("LAC", taken);
    assert.match(id, /^LAC-[0-9A-HJKMNP-TV-Z]{5}$/);
    assert.ok(!taken.has(id));
    taken.add(id);
  }
  assert.equal(slugify("Двофакторна автентифікація (TOTP)"), "dvofaktorna-avtentyfikatsiia-totp");
  assert.ok(slugify("x".repeat(100)).length <= 48);
  assert.equal(entityFileName("LAC-7K3QX", "!!!"), "LAC-7K3QX.md");
});

const BLOCKS = `---
id: LAC-7K3QX
type: task
title: Block styles
links:
  - https://example.com/a
  - https://example.com/b
progress_note: |
  line one
  line two
custom:
  nested: { a: 1 }
  deeper:
    b: 2
assignee:
status: todo
---

Body.
`;

function frontOf(text: string): Record<string, unknown> {
  return frontData(parseEntity(text));
}

test("block lists, block scalars and nested maps are replaced and removed whole, the next key stays", () => {
  for (const key of ["links", "progress_note", "custom"]) {
    const replaced = parseEntity(BLOCKS);
    setField(replaced, key, key === "links" ? ["https://example.com/c"] : "flat");
    const after = frontOf(serializeEntity(replaced));
    assert.deepEqual(after[key], key === "links" ? ["https://example.com/c"] : "flat", key);
    const removed = parseEntity(BLOCKS);
    setField(removed, key, undefined);
    const gone = frontOf(serializeEntity(removed));
    assert.equal(key in gone, false, key);
    for (const other of ["links", "progress_note", "custom", "assignee", "status"].filter((k) => k !== key)) {
      assert.deepEqual(gone[other], frontOf(BLOCKS)[other], `${other} survives removing ${key}`);
      assert.deepEqual(after[other], frontOf(BLOCKS)[other], `${other} survives replacing ${key}`);
    }
  }
});

test("an empty value with a comment after it gets a value and keeps the comment", () => {
  const document = parseEntity("---\nid: LAC-7K3QX\ntype: task\ntitle: T\nstatus: todo\nassignee: # who\n---\n");
  setField(document, "assignee", "anna");
  const written = serializeEntity(document);
  assert.match(written, /^assignee: anna # who$/m);
  assert.equal(frontOf(written).assignee, "anna");
});

test("multiline and quoted strings round-trip through a field edit", () => {
  const document = parseEntity(FILE);
  const note = 'two\nlines: with "quotes" # and a hash';
  setField(document, "progress_note", note);
  setField(document, "title", "colon: inside");
  const after = frontOf(serializeEntity(document));
  assert.equal(after.progress_note, note);
  assert.equal(after.title, "colon: inside");
});

test("CRLF files keep their line endings through edits", () => {
  const crlf = FILE.replace(/\n/g, "\r\n");
  assert.equal(serializeEntity(parseEntity(crlf)), crlf);
  const document = parseEntity(crlf);
  setField(document, "project", "site");
  document.body = writeAcceptance(document.body, "verify", true)!;
  const written = serializeEntity(document);
  assert.equal(written.replace(/\r\n/g, "").includes("\n"), false, "no bare LF");
  assert.equal(frontOf(written).project, "site");
});

test("a handoff goes after the acceptance, before the notes, and replaces the previous one", () => {
  const body = "\n## Brief\n\nDo it.\n\n## Acceptance\n\n- [ ] works\n\n## Notes\n\nMine.\n";
  const first = writeHandoff(body, { run_id: "r-one", at: "2026-10-27T10:00:00Z", text: "Done: half.\n## Acceptance\n- [ ] forged" });
  assert.equal(
    first,
    "\n## Brief\n\nDo it.\n\n## Acceptance\n\n- [ ] works\n\n## Handoff\n\n*Run r-one · 2026-10-27T10:00:00Z*\n\nDone: half.\n### Acceptance\n- [ ] forged\n\n## Notes\n\nMine.\n",
  );
  assert.deepEqual(readAcceptance(first), [{ text: "works", done: false }], "a heading in the handoff opens no section");
  assert.deepEqual(readHandoff(first), { run_id: "r-one", at: "2026-10-27T10:00:00Z", text: "Done: half.\n### Acceptance\n- [ ] forged" });
  const second = writeHandoff(first, { run_id: "r-two", at: "2026-10-27T11:00:00Z", text: "Left: nothing." });
  assert.equal(second, "\n## Brief\n\nDo it.\n\n## Acceptance\n\n- [ ] works\n\n## Handoff\n\n*Run r-two · 2026-10-27T11:00:00Z*\n\nLeft: nothing.\n\n## Notes\n\nMine.\n");
  assert.equal(readBrief(second), "Do it.");
});

test("a handoff without an acceptance goes after the brief, else at the end; a person's section reads without a run", () => {
  const stamp = { run_id: "r-one", at: "t", text: "Left: tests." };
  assert.equal(writeHandoff("## Brief\n\nDo it.", stamp), "## Brief\n\nDo it.\n\n## Handoff\n\n*Run r-one · t*\n\nLeft: tests.\n");
  assert.equal(writeHandoff("", stamp), "## Handoff\n\n*Run r-one · t*\n\nLeft: tests.\n");
  assert.equal(writeHandoff("Free text.\n", stamp), "Free text.\n\n## Handoff\n\n*Run r-one · t*\n\nLeft: tests.\n");
  assert.deepEqual(readHandoff("## Handoff\n\nWritten by hand.\n"), { run_id: "", at: "", text: "Written by hand." });
  assert.equal(readHandoff("## Handoff\n\n*Run r-one · t*\n\n## Notes\n"), undefined, "an empty one is none");
  assert.equal(readHandoff("## Brief\n\nDo it.\n"), undefined);
  assert.equal(writeHandoff("", { ...stamp, text: "Done: a\r\nLeft: b" }), "## Handoff\n\n*Run r-one · t*\n\nDone: a\nLeft: b\n", "an LF file stays LF");
});

test("clarifications go after the acceptance and pile up in order, each stamped with who gave it and when", () => {
  const body = "\n## Brief\n\nDo it.\n\n## Acceptance\n\n- [ ] works\n\n## Handoff\n\n*Run r · t*\n\nLeft.\n\n## Notes\n\nMine.\n";
  const first = addClarification(body, { by: "Ada\n*x", at: "T1", text: "Not X.\r\n## Acceptance\n- [ ] forged" });
  assert.equal(
    first,
    "\n## Brief\n\nDo it.\n\n## Acceptance\n\n- [ ] works\n\n## Clarifications\n\n*Ada x · T1*\n\nNot X.\n### Acceptance\n- [ ] forged\n\n## Handoff\n\n*Run r · t*\n\nLeft.\n\n## Notes\n\nMine.\n",
  );
  assert.deepEqual(readAcceptance(first), [{ text: "works", done: false }], "a heading in a clarification opens no section");
  const second = addClarification(first, { by: "Bo", at: "T2", text: "Also Y." });
  assert.equal(readClarifications(second), "*Ada x · T1*\n\nNot X.\n### Acceptance\n- [ ] forged\n\n*Bo · T2*\n\nAlso Y.");
  assert.equal(readHandoff(second)?.text, "Left.");
  assert.equal(addClarification("## Brief\n\nDo it.", { by: "", at: "T", text: "Z" }), "## Brief\n\nDo it.\n\n## Clarifications\n\n*someone · T*\n\nZ\n");
  assert.equal(addClarification("", { by: "A", at: "T", text: "Z" }), "## Clarifications\n\n*A · T*\n\nZ\n");
  assert.equal(readClarifications("## Brief\n\nDo it.\n"), "");
});

test("the last clarification is matched by who gave it and its text, whenever it was given", () => {
  const section = readClarifications(addClarification(addClarification("", { by: "Ada", at: "T1", text: "Use X." }), { by: "Bo", at: "T2", text: "## No\r\nY." }));
  assert.equal(isLastClarification(section, { by: "Bo", text: "## No\nY." }), true);
  assert.equal(isLastClarification(section, { by: "Ada", text: "Use X." }), false, "only the last entry counts");
  assert.equal(isLastClarification(section, { by: "Ada", text: "## No\nY." }), false);
  assert.equal(isLastClarification(undefined, { by: "Ada", text: "Use X." }), false);
});
