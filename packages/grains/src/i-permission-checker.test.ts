import { ELLIPSIS } from "@spacedb/core/core-constants";
import {
  FULLY_CONSISTENT,
  MINIMIZE_LATENCY,
  type ConsistencyRequirement,
} from "@spacedb/core/consistency-requirement";
import type { IRevision } from "@spacedb/core/i-revision";
import type { IRevisionParser } from "@spacedb/core/i-revision-parser";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import type { ObjectAndRelation } from "@spacedb/core/object-and-relation";
import { zedTokenFromRevision } from "@spacedb/core/zed-tokens";
import type { IDatastore } from "@spacedb/datastore/i-datastore";
import { DEFAULT_MAX_DEPTH } from "@spacedb/engine/check-engine";
import { caveatExpressionFromCaveat } from "@spacedb/engine/caveat-expression";
import {
  visitKeyOf,
  visitKeyToCanonicalString,
  type DispatchCheckRequest,
  type DispatchCheckResult,
  type IDispatcher,
} from "@spacedb/engine/i-dispatcher";
import { describe, expect, it } from "vitest";

import { MutableSchemaProvider } from "./i-schema-provider";
import type { ISchemaSource } from "./i-schema-source";
import {
  DEFAULT_BATCH_CONCURRENCY,
  PermissionChecker,
  type BatchCheckItem,
} from "./i-permission-checker";
import { SchemaResolver } from "./schema-resolver";

// CHARACTERIZATION test for `src/Spiceport.Server/Grains/IPermissionChecker.cs` (five types in one
// file: PermissionCheckResult, BatchCheckItem, PermissionCheckResultItem, BatchCheckResult and
// IPermissionChecker + PermissionChecker).
//
// The C# is covered only from the mesh suites, which need the grain implementations this slice
// deliberately does not have, so this file is the whole gate. PermissionChecker itself needs NO
// grain: its dispatch seam is the ENGINE's `IDispatcher`, which a recording fake satisfies.
//
// The expectations below are read off the C# body. What a mechanical port gets wrong, and what is
// therefore pinned hardest:
//
//   * Check: `RevisionResolver.Resolve(datastore, consistency ?? MinimizeLatency)`, then the schema
//     at the RESOLVED revision (`ResolveSchema`), never the ambient current; then a ResolverMeta
//     with an EMPTY visited set; then dispatch; then collapse; then mint the token.
//   * BatchCheck: ONE revision, ONE schema snapshot, ONE engine and ONE ResolverMeta OBJECT for the
//     whole batch; dedup by a 6-tuple ValueTuple with VALUE equality (caveat context deliberately
//     EXCLUDED); `SemaphoreSlim(Math.Max(1, maxConcurrency))` bounded fan-out; results assembled BY
//     INDEX so request order survives dispatch order.
//   * Two DIFFERENT exceptions for two different nulls: a null item is an ArgumentException with
//     the message "Batch item must not be null.", a null `it.Subject` an ArgumentNullException. The
//     port has one `InvalidArgumentError` for both (see `invalid-argument-error.ts`), so the two are
//     told apart by their message.

/**
 * The AMBIENT schema the provider holds. It has NO caveats, so an engine built from it cannot
 * evaluate `over_age`: any test that collapses a caveated branch successfully proves the engine was
 * built from the RESOLVED schema below, not from this one.
 */
const AMBIENT_SCHEMA = `
definition user {}

definition document {
  relation viewer: user
  permission view = viewer
}
`;

/** The schema persisted at the resolved revision, reached only through the ISchemaSource seam. */
const RESOLVED_SCHEMA = `
caveat over_age(age int, min_age int) {
  age >= min_age
}

definition user {}

definition document {
  relation viewer: user with over_age
  permission view = viewer
}
`;

const RESOLVED_HASH = "resolved-schema-hash";
const DATASTORE_ID = "datastore-unique-id";

const ALICE: ObjectAndRelation = { objectType: "user", objectId: "alice", relation: ELLIPSIS };
const BOB: ObjectAndRelation = { objectType: "user", objectId: "bob", relation: ELLIPSIS };

