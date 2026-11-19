import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "./redact.ts";

test("obvious secrets are replaced: prefixed tokens, credentials in URLs, secret-named assignments, private keys", () => {
  const pat = `ghp_${"a1B2".repeat(9)}`;
  const text = [
    `export GITHUB_TOKEN=${pat}`,
    `glpat-${"x".repeat(20)} and sk-ant-${"k".repeat(30)}`,
    "git clone https://oauth2:s3cr3tvalue@gitlab.example.com/a/b.git",
    "DATABASE_PASSWORD=hunter2hunter2",
    'config: {"api_key": "abc123def456"}',
    "Authorization: Bearer abc123defghijklmnopqrstu",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----",
    "AWS key AKIAABCDEFGHIJKLMNOP here",
    "SMTP_PASS=mailpass1 and the password: hunter22",
    `stripe sk_live_${"Z9".repeat(10)}`,
  ].join("\n");
  const { text: out, count } = redactSecrets(text);
  assert.equal(
    out,
    [
      "export GITHUB_TOKEN=[redacted]",
      "[redacted] and [redacted]",
      "git clone https://[redacted]@gitlab.example.com/a/b.git",
      "DATABASE_PASSWORD=[redacted]",
      'config: {"api_key": [redacted]}',
      "Authorization: Bearer [redacted]",
      "[redacted] private key",
      "AWS key [redacted] here",
      "SMTP_PASS=[redacted] and the password: [redacted]",
      "stripe [redacted]",
    ].join("\n"),
  );
  assert.equal(count, 12);
  assert.equal(out.includes(pat), false);
});

test("ordinary text stays as written", () => {
  const text = [
    "Done: token refresh rewritten; Tokenizer: rewritten too.",
    "Left: the password reset page.",
    "Verify: npm test; NODE_ENV=production npm run build",
    "ssh://git@github.com/acme/core.git and https://github.com/acme/core/pull/7",
    "the token: see below; the password: changed in vault; Token: rotated yesterday",
    "Basic internationalization support",
    "Verify: all tests passed: 326/326; Bypass: --no-verify was not used; max tokens: 128000",
    "compass_heading=north-east; TESTS_PASSED=326",
  ].join("\n");
  assert.deepEqual(redactSecrets(text), { text, count: 0 });
});
