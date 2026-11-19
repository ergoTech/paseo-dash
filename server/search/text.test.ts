import assert from "node:assert/strict";
import { test } from "node:test";
import { editDistance, idForms, normalizeWord, otherLayouts, queryWords, stem, tokenize, typoBudget } from "./text.ts";

test("words are compared lowercased, apostrophes inside a word kept as one word, ё as е, Latin accents dropped", () => {
  assert.deepEqual(queryWords("Пам'ять і ПАМ’ЯТЬ, памʼять"), ["память", "і"]);
  assert.equal(normalizeWord("Ёлка"), "елка");
  assert.equal(normalizeWord("Café"), "cafe");
  // Ukrainian letters with marks stay what they are.
  assert.deepEqual(queryWords("Йод їжак"), ["йод", "їжак"]);
  // Each token knows where it stands in the text as written, for the quote.
  const [first, second] = tokenize("Fix  пам'ять");
  assert.deepEqual([first!.start, first!.end, second!.start, second!.end], [0, 3, 5, 12]);
});

test("forms of a word share a stem: Ukrainian, Russian and English", () => {
  const same = (...forms: string[]) => assert.equal(new Set(forms.map(stem)).size, 1, `${forms.join(", ")} → ${forms.map(stem).join(", ")}`);
  same("логін", "логіну", "логіном", "логіни");
  same("задача", "задачі", "задачу", "задачами", "задач");
  same("користувачі", "користувачів", "користувачам");
  same("памяті", "память");
  same("оплата", "оплати", "оплатою");
  same("задачи", "задачей", "задачам");
  same("login", "logins");
  same("log", "logs", "logging", "logged");
  same("cache", "cached", "caching", "caches");
  same("story", "stories");
  // Too short to cut, and endings that are no plural.
  assert.equal(stem("кеш"), "кеш");
  assert.equal(stem("class"), "class");
  assert.equal(stem("status"), "status");
  assert.equal(stem("q35"), "q35");
});

test("a typo is an edit: up to one in words of four to seven letters, two from eight, none in short words or numbers", () => {
  assert.equal(editDistance("gogle", "google", 1), 1);
  assert.equal(editDistance("teh", "the", 1), 1, "two neighbours swapped are one edit");
  assert.equal(editDistance("sesion", "session", 2), 1);
  assert.equal(editDistance("abcdef", "uvwxyz", 2), 3, "past the limit answers limit + 1");
  assert.deepEqual(["log", "logn", "loginnn", "authorization", "2024"].map(typoBudget), [0, 1, 1, 2, 0]);
});

test("the other keyboard layout reads Latin keys as Ukrainian or Russian letters and back", () => {
  assert.ok(otherLayouts("kjusy").includes("логін"));
  assert.ok(otherLayouts("rfxtcndj").includes("качество"));
  assert.ok(otherLayouts("дщпшт").includes("login"));
  assert.deepEqual(otherLayouts("123"), [], "nothing that has no letters after the swap");
});

test("an id is read however it was typed; a word is not taken for one", () => {
  const keys = ["LAC", "JOB"];
  for (const typed of ["LAC-7K3QX", "lac-7k3qx", "lac7k3qx", "LAC 7K3QX", "lac 7k3 qx", "LAC-7K3QХ", "ЛАС-7К3QХ".replace("Л", "L")]) {
    assert.deepEqual(idForms(typed, keys), { full: "LAC-7K3QX" }, typed);
  }
  // Crockford: O is 0, I and L are 1, in the suffix only.
  assert.deepEqual(idForms("lac-7k3qo", keys), { full: "LAC-7K3Q0" });
  assert.deepEqual(idForms("7K3QX", keys), { suffix: "7K3QX" });
  assert.deepEqual(idForms("7k3qx", keys), { suffix: "7K3QX" }, "a digit makes it an id");
  assert.deepEqual(idForms("login", keys), {}, "a word in lowercase is a word");
  assert.deepEqual(idForms("Add login", keys), {}, "a prefix that is no space key is no id");
  assert.deepEqual(idForms("XYZ-7K3QX", keys), {}, "nor is an unknown space's");
  assert.deepEqual(idForms("lac-7k3qu", keys), {}, "U is not in the alphabet");
});