/** A revision whose only interesting behaviour is its string form (what reaches the token). */
function stubRevision(text: string): IRevision {
  return {
    byteSortable: false,
    toString: () => text,
    compareTo: (other) => (other === undefined ? 1 : 0),
    equals: (other) => other !== undefined && other.toString() === text,
    greaterThan: () => false,
  } as IRevision;
}

const OPTIMIZED = stubRevision("optimized-revision");
const HEAD = stubRevision("head-revision");

interface Harness {
  readonly datastore: IDatastore;
  readonly schemaSource: ISchemaSource;
  readonly schemaProvider: MutableSchemaProvider;
  readonly schemaResolver: SchemaResolver;
  /** Every observable side effect, in the order it happened. */
  readonly calls: string[];
  /** Every revision the schema source was asked to read at. */
  readonly schemaReads: IRevision[];
}

// A DEFAULT PARAMETER would be wrong here: `harness(undefined)` - the seed-only-window case,
// where the revision pins NO schema hash - binds the default, not the absent hash, so the harness
// would silently keep returning RESOLVED_HASH and the fallback case would never be exercised. The
// rest tuple distinguishes "no argument" from "the argument `undefined`".
function harness(...overrides: readonly [optimizedHash?: string | undefined]): Harness {
  const optimizedHash = overrides.length === 0 ? RESOLVED_HASH : overrides[0];
  const calls: string[] = [];
  const schemaReads: IRevision[] = [];

  const parser: IRevisionParser = {
    datastoreUniqueId: DATASTORE_ID,
    parseRevisionString: (value) => stubRevision(value),
  };

  const datastore = {
    getRevisionParser: async () => {
      calls.push("getRevisionParser");
      return parser;
    },
    optimizedRevision: async () => {
      calls.push("optimizedRevision");
      return { revision: OPTIMIZED, schemaHash: optimizedHash };
    },
    headRevision: async () => {
      calls.push("headRevision");
      return { revision: HEAD, schemaHash: optimizedHash };
    },
    getUniqueId: async () => {
      calls.push("getUniqueId");
      return DATASTORE_ID;
    },
  };

  const schemaSource: ISchemaSource = {
    readSchemaAt: async (revision) => {
      calls.push("readSchemaAt");
      schemaReads.push(revision);
      return new TextEncoder().encode(RESOLVED_SCHEMA);
    },
  };

  return {
    datastore: datastore as unknown as IDatastore,
    schemaSource,
    schemaProvider: new MutableSchemaProvider(AMBIENT_SCHEMA),
    schemaResolver: new SchemaResolver(),
    calls,
    schemaReads,
  };
}

interface RecordingDispatcher extends IDispatcher {
  readonly requests: DispatchCheckRequest[];
  readonly signals: (AbortSignal | undefined)[];
}

