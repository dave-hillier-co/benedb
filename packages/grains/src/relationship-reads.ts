import type { IRevision } from "@spacedb/core/i-revision";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import type { Relationship } from "@spacedb/core/relationship";
import { formatRelationship } from "@spacedb/core/tuple-strings";
import { zedTokenFromRevision } from "@spacedb/core/zed-tokens";
import type { IDatastore } from "@spacedb/datastore/i-datastore";
import type {
  RelationshipsFilter,
  SubjectRelationFilter,
  SubjectsSelector,
} from "@spacedb/datastore/relationships-filter";
import { resolveRevision } from "@spacedb/datastore/revision-resolver";

import { encodeBulkExportCursor, tryDecodeBulkExportCursor } from "./bulk-export-cursor";
import { consistencyWireToRequirement, MINIMIZE_LATENCY_WIRE } from "./consistency-wire";
import type { ISchemaProvider } from "./i-schema-provider";
import type { ISnapshotScanner } from "./i-snapshot-scanner";
import type {
  BulkExportRelationshipsArgs,
  ReadRelationshipsArgs,
  RelationshipsFilterWire,
  RelationshipStreamItem,
  RelationshipWire,
} from "./relationships-dtos";
import { toWire as relationshipToWire } from "./wire-convert";

/**
 * Ported from Spiceport `Grains/RelationshipReads.cs`.
 *
 * The data-plane READ ops (ReadRelationships, BulkExportRelationships) served IN-PROCESS over the
 * storage-direct `ISnapshotScanner` seam - broad, loose-filter scans are exactly the workload that
 * seam exists for (`docs/graph-sharded-datastore.md` §3), deliberately OFF the shard-grain mesh and
 * the per-Check hot path. The write side and all other data-plane ops stay on the stateless-worker
 * `IRelationshipsGrain`; `IDatastore` remains only for revision resolution and token minting.
 *
 * The scanner's `scan` does not guarantee canonical-tuple order, so each read materializes its
 * matches once and sorts before yielding - the deterministic order the client cursor depends on.
 * This is no longer grain code, so the streaming ops take the caller's plain `AbortSignal`
 * directly, with no grain-method plumbing.
 *
 * Port decisions:
 *   * Both C# methods are `async IAsyncEnumerable<T>` ITERATORS, so their argument guard and entry
 *     cancellation check run at the first MoveNext, not at the call. `async *` generators preserve
 *     that exactly - do not hoist the guards into a non-generator wrapper.
 *   * `string.CompareOrdinal` is UTF-16 code-unit ordering, which in TypeScript is bare `<`/`>` on
 *     strings and a bare `a < b ? -1 : a > b ? 1 : 0` comparator. NEVER `localeCompare`: it
 *     reorders case and accents, and both the skip boundary and the sort are WIRE-VISIBLE through
 *     the client cursor.
 *   * `[EnumeratorCancellation]` / `.WithCancellation(token)` map to nothing beyond passing the
 *     signal to the producer and checking it in the loop body.
 */
export class RelationshipReads {
  readonly #datastore: IDatastore;
  readonly #schemaProvider: ISchemaProvider;
  readonly #scanner: ISnapshotScanner;

  /** Creates the reads over the datastore (revisions/tokens), the schema provider and the scanner. */
  constructor(datastore: IDatastore, schemaProvider: ISchemaProvider, scanner: ISnapshotScanner) {
    this.#datastore = datastore;
    this.#schemaProvider = schemaProvider;
    this.#scanner = scanner;
  }

  /**
   * Streams relationships matching the filter, in ascending canonical-tuple order, over one
   * revision resolved once at the start. Each item carries the canonical tuple as its resume cursor
   * (resumption skips tuples at or before it) and the per-message read-at token. The caller applies
   * any client limit by stopping enumeration.
   */
  async *readRelationships(
    args: ReadRelationshipsArgs,
    signal?: AbortSignal | undefined,
  ): AsyncGenerator<RelationshipStreamItem> {
    // `ArgumentNullException.ThrowIfNull(args);`
    if (args === undefined || args === null) throw new InvalidArgumentError("args is required");
    signal?.throwIfAborted();

    // Resolve the revision ONCE (no paging): absent consistency (the default) is MinimizeLatency ->
    // the optimized revision. The read-at token is minted from the revision actually evaluated.
    const requirement = consistencyWireToRequirement(args.consistency ?? MINIMIZE_LATENCY_WIRE);
    const resolved = await resolveRevision(
      this.#datastore,
      requirement,
      "treatAsFullConsistency",
      signal,
    );
    const filter = toFilter(args.filter);
    const after = args.cursor;
    // Unlike `ReverseOpsSupport.pinRevision`, which passes the resolved hash through UNCHANGED,
    // this path falls back to the AMBIENT current hash.
    const token = await this.#mintToken(
      resolved.revision,
      resolved.schemaHash ?? this.#schemaProvider.current.schemaHash,
    );

    const matched = await this.#collect(filter, resolved.revision, after, signal);

