import type { ConsistencyWire } from "./consistency-wire";

// A deliberately MULTI-EXPORT module, per the port ledger.
//
// NONE of these types is `[GenerateSerializer]`: they run IN-PROCESS between `ReverseOps` and the
// gRPC front doors and cross no grain boundary. That distinction is preserved here so a later
// slice does not accidentally send one. They stay DATA - a page is a page, never a generator -
// because being data is what lets the engine stream without an `IAsyncEnumerable` crossing a grain
// boundary.

/**
 * The collapsed membership of a found subject / resource, mirroring the gRPC `Permissionship`:
 * either an unconditional member or a caveated member with the unresolved caveat parameter names.
 *
 * Non-members are never represented - they are simply not yielded. The reverse engine ops already
 * shear caveats against the request context, so this shape carries the post-context collapsed shape
 * (a missing-fields list) rather than a verbatim caveat-expression tree.
 */
export interface Permissionship {
  /** True when membership is conditional on an unresolved caveat. */
  readonly isCaveated: boolean;
  /** The unresolved caveat parameter names; empty for an unconditional member. */
  readonly missingContextParams: readonly string[];
}

/**
 * An unconditional member. A `static ... { get; }` singleton in the C#, so a FROZEN module constant
 * rather than a factory - a factory would hand out fresh objects and break any reference match.
 */
export const PERMISSIONSHIP_MEMBER: Permissionship = Object.freeze({
  isCaveated: false,
  missingContextParams: Object.freeze([]) as readonly string[],
});

/**
 * A caveated member with the given unresolved caveat parameter names. This one IS a factory in the
 * C#, and stays one here: the asymmetry with the singleton above is transliterated, not smoothed.
 */
export function caveatedPermissionship(missing: readonly string[]): Permissionship {
  return { isCaveated: true, missingContextParams: missing };
}

// ---- ExpandPermissionTree ----

/** Whether expansion descends into non-terminal usersets. Mirrors the engine's `ExpandMode`. */
export type ExpandModeWire =
  /** Expand one level only. */
  | "shallow"
  /** Expand non-terminal usersets recursively. */
  | "recursive";

/** The set operation a tree node combines its children with. Mirrors `SetOperationType`. */
export type SetOpWire =
  /** Union (OR). */
  | "union"
  /** Intersection (AND). */
  | "intersection"
  /** Exclusion (base AND NOT excluded). */
  | "exclusion";

/** Arguments for `expandPermissionTree`. */
export interface ExpandTreeArgs {
  /** The resource namespace. */
  readonly resourceType: string;
  /** The resource object id. */
  readonly resourceId: string;
  /** The relation or permission to expand. */
  readonly permission: string;
  /** Shallow or recursive expansion. */
  readonly mode: ExpandModeWire;
  /** The consistency requirement; absent means minimize-latency (default). */
  readonly consistency?: ConsistencyWire | undefined;
}

/** The reply from `expandPermissionTree`: the whole tree root. */
export interface ExpandTreeReply {
  /** The expanded tree root. */
  readonly root: ExpandTreeNodeWire;
  /** The ZedToken for the revision actually evaluated. A C# default parameter (`= ""`). */
  readonly expandedAtToken?: string | undefined;
}

/** Resolver for the C# default parameter `string ExpandedAtToken = ""`. */
export function expandTreeReplyExpandedAtToken(reply: ExpandTreeReply): string {
  return reply.expandedAtToken ?? "";
}

/**
 * A node of an expanded permission tree, structurally mirroring the engine's `PermissionTreeNode`.
 * Exactly one of `subjects` (leaf) or `children` (set operation) is populated; `operation` applies
 * only to set-operation nodes.
 *
 * That invariant is DOCUMENTED, not typed - deliberately, because the C# is the authority on this
 * shape and the gRPC front door mirrors it field-for-field. Turning it into a discriminated union
 * would be a redesign.
 */
export interface ExpandTreeNodeWire {
  /** Object type of the resource ONR this node expands. */
  readonly expandedType: string;
  /** Object id of the resource ONR this node expands. */
  readonly expandedId: string;
  /** Relation/permission of the resource ONR this node expands. */
  readonly expandedRelation: string;
  /** Caveat params gating the whole node (non-empty = node is caveated). */
  readonly caveatMissingFields: readonly string[];
  /** True for a leaf (direct subjects); false for a set-operation node. */
  readonly isLeaf: boolean;
  /** The combining operation for a set-operation node. */
  readonly operation: SetOpWire;
  /** The directly-written subjects, for a leaf node. */
  readonly subjects: readonly ExpandSubjectWire[];
  /** The child nodes, for a set-operation node. */
  readonly children: readonly ExpandTreeNodeWire[];
}

