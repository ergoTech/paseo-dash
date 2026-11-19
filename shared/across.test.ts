import { test } from "node:test";
import assert from "node:assert/strict";
import { spaceForTask, spaceOfId } from "./across.ts";

test("a plan id names its space by its key prefix", () => {
  assert.equal(spaceOfId("JOBBY-ATTXF"), "JOBBY");
  assert.equal(spaceOfId("LAC-7K3QX"), "LAC");
  assert.equal(spaceOfId("not an id"), "");
  assert.equal(spaceOfId("lac-7k3qx"), "", "ids are upper case");
});

test("a new task goes to the space of its project; a project key several spaces hold asks which", () => {
  const spaces = [
    { space: "JOBBY", projects: ["core", "dashboard"] },
    { space: "ERG", projects: ["core", "site"] },
    { space: "PDT", projects: ["ios"] },
  ];
  assert.deepEqual(spaceForTask(spaces, "dashboard", ""), { space: "JOBBY", choices: ["JOBBY"] }, "one space holds it: no question");
  assert.deepEqual(spaceForTask(spaces, "dashboard", "ERG"), { space: "JOBBY", choices: ["JOBBY"] }, "an earlier pick does not move it elsewhere");
  assert.deepEqual(spaceForTask(spaces, "core", ""), { space: "", choices: ["JOBBY", "ERG"] }, "ambiguous: asks, never guesses");
  assert.deepEqual(spaceForTask(spaces, "core", "ERG"), { space: "ERG", choices: ["JOBBY", "ERG"] });
  assert.deepEqual(spaceForTask(spaces, "core", "PDT"), { space: "", choices: ["JOBBY", "ERG"] }, "a pick that does not hold the project does not count");
  assert.deepEqual(spaceForTask(spaces, "", ""), { space: "", choices: ["JOBBY", "ERG", "PDT"] }, "a draft without a project asks among all");
  assert.deepEqual(spaceForTask(spaces, "", "PDT"), { space: "PDT", choices: ["JOBBY", "ERG", "PDT"] });
  assert.deepEqual(spaceForTask([{ space: "TST", projects: [] }], "", ""), { space: "TST", choices: ["TST"] }, "a single space needs no question");
});