    for (const [tuple, rel] of matched) {
      signal?.throwIfAborted();
      yield { relationship: toWire(rel), resumeCursor: tuple, readAtToken: token };
    }
  }

  /**
   * Streams a bulk export over a single pinned snapshot: with no cursor this resolves and pins a
   * revision from the request consistency; with a cursor it reads the exact revision the cursor
   * encodes. Each item's resume cursor carries that pinned revision plus the last tuple, so a
   * reconnect reads the same snapshot and never sees writes committed after the export began. The
   * caller applies any client limit/batching by how it consumes the stream.
   */
  async *bulkExportRelationships(
    args: BulkExportRelationshipsArgs,
    signal?: AbortSignal | undefined,
  ): AsyncGenerator<RelationshipStreamItem> {
    if (args === undefined || args === null) throw new InvalidArgumentError("args is required");
    signal?.throwIfAborted();

    let pinned: IRevision;
    let after: string | undefined;
    // The decode runs FIRST and, when it succeeds, `args.consistency` is ignored entirely - that is
    // what makes a reconnect read the same snapshot. An absent/empty cursor decodes to `undefined`
    // (the C#'s `false`) and falls through to a fresh revision with no `after`; a MALFORMED cursor
    // throws `FormatError` out of here rather than silently restarting the export.
    const decoded = tryDecodeBulkExportCursor(args.cursor);
    if (decoded !== undefined) {
      pinned = decoded.revision;
      after = decoded.afterTuple;
    } else {
      const requirement = consistencyWireToRequirement(args.consistency ?? MINIMIZE_LATENCY_WIRE);
      const resolved = await resolveRevision(
        this.#datastore,
        requirement,
        "treatAsFullConsistency",
        signal,
      );
      pinned = resolved.revision;
      after = undefined;
    }

    const filter = toFilter(args.filter);

    const matched = await this.#collect(filter, pinned, after, signal);

    for (const [tuple, rel] of matched) {
      signal?.throwIfAborted();
      // No token on this path: the C# uses the two-argument `RelationshipStreamItem`, leaving the
      // read-at token at its default. `MintToken` is never called here.
      yield { relationship: toWire(rel), resumeCursor: encodeBulkExportCursor(pinned, tuple) };
    }
  }

  /**
   * Materializes the scan's matches, skipping rows at or before the cursor WHILE STREAMING, then
   * orders deterministically by canonical tuple string so the stream (and any client resume from a
   * per-item cursor) is stable.
   *
   * The C# writes these ~10 lines out twice, once per method, byte for byte. One private helper
   * here keeps them provably identical; the order of operations inside is unchanged.
   */
  async #collect(
    filter: RelationshipsFilter,
    revision: IRevision,
    after: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<[string, Relationship][]> {
    const matched: [string, Relationship][] = [];
    for await (const rel of this.#scanner.scan(filter, revision, signal)) {
      const tuple = formatRelationship(rel);
      // `if (after is { } a && string.CompareOrdinal(tuple, a) <= 0) continue;` - a PRESENCE check,
      // not `IsNullOrEmpty`, so an empty cursor is a real (and always-satisfied) cursor. `<= 0`
      // makes the resume EXCLUSIVE: the cursor's own tuple is never re-emitted.
      if (after !== undefined && tuple <= after) continue;
      matched.push([tuple, rel]);
    }

    // `matched.Sort((x, y) => string.CompareOrdinal(x.Tuple, y.Tuple));` - `matched` is a fresh
    // local, so the mutating sort is safe here; the comparator is ordinal, never `localeCompare`.
    matched.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    return matched;
  }

  async #mintToken(revision: IRevision, schemaHash: string): Promise<string> {
    // `datastore.GetUniqueId(CancellationToken.None)` - deliberately NOT the caller's token.
    const datastoreId = await this.#datastore.getUniqueId();
    return zedTokenFromRevision(revision, schemaHash, datastoreId).token;
  }
}

function toWire(rel: Relationship): RelationshipWire {
  return relationshipToWire(rel);
}

/**
 * `ToFilter`. The subject selector list is built ONLY when the subject type, the subject id list or
 * the subject relation is non-empty; otherwise it stays ABSENT, never `[]` - an empty list is a
 * different filter. The C# `{ Length: > 0 }` / `{ Count: > 0 }` patterns mean non-null AND
 * non-empty, so a proto-default empty string takes the absent branch.
 */
function toFilter(wire: RelationshipsFilterWire): RelationshipsFilter {
  let selectors: readonly SubjectsSelector[] | undefined;
  if (
    isNonEmpty(wire.subjectType) ||
    (wire.subjectIds !== undefined && wire.subjectIds.length > 0) ||
    isNonEmpty(wire.subjectRelation)
  ) {
    const sr = wire.subjectRelation;
    const relFilter: SubjectRelationFilter | undefined = isNonEmpty(sr)
      ? { nonEllipsisRelation: sr }
      : undefined;
    selectors = [
      {
        optionalSubjectType: wire.subjectType,
        optionalSubjectIds: wire.subjectIds,
        relationFilter: relFilter,
      },
    ];
  }

  return {
    optionalResourceType: wire.resourceType,
    optionalResourceIds: wire.resourceIds,
    optionalResourceIdPrefix: wire.resourceIdPrefix,
    optionalResourceRelation: wire.resourceRelation,
    optionalSubjectsSelectors: selectors,
  };
}

/** The C# `{ Length: > 0 }` pattern: present AND non-empty. */
function isNonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}
