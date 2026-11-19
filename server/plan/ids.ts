import { randomBytes } from "node:crypto";

/** Crockford base32: no I, L, O, U, so ids read aloud and typed by hand survive. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A new random id `<KEY>-<5 chars>`, checked against every id the caller knows. Random instead of a
 * counter so two people creating tasks between syncs do not collide (03-model.md, Ids).
 */
export function newId(key: string, taken: ReadonlySet<string>): string {
  for (;;) {
    const bytes = randomBytes(5);
    const id = `${key}-${[...bytes].map((byte) => CROCKFORD[byte & 31]).join("")}`;
    if (!taken.has(id)) return id;
  }
}

/** A unique id for an operation or a run; never shown to people. */
export function opaqueId(prefix: string): string {
  return `${prefix}-${randomBytes(9).toString("base64url")}`;
}

const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ie", ж: "zh", з: "z", и: "y", і: "i",
  ї: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u",
  ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ь: "", ю: "iu", я: "ia", ё: "io", ы: "y",
  э: "e", ъ: "",
};

const SLUG_LENGTH = 48;

/** An ASCII slug of a title; Cyrillic is transliterated, everything else not a-z0-9 becomes "-". */
export function slugify(title: string): string {
  const latin = [...title.toLowerCase()].map((char) => CYRILLIC[char] ?? char).join("");
  const ascii = latin.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  return ascii
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_LENGTH)
    .replace(/-+$/g, "");
}

/** `<id>-<slug>.md`, or `<id>.md` when the title has nothing to slug. The name never changes afterwards. */
export function entityFileName(id: string, title: string): string {
  const slug = slugify(title);
  return slug ? `${id}-${slug}.md` : `${id}.md`;
}