/** A directly-written subject within an expand leaf node. */
export interface ExpandSubjectWire {
  /** The subject namespace. */
  readonly subjectType: string;
  /** The subject object id ("*" for a wildcard). */
  readonly subjectId: string;
  /** The subject relation (ellipsis for a terminal subject). */
  readonly subjectRelation: string;
  /** True when the subject is the public wildcard. */
  readonly isWildcard: boolean;
  /** Caveat params gating this subject (non-empty = subject is caveated). */
  readonly caveatMissingFields: readonly string[];
}

// ---- LookupSubjects ----

/** Arguments for `streamLookupSubjects`. `limit` is advisory. */
export interface LookupSubjectsArgs {
  /** The resource namespace. */
  readonly resourceType: string;
  /** The resource object id. */
  readonly resourceId: string;
  /** The relation or permission. */
  readonly permission: string;
  /** The requested subject namespace. */
  readonly subjectType: string;
  /** The requested subject relation (ellipsis for terminal subjects). */
  readonly subjectRelation: string;
  /** Optional request-time caveat context for collapsing caveated subjects. */
  readonly context?: ReadonlyMap<string, unknown> | undefined;
  /** Soft page size; absent or 0 for the engine default / unbounded in this slice. */
  readonly limit?: number | undefined;
  /** Opaque continuation token from a prior page; absent to start. */
  readonly cursor?: string | undefined;
  /** The consistency requirement; absent means minimize-latency (default). */
  readonly consistency?: ConsistencyWire | undefined;
}

/** A subject found by a lookup, with its collapsed permissionship. */
export interface FoundSubjectWire {
  /** The subject object id ("*" for a wildcard). */
  readonly subjectId: string;
  /** True when the subject is the public wildcard. */
  readonly isWildcard: boolean;
  /** Member or caveated (with missing context params). */
  readonly permissionship: Permissionship;
}

/**
 * One item of the `streamLookupSubjects` stream: a found subject plus the opaque resume cursor
 * positioned immediately after it. The cursor lets a client-facing limited stream resume with
 * byte-identical token semantics.
 */
export interface FoundSubjectStreamItem {
  /** The found subject with its collapsed permissionship. */
  readonly subject: FoundSubjectWire;
  /** The opaque resume cursor positioned immediately after this subject. */
  readonly resumeCursor: string;
  /** The ZedToken for the revision actually evaluated. A C# default parameter (`= ""`). */
  readonly lookedUpAtToken?: string | undefined;
}

/** Resolver for the C# default parameter `string LookedUpAtToken = ""`. */
export function foundSubjectStreamItemLookedUpAtToken(item: FoundSubjectStreamItem): string {
  return item.lookedUpAtToken ?? "";
}

// ---- LookupResources ----

/** Arguments for `streamLookupResources`. */
export interface LookupResourcesArgs {
  /** The resource namespace to enumerate. */
  readonly resourceType: string;
  /** The relation or permission. */
  readonly permission: string;
  /** The subject namespace. */
  readonly subjectType: string;
  /** The subject object id. */
  readonly subjectId: string;
  /** The subject relation (ellipsis for terminal subjects). */
  readonly subjectRelation: string;
  /** Optional request-time caveat context. */
  readonly context?: ReadonlyMap<string, unknown> | undefined;
  /** Soft page size; absent or 0 for the engine default / unbounded in this slice. */
  readonly limit?: number | undefined;
  /** Opaque continuation token from a prior page; absent to start. */
  readonly cursor?: string | undefined;
  /** The consistency requirement; absent means minimize-latency (default). */
  readonly consistency?: ConsistencyWire | undefined;
}

/**
 * A resource found by a lookup, with its collapsed permissionship.
 *
 * This shape doubles as its own stream item for `streamLookupResources`: it already carries the
 * per-item resume cursor, so no wrapper is needed. The asymmetry with `FoundSubjectStreamItem` is
 * the C#'s and is kept.
 */
export interface FoundResourceWire {
  /** The reachable resource object id. */
  readonly resourceId: string;
  /** Member or caveated (with missing context params). */
  readonly permissionship: Permissionship;
  /**
   * The opaque resume cursor positioned immediately after this resource, so a client can resume the
   * stream right after it (mirrors v1 `after_result_cursor`). ABSENT when no cursor is available -
   * which is NOT the same as an empty cursor, so it is not resolved to "" the way the tokens are.
   */
  readonly afterResultCursor?: string | undefined;
  /** The ZedToken for the revision actually evaluated. A C# default parameter (`= ""`). */
  readonly lookedUpAtToken?: string | undefined;
}

/** Resolver for the C# default parameter `string LookedUpAtToken = ""`. */
export function foundResourceWireLookedUpAtToken(found: FoundResourceWire): string {
  return found.lookedUpAtToken ?? "";
}
