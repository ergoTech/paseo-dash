/**
 * Obvious secrets taken out of text an agent writes into the plan (05-architecture.md, Security):
 * the plan is shared with collaborators and may be mirrored elsewhere, and an agent's handoff can
 * quote a command line or a config it saw. This catches the obvious forms only (tokens with a known
 * prefix, credentials inside URLs, `KEY=value` with a secret-like name, private key blocks); it is a
 * guard against accidents, not a scanner.
 */

const MARK = "[redacted]";

/** Tokens recognised by their prefix alone. */
const PREFIXED = [
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g,
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bhf_[A-Za-z0-9]{30,}/g,
  // JSON Web Tokens: header and payload both start with `{"`.
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;

/** `scheme://user:password@host`: the whole user part goes, since either half may be the token. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;

/** A credential has a digit or a symbol, so "Basic internationalization" stays. */
const BEARER = /\b(Bearer|Basic)\s+(?=[A-Za-z._~-]*[0-9+/=])[A-Za-z0-9._~+/-]{16,}=*/gi;

/**
 * `NAME=value` or `NAME: value` where the name says it holds a secret. The value must look like one
 * (no spaces, at least 6 characters, or quoted), so prose such as "the token: see below" stays; after
 * a colon and a plain word, it must also be more than letters.
 */
const ASSIGNMENT =
  /\b([A-Za-z0-9_.-]*(?:secret|token|pass(?:wor)?d?|pwd|api[_-]?key|private[_-]?key|access[_-]?key|credentials?)[A-Za-z0-9_.-]*)(["']?[ \t]*[=:][ \t]*)("[^"\n]+"|'[^'\n]+'|[^\s"'`,;]{6,})/gi;

/** A name that reads as a config key rather than a word of prose. */
const CONFIG_NAME = /[_.-]/;
/** Names that say "secret" anywhere in them. */
const STRONG_NAME = /secret|token|passw(?:or)?d|api[_-]?key|private[_-]?key|access[_-]?key|credential/i;
/** `pass` and `pwd` only as a whole part of a name (`SMTP_PASS`), never inside "passed" or "compass". */
const SHORT_NAME = /(?:^|[_.-])(?:pass|pwd)(?:$|[_.-])/i;
/** A prose word before a colon that is itself the name of a secret. */
const PROSE_NAME = /^(?:secret|token|passw(?:or)?d|apikey|credentials?)$/i;

export interface Redacted {
  text: string;
  /** How many values were replaced. */
  count: number;
}

export function redactSecrets(text: string): Redacted {
  let count = 0;
  const swap = (pattern: RegExp, replace: (...match: string[]) => string) => {
    text = text.replace(pattern, (...match: string[]) => {
      count += 1;
      return replace(...match);
    });
  };
  swap(PRIVATE_KEY, () => `${MARK} private key`);
  swap(URL_CREDENTIALS, (_whole, scheme) => `${scheme}${MARK}@`);
  for (const pattern of PREFIXED) swap(pattern, () => MARK);
  swap(BEARER, (_whole, scheme) => `${scheme} ${MARK}`);
  // A value already replaced above is not counted twice.
  text = text.replace(ASSIGNMENT, (whole, name: string, between: string, value: string) => {
    if (value.includes(MARK)) return whole;
    if (!STRONG_NAME.test(name) && !SHORT_NAME.test(name)) return whole;
    // With a colon after a plain word, only a secret's own name and a value that is not a word count,
    // so prose such as "Tokenizer: rewritten", "the password: changed" or "tests passed: 3/3" stays.
    const plain = !between.includes("=") && !/^["']/.test(between) && !CONFIG_NAME.test(name) && name !== name.toUpperCase();
    if (plain && (!PROSE_NAME.test(name) || /^[A-Za-z]+$/.test(value))) return whole;
    count += 1;
    return `${name}${between}${MARK}`;
  });
  return { text, count };
}
