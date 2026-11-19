import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPush, type GitResult, SAFE_BRANCH } from "./git.ts";

const failed = (stderr: string): GitResult => ({ code: 1, stdout: "", stderr, timedOut: false });

test("push results: only a failure before anything was sent counts as unreachable", () => {
  assert.equal(classifyPush(failed("fatal: Could not read from remote repository.")), "unreachable");
  assert.equal(classifyPush(failed("ssh: Could not resolve host github.com")), "unreachable");
  assert.equal(
    classifyPush(failed("To github.com:acme/plan.git\nfatal: the remote end hung up unexpectedly\nfatal: Could not read from remote repository.")),
    "unknown",
  );
  assert.equal(classifyPush(failed("remote: Permission to acme/plan.git denied to anna.\nfatal: unable to access")), "unknown");
  assert.equal(classifyPush(failed("To x\n ! [rejected]        HEAD -> main (fetch first)")), "rejected");
  assert.equal(classifyPush(failed("To x\n ! [remote rejected] HEAD -> main (failed to update ref)")), "rejected");
  assert.equal(classifyPush(failed("To x\n ! [remote rejected] HEAD -> main (protected branch hook declined)")), "declined");
  assert.equal(classifyPush({ code: 1, stdout: "", stderr: "", timedOut: true }), "unknown");
});

test("branch names: only what git accepts and nothing that reads as an option", () => {
  for (const ok of ["main", "feat/totp-2fa", "task/tst-fx001-fix", "release-2.3"]) assert.match(ok, SAFE_BRANCH, ok);
  for (const bad of ["--upload-pack=x", "-x", "/x", ".x", "a/.b", "x.lock", "a.lock/b", "a..b", "a//b", "a/", "a.", "a b", "a~1", "a:b"]) {
    assert.doesNotMatch(bad, SAFE_BRANCH, bad);
  }
});
