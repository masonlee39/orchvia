/**
 * SPEC-0053 E07, SPEC-0060 M: masks what looks like a secret in a command or in text, before it is
 * written: the value after a name such as TOKEN, SECRET, PASSWORD or API_KEY, a Bearer or Basic
 * credential, and the shapes of common keys. It is a best effort, not a guarantee.
 *
 * SPEC-0060 M01: the time is proportional to the text. A pattern that begins with "any run of name
 * characters, then a name" tries every start and every length of that run, which a text such as
 * `token-token-token-…` makes the square or the cube of its length. Here each run of name
 * characters is found once, and looked at once.
 */

/** A run of the characters a secret's name is made of. */
const RUN = /[A-Za-z0-9_-]+/g;
const KEYWORD =
  /token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential/i;
const VALUE = `(?:"[^"]*"|'[^']*'|[A-Za-z0-9_+/=~@](?:[A-Za-z0-9_+/=.~:@-]*[A-Za-z0-9_+/=~@-])?)`;
/** After a name: `=` or `:` and a value, as in `API_KEY=abc` or `password: abc`. */
const ASSIGNED = new RegExp(`(\\s*[=:]\\s*)${VALUE}`, 'y');
/** After a flag: space and a value, as in `--token abc`. */
const SPACED = new RegExp(`(\\s+)${VALUE}`, 'y');
const OTHERS: [RegExp, string][] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***'],
  [
    /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16})\b/g,
    '***',
  ],
];

/** A name on its own: the run holds one of the names. */
const named = (run: string) => KEYWORD.test(run);
/** A flag: a dash in the run, and one of the names after it. */
const flagged = (run: string) => {
  const dash = run.indexOf('-');
  return dash !== -1 && KEYWORD.test(run.slice(dash + 1));
};

/** Masks the value that `follows` finds right after each run of name characters that `is` accepts. */
function maskAfter(text: string, is: (run: string) => boolean, follows: RegExp): string {
  let out = '';
  let kept = 0;
  RUN.lastIndex = 0;
  for (let run: RegExpExecArray | null; (run = RUN.exec(text)); ) {
    const end = run.index + run[0].length;
    if (!is(run[0])) continue;
    follows.lastIndex = end;
    const found = follows.exec(text);
    if (!found) continue;
    out += text.slice(kept, end) + found[1] + '***';
    kept = end + found[0].length;
    // The value is not looked at again, as a replaced match is not.
    RUN.lastIndex = kept;
  }
  return kept ? out + text.slice(kept) : text;
}

export function maskSecrets(value: string): string {
  const assigned = maskAfter(value, named, ASSIGNED);
  const spaced = maskAfter(assigned, flagged, SPACED);
  return OTHERS.reduce((text, [pattern, mask]) => text.replace(pattern, mask), spaced);
}

/**
 * SPEC-0060 M03: the most text that is examined for what is kept of it. Far more than is kept,
 * because a value is masked whole: a quoted key of some thousand characters that begins in the
 * part that is kept must be seen to its closing quote.
 */
export const MASKED_CHARACTERS = 262_144;
