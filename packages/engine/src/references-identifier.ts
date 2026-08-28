/**
 * Whole-word identifier detection over raw CEL expression text.
 *
 * Extracted from Spiceport `Engine/CaveatEvaluator.cs`'s private `ReferencesIdentifier`, which is
 * duplicated verbatim in `Engine/SchemaTypeValidator.cs`. The C# regex is
 * `(?<![\w.])<Regex.Escape(identifier)>\b`: the identifier must not be preceded by a word
 * character or a dot (so it is neither part of a longer name nor a field selector), and must end
 * on a word boundary.
 *
 * Port decisions:
 *   * .NET's `\w` and `\b` are UNICODE-aware; JavaScript's are ASCII-only, so a non-ASCII caveat
 *     parameter name would disagree between the two. The word class is spelled out as
 *     `[\p{L}\p{M}\p{Nd}\p{Pc}]` (.NET's `\w`) with the `u` flag, and the trailing `\b` becomes an
 *     explicit lookahead over the same class.
 *   * `Regex.Escape` has no JavaScript counterpart, so the metacharacter escape is hand-rolled.
 *     .NET's `Regex.Escape` also escapes whitespace and `#`; those are escaped here too, so the
 *     two agree even on a (pathological) parameter name containing them.
 */

/** .NET's `\w`: letters, combining marks, decimal digits and connector punctuation. */
const WORD_CLASS = "[\\p{L}\\p{M}\\p{Nd}\\p{Pc}]";

/** The characters .NET's `Regex.Escape` replaces with an escaped form. */
const ESCAPABLE = /[\\*+?|{}[\]()^$.#\s]/g;

/** Hand-rolled `Regex.Escape`: prefixes every regex metacharacter with a backslash. */
function escapeRegex(value: string): string {
  return value.replace(ESCAPABLE, "\\$&");
}

/**
 * True when `expression` references `identifier` as a whole word that is not a field selection.
 *
 * Purely textual, exactly as in the C#: it does not parse the expression, so an identifier
 * appearing inside a string literal counts as a reference. That over-approximation is safe in
 * both call sites - it only ever widens the set of parameters reported as missing.
 */
export function referencesIdentifier(expression: string, identifier: string): boolean {
  const escaped = escapeRegex(identifier);
  // `\b` after the identifier: if it ends in a word character the next character must not be one;
  // if it ends in a non-word character the next character must be one.
  const last = identifier.slice(-1);
  const endsOnWord = last !== "" && new RegExp(`^${WORD_CLASS}$`, "u").test(last);
  const boundary = endsOnWord ? `(?!${WORD_CLASS})` : `(?=${WORD_CLASS})`;
  return new RegExp(`(?<![${WORD_CLASS.slice(1, -1)}.])${escaped}${boundary}`, "u").test(
    expression,
  );
}
