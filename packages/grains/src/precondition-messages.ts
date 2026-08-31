import type { RelationshipsFilter } from "@benedb/datastore/relationships-filter";

import type { PreconditionFailureKind } from "./precondition-failed-exception";

/**
 * The single copy of the precondition-failure message text: `DatastoreGrain.commit` evaluates
 * preconditions and returns it as `CommitFailureWire.detail`, and the client side
 * (`RelationshipsGrain`) reconstructs a byte-identical `PreconditionFailedException` from it (via
 * {@link tryParsePreconditionFailure}). Do not duplicate the format - the zed-compat contract is
 * that the message a caller observes is unchanged from the historical inline evaluation.
 *
 * A deliberately multi-export module, mirroring the C# static class: the three functions are one
 * contract and only make sense together.
 */

/** The failure text for a MUST_MATCH precondition whose filter matched no relationships. */
export function mustMatchFailedMessage(index: number, filter: RelationshipsFilter): string {
  return `precondition ${index} failed: MUST_MATCH filter [${describe(filter)}] matched no relationships`;
}

/**
 * The failure text for a MUST_NOT_MATCH precondition whose filter matched at least one
 * relationship.
 */
export function mustNotMatchFailedMessage(index: number, filter: RelationshipsFilter): string {
  return `precondition ${index} failed: MUST_NOT_MATCH filter [${describe(filter)}] matched at least one relationship`;
}

/** What {@link tryParsePreconditionFailure} recovers from a message this module produced. */
export interface ParsedPreconditionFailure {
  /** How the precondition failed. */
  readonly kind: PreconditionFailureKind;
  /** The zero-based index of the failing precondition within the request. */
  readonly index: number;
}

/**
 * The inverse of the two factory functions above: recovers the failure kind and precondition index
 * from a message THIS module produced, so the client side of the grain commit (which receives the
 * message as `CommitFailureWire.detail`) can reconstruct the exact
 * `PreconditionFailedException(kind, index, message)` the inline evaluation used to throw - same
 * type, same properties, byte-identical message. Returns `undefined` for any text this module did
 * not produce (the caller then falls back rather than guessing).
 *
 * PORT NOTE. The C# is `int.TryParse(span, NumberStyles.None, CultureInfo.InvariantCulture)`, which
 * accepts DIGITS ONLY: no sign, no whitespace, no group or underscore separators, no decimal point,
 * no exponent, no hex, no non-ASCII digits, and it fails on the empty span. `Number` and `parseInt`
 * accept most of those, so the index span is regex-validated first and then range-checked against
 * int32 (the C# parses into an `int`). The C# works over `ReadOnlySpan<char>` with
 * `StringComparison.Ordinal`; plain JS `startsWith`/`slice` is already ordinal.
 */
export function tryParsePreconditionFailure(
  message: string,
): ParsedPreconditionFailure | undefined {
  const prefix = "precondition ";
  if (!message.startsWith(prefix)) return undefined;

  let rest = message.slice(prefix.length);
  const space = rest.indexOf(" ");
  if (space <= 0) return undefined;

  const digits = rest.slice(0, space);
  if (!/^[0-9]+$/.test(digits)) return undefined;
  const index = Number(digits);
  // `int.TryParse` overflows to false past int32.
  if (index > 2147483647) return undefined;

  rest = rest.slice(space);
  const mustMatch = " failed: MUST_MATCH filter [";
  const mustNotMatch = " failed: MUST_NOT_MATCH filter [";
  // MUST_NOT_MATCH is checked FIRST, as in the C#. Neither literal is a prefix of the other, so the
  // order is not load-bearing for correctness - it is copied because the C# has it.
  if (rest.startsWith(mustNotMatch)) return { kind: "mustNotMatchFoundOne", index };
  if (rest.startsWith(mustMatch)) return { kind: "mustMatchFoundNone", index };

  return undefined;
}

/**
 * The human-readable filter description embedded in the failure messages (resource/subject
 * constraints only - the caveat/expiration options play no part in the data-plane precondition
 * surface and are deliberately not described).
 *
 * The field order is fixed. Note the deliberate absent-vs-empty asymmetry, straight from the C#:
 * `OptionalResourceType is { } rt` matches the EMPTY string, while `OptionalResourceIdPrefix is
 * { Length: > 0 }` and the two id lists do not. The trailing `TrimEnd()` uses .NET's whitespace
 * set, but only ASCII spaces are ever appended here, so `trimEnd` is exactly equivalent.
 */
function describe(f: RelationshipsFilter): string {
  let sb = "";
  if (f.optionalResourceType !== undefined) sb += `resource_type=${f.optionalResourceType} `;
  if (f.optionalResourceIds !== undefined && f.optionalResourceIds.length > 0)
    sb += `resource_ids=${f.optionalResourceIds.join(",")} `;
  if (f.optionalResourceIdPrefix !== undefined && f.optionalResourceIdPrefix.length > 0)
    sb += `resource_id_prefix=${f.optionalResourceIdPrefix} `;
  if (f.optionalResourceRelation !== undefined) sb += `relation=${f.optionalResourceRelation} `;
  if (f.optionalSubjectsSelectors !== undefined && f.optionalSubjectsSelectors.length > 0) {
    for (const s of f.optionalSubjectsSelectors) {
      if (s.optionalSubjectType !== undefined) sb += `subject_type=${s.optionalSubjectType} `;
      if (s.optionalSubjectIds !== undefined && s.optionalSubjectIds.length > 0)
        sb += `subject_ids=${s.optionalSubjectIds.join(",")} `;
    }
  }
  return sb.trimEnd();
}