/** An `IDispatcher` that records every sub-problem and answers it from `reply`. */
function recordingDispatcher(
  reply: (
    request: DispatchCheckRequest,
  ) => Promise<DispatchCheckResult> | DispatchCheckResult = () => MEMBER,
  calls?: string[],
): RecordingDispatcher {
  const requests: DispatchCheckRequest[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  return {
    requests,
    signals,
    dispatchCheck: async (request, signal) => {
      calls?.push("dispatchCheck");
      requests.push(request);
      signals.push(signal);
      return reply(request);
    },
  };
}

const MEMBER: DispatchCheckResult = {
  member: true,
  caveat: undefined,
  cycleCut: false,
  depthRequired: 1,
};
const NOT_MEMBER: DispatchCheckResult = {
  member: false,
  caveat: undefined,
  cycleCut: false,
  depthRequired: 1,
};

/** A branch gated on `over_age`, which only the RESOLVED schema defines. */
const CAVEATED: DispatchCheckResult = {
  member: true,
  caveat: caveatExpressionFromCaveat({
    caveatName: "over_age",
    context: new Map<string, unknown>([["min_age", 18]]),
  }),
  cycleCut: false,
  depthRequired: 1,
};

function checker(
  h: Harness,
  root: IDispatcher,
  maxDepth?: number,
  maxConcurrency?: number,
): PermissionChecker {
  return new PermissionChecker(
    h.datastore,
    h.schemaSource,
    root,
    h.schemaProvider,
    h.schemaResolver,
    maxDepth,
    maxConcurrency,
  );
}

function item(
  resourceType: string,
  resourceId: string,
  permission: string,
  subject: ObjectAndRelation,
  caveatContext?: ReadonlyMap<string, unknown> | undefined,
): BatchCheckItem {
  return { resourceType, resourceId, permission, subject, caveatContext };
}

describe("PermissionChecker.DefaultBatchConcurrency", () => {
  it("is 50, mirroring SpiceDB's bulk-check maxConcurrency", () => {
    // C#: `public const int DefaultBatchConcurrency = 50;` (internal/services/v1/bulkcheck.go).
    expect(DEFAULT_BATCH_CONCURRENCY).toBe(50);
  });
});

describe("PermissionChecker.check revision pinning", () => {
  it("defaults a null consistency to MinimizeLatency, so the OPTIMIZED revision is pinned", async () => {
    // C#: `consistency ?? ConsistencyRequirement.MinimizeLatency`.
    const h = harness();
    const root = recordingDispatcher();

    const result = await checker(h, root).check("document", "readme", "view", ALICE, undefined);

    expect(h.calls).toContain("optimizedRevision");
    expect(h.calls).not.toContain("headRevision");
    expect(result.evaluatedRevision).toBe(OPTIMIZED);
  });

  it("passes an EXPLICIT consistency straight through to the resolver", async () => {
    const h = harness();
    const root = recordingDispatcher();

    const result = await checker(h, root).check(
      "document",
      "readme",
      "view",
      ALICE,
      undefined,
      FULLY_CONSISTENT,
    );

    expect(h.calls).toContain("headRevision");
    expect(result.evaluatedRevision).toBe(HEAD);
  });

  it("treats an explicit MinimizeLatency exactly as the default", async () => {
    const h = harness();
    const root = recordingDispatcher();

    const result = await checker(h, root).check(
      "document",
      "readme",
      "view",
      ALICE,
      undefined,
      MINIMIZE_LATENCY satisfies ConsistencyRequirement,
    );

    expect(result.evaluatedRevision).toBe(OPTIMIZED);
  });

  it("reports the resolved schema hash on the result", async () => {
    const h = harness();

    const result = await checker(h, recordingDispatcher()).check(
      "document",
      "readme",
      "view",
      ALICE,
      undefined,
    );

    expect(result.schemaHash).toBe(RESOLVED_HASH);
  });
});

describe("PermissionChecker.check schema resolution", () => {
  it("resolves the schema at the RESOLVED revision, never the ambient current", async () => {
    // C# `ResolveSchema(resolved, ct)` passes `resolved.Revision`, and the remark is explicit that
    // the ambient current can lag on a non-writer silo.
    const h = harness();

    await checker(h, recordingDispatcher()).check("document", "readme", "view", ALICE, undefined);

    expect(h.schemaReads).toEqual([OPTIMIZED]);
  });

  it("builds the collapse engine from the RESOLVED schema, so its caveats are the ones evaluated", async () => {
    // The ambient schema defines no caveats at all: a successful `over_age` collapse can only come
    // from the schema resolved at the pinned revision.
    const h = harness();
    const root = recordingDispatcher(() => CAVEATED);

    const result = await checker(h, root).check(
      "document",
      "readme",
      "view",
      ALICE,
      new Map<string, unknown>([["age", 21]]),
    );

    expect(result.verdict).toBe("member");
  });

  it("falls back to the ambient snapshot when the revision pins no schema hash", async () => {
    // `SchemaResolver.resolveWithSource` returns the fallback - `schemaProvider.current` - and never
    // touches the source when the hash is absent (the seed-only window).
    const h = harness(undefined);

    const result = await checker(h, recordingDispatcher()).check(
      "document",
      "readme",
      "view",
      ALICE,
      undefined,
    );

    expect(h.calls).not.toContain("readSchemaAt");
    expect(result.schemaHash).toBeUndefined();
  });
});

describe("PermissionChecker.check dispatch", () => {
  it("dispatches the resource ONR built from (resourceType, resourceId, permission)", async () => {
    // C#: `new ObjectAndRelation(resourceType, resourceId, permission)` - the PERMISSION lands in
    // the relation slot.
    const h = harness();
    const root = recordingDispatcher();

    await checker(h, root).check("document", "readme", "view", ALICE, undefined);

    expect(root.requests).toHaveLength(1);
    expect(root.requests[0]?.resource).toEqual({
      objectType: "document",
      objectId: "readme",
      relation: "view",
    });
    expect(root.requests[0]?.subject).toBe(ALICE);
  });

  it("starts the root dispatch with an EMPTY visited set", async () => {
    // Seeding the root's own key would force-cut the very first hop.
    const h = harness();
    const root = recordingDispatcher();

    await checker(h, root).check("document", "readme", "view", ALICE, undefined);

    expect(root.requests[0]?.meta.visited.size).toBe(0);
  });

  it("carries the resolved revision and schema hash in the meta", async () => {
    const h = harness();
    const root = recordingDispatcher();

    await checker(h, root).check("document", "readme", "view", ALICE, undefined);

    expect(root.requests[0]?.meta.revision).toBe(OPTIMIZED);
    expect(root.requests[0]?.meta.schemaHash).toBe(RESOLVED_HASH);
  });

  it("offers the full depth budget - maxDepth, defaulting to CheckEngine's DefaultMaxDepth", async () => {
    const h = harness();
    const root = recordingDispatcher();

    await checker(h, root).check("document", "readme", "view", ALICE, undefined);

    expect(root.requests[0]?.meta.depthRemaining).toBe(DEFAULT_MAX_DEPTH);
  });

  it("honours an explicit maxDepth as the initial budget", async () => {
    const h = harness();
    const root = recordingDispatcher();

    await checker(h, root, 7).check("document", "readme", "view", ALICE, undefined);

    expect(root.requests[0]?.meta.depthRemaining).toBe(7);
  });

  it("passes the caller's cancellation signal across the dispatch seam", async () => {
    const h = harness();
    const root = recordingDispatcher();
    const signal = new AbortController().signal;

    await checker(h, root).check("document", "readme", "view", ALICE, undefined, undefined, signal);

    expect(root.signals[0]).toBe(signal);
  });
});

describe("PermissionChecker.check collapse", () => {
  it("collapses a definite member to `member` with no missing fields", async () => {
    const h = harness();

    const result = await checker(
      h,
      recordingDispatcher(() => MEMBER),
    ).check("document", "readme", "view", ALICE, undefined);

    expect(result.verdict).toBe("member");
    expect(result.missingFields).toEqual([]);
  });

  it("collapses a non-member to `notMember`", async () => {
    const h = harness();

    const result = await checker(
      h,
      recordingDispatcher(() => NOT_MEMBER),
    ).check("document", "readme", "view", ALICE, undefined);

    expect(result.verdict).toBe("notMember");
    expect(result.missingFields).toEqual([]);
  });

  it("collapses a caveated branch against the REQUEST-time context", async () => {
    const h = harness();

    const result = await checker(
      h,
      recordingDispatcher(() => CAVEATED),
    ).check("document", "readme", "view", ALICE, new Map<string, unknown>([["age", 12]]));

    expect(result.verdict).toBe("notMember");
  });

  it("reports the unresolved caveat parameters when the context is incomplete", async () => {
    const h = harness();

    const result = await checker(
      h,
      recordingDispatcher(() => CAVEATED),
    ).check("document", "readme", "view", ALICE, undefined);

    expect(result.verdict).toBe("caveated");
    expect(result.missingFields).toEqual(["age"]);
  });
});

describe("PermissionChecker.check token", () => {
  it("mints the token from the resolved revision, schema hash and datastore id", async () => {
    // C#: `ZedTokens.FromRevision(resolved.Revision, resolved.SchemaHash, datastoreId).Token`.
    const h = harness();

    const result = await checker(h, recordingDispatcher()).check(
      "document",
      "readme",
      "view",
      ALICE,
      undefined,
    );

    expect(result.evaluatedToken).toBe(
      zedTokenFromRevision(OPTIMIZED, RESOLVED_HASH, DATASTORE_ID).token,
    );
  });

  it("mints the token AFTER the dispatch completes, not before", async () => {
    // The datastore id is fetched only once the branch is in hand: a check that faults never mints.
    const h = harness();
    const root = recordingDispatcher(() => MEMBER, h.calls);

    await checker(h, root).check("document", "readme", "view", ALICE, undefined);

    expect(h.calls.indexOf("dispatchCheck")).toBeLessThan(h.calls.indexOf("getUniqueId"));
  });

  it("does not mint a token when the dispatch faults", async () => {
    const h = harness();
    const root = recordingDispatcher(() => {
      throw new Error("dispatch exploded");
    });

    await expect(
      checker(h, root).check("document", "readme", "view", ALICE, undefined),
    ).rejects.toThrow("dispatch exploded");
    expect(h.calls).not.toContain("getUniqueId");
  });
});

describe("PermissionChecker.check guards", () => {
  it("rejects a missing subject before doing anything else", async () => {
    // C#: `ArgumentNullException.ThrowIfNull(subject)` is the FIRST statement, ahead of the
    // revision resolution.
    const h = harness();
    const root = recordingDispatcher();

    await expect(
      checker(h, root).check(
        "document",
        "readme",
        "view",
        undefined as unknown as ObjectAndRelation,
        undefined,
      ),
    ).rejects.toThrow(InvalidArgumentError);
    expect(h.calls).toEqual([]);
    expect(root.requests).toEqual([]);
  });
});

describe("PermissionChecker.batchCheck one-revision pin", () => {
  it("resolves ONE revision for the whole batch and shares its token", async () => {
    const h = harness();
    const root = recordingDispatcher();

    const result = await checker(h, root).batchCheck([
      item("document", "a", "view", ALICE),
      item("document", "b", "view", BOB),
    ]);

    expect(h.calls.filter((c) => c === "optimizedRevision")).toHaveLength(1);
    expect(result.evaluatedRevision).toBe(OPTIMIZED);
    expect(result.schemaHash).toBe(RESOLVED_HASH);
    expect(result.evaluatedToken).toBe(
      zedTokenFromRevision(OPTIMIZED, RESOLVED_HASH, DATASTORE_ID).token,
    );
  });

  it("resolves ONE schema snapshot for the whole batch", async () => {
    const h = harness();
    const root = recordingDispatcher();

    await checker(h, root).batchCheck([
      item("document", "a", "view", ALICE),
      item("document", "b", "view", BOB),
    ]);

    expect(h.schemaReads).toEqual([OPTIMIZED]);
  });

  it("gives every item's request the SAME ResolverMeta object", async () => {
    // C# builds one `meta` and reuses it, which is what makes structurally identical sub-problems
    // across items collide on one grain key.
    const h = harness();
    const root = recordingDispatcher();

    await checker(h, root).batchCheck([
      item("document", "a", "view", ALICE),
      item("document", "b", "view", BOB),
    ]);

    expect(root.requests).toHaveLength(2);
    expect(root.requests[1]?.meta).toBe(root.requests[0]?.meta);
    expect(root.requests[0]?.meta.visited.size).toBe(0);
  });

  it("defaults a null consistency to MinimizeLatency, as Check does", async () => {
    const h = harness();

    await checker(h, recordingDispatcher()).batchCheck([item("document", "a", "view", ALICE)]);

    expect(h.calls).toContain("optimizedRevision");
    expect(h.calls).not.toContain("headRevision");
  });

  it("passes an explicit consistency through", async () => {
    const h = harness();

    const result = await checker(h, recordingDispatcher()).batchCheck(
      [item("document", "a", "view", ALICE)],
      FULLY_CONSISTENT,
    );

    expect(result.evaluatedRevision).toBe(HEAD);
  });

  // C#: `await gate.WaitAsync(ct)` (IPermissionChecker.cs, BatchCheck). SemaphoreSlim observes the
  // token WHILE QUEUED, so a batch aborted mid-flight faults its queued lambdas at the gate and
  // never dispatches them. Letting them through instead leaves the caller's verdict unchanged -
  // each would reject at the dispatcher's own entry guard - but it changes the dispatch COUNT,
  // which the mesh metrics suites assert. Three sub-problems, a width of one: the first occupies
  // the permit and aborts, and the other two must never reach the dispatcher.
  it("observes the signal while queued at the concurrency gate, as SemaphoreSlim does", async () => {
    const h = harness();
    const controller = new AbortController();
    let dispatched = 0;
    let releaseFirst: (() => void) | undefined;
    const firstInFlight = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const root = recordingDispatcher(async () => {
      dispatched += 1;
      releaseFirst?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return MEMBER;
    });

    const batch = checker(h, root, undefined, 1).batchCheck(
      [
        item("document", "a", "view", ALICE),
        item("document", "b", "view", ALICE),
        item("document", "c", "view", ALICE),
      ],
      undefined,
      controller.signal,
    );

    await firstInFlight;
    controller.abort();

    await expect(batch).rejects.toThrow();
    expect(dispatched).toBe(1);
  });
});

describe("PermissionChecker.batchCheck dedup", () => {
  it("dispatches ONE sub-problem for two identical items and answers both", async () => {
    const h = harness();
    const root = recordingDispatcher();

    const result = await checker(h, root).batchCheck([
      item("document", "a", "view", ALICE),
      item("document", "a", "view", ALICE),
    ]);

    expect(root.requests).toHaveLength(1);
    expect(result.items).toHaveLength(2);
    expect(result.items.map((r) => r.verdict)).toEqual(["member", "member"]);
  });

  it("EXCLUDES the caveat context from the dedup key and collapses each item against its own", async () => {
    // The C# tuple carries only the six identity fields; the context is applied per item at
    // collapse, so one shared branch can collapse differently per item.
    const h = harness();
    const root = recordingDispatcher(() => CAVEATED);

    const result = await checker(h, root).batchCheck([
      item("document", "a", "view", ALICE, new Map<string, unknown>([["age", 21]])),
      item("document", "a", "view", ALICE, new Map<string, unknown>([["age", 12]])),
      item("document", "a", "view", ALICE),
    ]);

    expect(root.requests).toHaveLength(1);
    expect(result.items.map((r) => r.verdict)).toEqual(["member", "notMember", "caveated"]);
    expect(result.items[2]?.missingFields).toEqual(["age"]);
  });

  it("treats a differing subject relation as a distinct sub-problem", async () => {
    // The tuple's last three components are Subject.ObjectType/ObjectId/Relation.
    const h = harness();
    const root = recordingDispatcher();

    await checker(h, root).batchCheck([
      item("document", "a", "view", ALICE),
      item("document", "a", "view", { ...ALICE, relation: "member" }),
    ]);

    expect(root.requests).toHaveLength(2);
  });

  it("does not conflate items whose fields differ only in where a separator falls", async () => {
    // A naive separator JOIN of the six components collides here; the C# ValueTuple never does.
    // Hence the length-prefixed canonicalisation VisitKey already uses.
    const h = harness();
    const root = recordingDispatcher();
    const unit = String.fromCharCode(0x1f);

    await checker(h, root).batchCheck([
      item("document", `a:b`, "view", ALICE),
      item("document:a", "b", "view", ALICE),
      item("document", `a${unit}b`, "view", ALICE),
      item(`document${unit}a`, "b", "view", ALICE),
    ]);

    expect(root.requests).toHaveLength(4);
  });

  it("dispatches distinct sub-problems in FIRST-OCCURRENCE order", async () => {
    // C# `Dictionary` is pure-add here, so `distinct.Values.ToList()` is insertion order; a TS Map
    // agrees. Dispatch order is therefore the order each key was first seen.
    const h = harness();
    const root = recordingDispatcher();

    await checker(h, root).batchCheck([
      item("document", "b", "view", ALICE),
      item("document", "a", "view", ALICE),
      item("document", "b", "view", ALICE),
    ]);

    expect(root.requests.map((r) => r.resource.objectId)).toEqual(["b", "a"]);
  });

  it("builds each dispatched request from the FIRST item that requested it", async () => {
    // C#: `var sample = items[indices[0]]`.
    const h = harness();
    const root = recordingDispatcher();

    await checker(h, root).batchCheck([
      item("document", "a", "view", ALICE),
      item("document", "a", "view", { ...ALICE }),
    ]);

    expect(root.requests).toHaveLength(1);
    expect(root.requests[0]?.subject).toBe(ALICE);
  });
});

describe("PermissionChecker.batchCheck result assembly", () => {
  it("returns items in REQUEST order regardless of dispatch completion order", async () => {
    // The results array is written BY INDEX, so a dispatcher that answers out of order cannot
    // reorder the reply.
    const h = harness();
    const root = recordingDispatcher(async (request) => {
      // The second item's dispatch resolves first.
      if (request.resource.objectId === "first") {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return MEMBER;
      }
      return NOT_MEMBER;
    });

    const result = await checker(h, root).batchCheck([
      item("document", "first", "view", ALICE),
      item("document", "second", "view", ALICE),
    ]);

    expect(result.items.map((r) => r.verdict)).toEqual(["member", "notMember"]);
  });

  it("maps a shared branch back to EVERY index that requested it", async () => {
    const h = harness();
    const root = recordingDispatcher((request) =>
      request.resource.objectId === "a" ? MEMBER : NOT_MEMBER,
    );

    const result = await checker(h, root).batchCheck([
      item("document", "a", "view", ALICE),
      item("document", "b", "view", ALICE),
      item("document", "a", "view", ALICE),
    ]);

    expect(result.items.map((r) => r.verdict)).toEqual(["member", "notMember", "member"]);
  });

  it("returns an empty item list for an empty batch, and dispatches nothing", async () => {
    // `Task.WhenAll` over an empty sequence completes immediately; the revision and token are still
    // resolved and minted.
    const h = harness();
    const root = recordingDispatcher();

    const result = await checker(h, root).batchCheck([]);

    expect(result.items).toEqual([]);
    expect(root.requests).toEqual([]);
    expect(result.evaluatedToken).toBe(
      zedTokenFromRevision(OPTIMIZED, RESOLVED_HASH, DATASTORE_ID).token,
    );
  });

  it("mints the batch token after every dispatch has completed", async () => {
    const h = harness();
    const root = recordingDispatcher(() => MEMBER, h.calls);

    await checker(h, root).batchCheck([
      item("document", "a", "view", ALICE),
      item("document", "b", "view", ALICE),
    ]);

    expect(h.calls.lastIndexOf("dispatchCheck")).toBeLessThan(h.calls.indexOf("getUniqueId"));
  });
});

describe("PermissionChecker.batchCheck bounded fan-out", () => {
  /** A dispatcher that never completes until released, tracking concurrent in-flight calls. */
  function gatedDispatcher(): {
    readonly dispatcher: RecordingDispatcher;
    readonly release: () => void;
    peak: () => number;
    inFlight: () => number;
  } {
    let inFlight = 0;
    let peak = 0;
    const waiters: (() => void)[] = [];
    const dispatcher = recordingDispatcher(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => waiters.push(resolve));
      inFlight -= 1;
      return MEMBER;
    });
    return {
      dispatcher,
      release: () => {
        while (waiters.length > 0) waiters.shift()?.();
      },
      peak: () => peak,
      inFlight: () => inFlight,
    };
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  }

  it("never runs more than maxConcurrency dispatches at once", async () => {
    // `SemaphoreSlim(Math.Max(1, maxConcurrency))`. A bare Promise.all would start all five.
    const h = harness();
    const gate = gatedDispatcher();
    const items = ["a", "b", "c", "d", "e"].map((id) => item("document", id, "view", ALICE));

    const pending = checker(h, gate.dispatcher, undefined, 2).batchCheck(items);
    await settle();

    expect(gate.inFlight()).toBe(2);

    gate.release();
    await settle();
    gate.release();
    await settle();
    gate.release();
    await pending;

    expect(gate.peak()).toBe(2);
    expect(gate.dispatcher.requests).toHaveLength(5);
  });

  it("clamps a zero maxConcurrency to ONE, never to unlimited", async () => {
    // `Math.Max(1, maxConcurrency)`: zero would be an invalid semaphore count, not a licence to
    // fan out without bound.
    const h = harness();
    const gate = gatedDispatcher();
    const items = ["a", "b", "c"].map((id) => item("document", id, "view", ALICE));

    const pending = checker(h, gate.dispatcher, undefined, 0).batchCheck(items);
    await settle();

    expect(gate.inFlight()).toBe(1);

    gate.release();
    await settle();
    gate.release();
    await settle();
    gate.release();
    await pending;

    expect(gate.peak()).toBe(1);
  });

  it("clamps a negative maxConcurrency to ONE too", async () => {
    const h = harness();
    const gate = gatedDispatcher();
    const items = ["a", "b"].map((id) => item("document", id, "view", ALICE));

    const pending = checker(h, gate.dispatcher, undefined, -5).batchCheck(items);
    await settle();

    expect(gate.inFlight()).toBe(1);

    gate.release();
    await settle();
    gate.release();
    await pending;

    expect(gate.peak()).toBe(1);
  });
});

