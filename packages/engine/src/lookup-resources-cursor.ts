import type { RelationshipReference } from "@benedb/core/relationship-reference";

/**
 * One nesting level of a {@link LookupResourcesCursor}. Exactly one resume mechanism applies per
 * section, selected by the entrypoint kind at this level:
 *
 *   * **Portion-1 leaf** (`entrypointIndex === -1`): resume the self-match by skipping sorted
 *     resource ids at or before {@link lastResourceId}.
 *   * **Query entrypoint** (Relation / arrow): resume the reverse-query stream strictly after
 *     {@link afterKeyset} (the last fully-consumed chunk's final relationship). Absent means the
 *     first chunk (resume from the start of this entrypoint).
 *   * **Structural rewrite** (Self / ComputedUserset): no within-level position; resumption is
 *     carried entirely by the deeper sections. Both {@link lastResourceId} and
 *     {@link afterKeyset} are absent.
 *
 * Ported from Spiceport `src/Spiceport.Server/Engine/Lookup/LookupResourcesCursor.cs`.
 *
 * Port decisions:
 *   * `EntrypointIndex` of -1 is a SENTINEL, and the engine branches on `EntrypointIndex: >= 0`
 *     in three places, so it stays a plain `number` rather than a union.
 *   * `undefined` stays distinct from a value in both optional fields: an absent `afterKeyset`
 *     means "the first chunk", which is not the same as any keyset value.
 *   * `AfterKeyset` is a core `RelationshipReference` - the exclusive datastore keyset. If a
 *     cursor is ever base64'd for the wire, that encoding is decided at the API layer (S5).
 */
export interface LookupResourcesCursorSection {
  /** The entrypoint index being resumed (-1 marks the Portion-1 self-match leaf). */
  readonly entrypointIndex: number;
  /** For the Portion-1 leaf: the last sorted resource id already yielded. */
  readonly lastResourceId?: string | undefined;
  /** For a query entrypoint: the exclusive datastore keyset to resume the scan after. */
  readonly afterKeyset?: RelationshipReference | undefined;
}

/**
 * An opaque resume token for `lookupResources`, made of one ordered section per nesting level.
 * Port of SpiceDB's cursored response sections, simplified to deterministic-ordering resume (no
 * chunk cache / parallel cursored iterators).
 *
 * Iteration is deterministic: entrypoints are processed in a fixed order and resource ids are
 * sorted, so a section's `(entrypointIndex, lastResourceId)` uniquely positions resumption.
 * Passing a cursor skips entrypoints before {@link LookupResourcesCursorSection.entrypointIndex}
 * and resource ids at or before {@link LookupResourcesCursorSection.lastResourceId} within the
 * resumed entrypoint, then recurses with the remaining nested sections.
 *
 * `ImmutableList<LookupResourcesCursorSection>` becomes a `readonly` array COPIED ON WRITE: the
 * engine only ever does `RemoveAt(0)` (-> `sections.slice(1)`) and `Insert(0, section)`
 * (-> `[section, ...inner]`), so `shift`/`unshift` never appear.
 */
export interface LookupResourcesCursor {
  /** One section per nesting level, outermost first. */
  readonly sections: readonly LookupResourcesCursorSection[];
}

/** Creates a cursor section, applying the C# record's parameter defaults. */
export function createLookupResourcesCursorSection(
  entrypointIndex: number,
  lastResourceId?: string | undefined,
  afterKeyset?: RelationshipReference | undefined,
): LookupResourcesCursorSection {
  return { entrypointIndex, lastResourceId, afterKeyset };
}

/** Creates a cursor, snapshotting the supplied sections. */
export function createLookupResourcesCursor(
  sections: readonly LookupResourcesCursorSection[],
): LookupResourcesCursor {
  return { sections: [...sections] };
}

/**
 * An empty cursor (start from the beginning).
 *
 * The C# `LookupResourcesCursor.Empty` is a static property over an initialised backing field, so
 * this is a frozen module constant, NEVER a factory: call sites compare and reuse it.
 */
export const LOOKUP_RESOURCES_CURSOR_EMPTY: LookupResourcesCursor = Object.freeze({
  sections: Object.freeze([] as readonly LookupResourcesCursorSection[]),
});