describe("PermissionChecker.batchCheck guards", () => {
  it("rejects a missing items list before resolving anything", async () => {
    const h = harness();

    await expect(
      checker(h, recordingDispatcher()).batchCheck(
        undefined as unknown as readonly BatchCheckItem[],
      ),
    ).rejects.toThrow(InvalidArgumentError);
    expect(h.calls).toEqual([]);
  });

  it("rejects a null ITEM with the C#'s ArgumentException message", async () => {
    // C#: `items[i] ?? throw new ArgumentException("Batch item must not be null.", nameof(items))`.
    const h = harness();
    const root = recordingDispatcher();

    await expect(
      checker(h, root).batchCheck([
        item("document", "a", "view", ALICE),
        undefined as unknown as BatchCheckItem,
      ]),
    ).rejects.toThrow(/Batch item must not be null\./);
    expect(root.requests).toEqual([]);
  });

  it("rejects a null item SUBJECT distinctly from a null item", async () => {
    // The C# throws two DIFFERENT exception types here; the port has one class, so the messages
    // are what tell the two apart.
    const h = harness();

    const error: unknown = await checker(h, recordingDispatcher())
      .batchCheck([item("document", "a", "view", undefined as unknown as ObjectAndRelation)])
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

    expect(error).toBeInstanceOf(InvalidArgumentError);
    expect((error as Error).message).not.toMatch(/Batch item must not be null\./);
    expect((error as Error).message).toMatch(/subject/i);
  });

  it("validates the items only AFTER the batch revision is resolved", async () => {
    // C# order: ThrowIfNull(items), Resolve(...), ResolveSchema(...), then the validating loop. A
    // port that validated first would change which side effects a malformed batch produces.
    const h = harness();

    await expect(
      checker(h, recordingDispatcher()).batchCheck([undefined as unknown as BatchCheckItem]),
    ).rejects.toThrow(InvalidArgumentError);

    expect(h.calls).toContain("optimizedRevision");
    expect(h.calls).not.toContain("getUniqueId");
  });

  it("passes the caller's cancellation signal to every dispatch", async () => {
    const h = harness();
    const root = recordingDispatcher();
    const signal = new AbortController().signal;

    await checker(h, root).batchCheck(
      [item("document", "a", "view", ALICE), item("document", "b", "view", ALICE)],
      undefined,
      signal,
    );

    expect(root.signals).toEqual([signal, signal]);
  });
});

describe("BatchCheckItem dedup key canonicalisation", () => {
  it("is the same length-prefixed rendering the visited set uses", () => {
    // Documenting the substitution: the C# 6-tuple's VALUE equality has no TypeScript counterpart,
    // and the six components ARE a (resource, subject) ONR pair - exactly VisitKey's.
    const key = visitKeyToCanonicalString(
      visitKeyOf({ objectType: "document", objectId: "a", relation: "view" }, ALICE),
    );

    expect(key).not.toContain("document:a");
    expect(key.startsWith(`8${String.fromCharCode(0x1f)}document`)).toBe(true);
  });
});
