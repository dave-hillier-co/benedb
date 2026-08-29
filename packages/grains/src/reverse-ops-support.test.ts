import { PUBLIC_WILDCARD } from "@spacedb/core/core-constants";
import type { IRevision } from "@spacedb/core/i-revision";
import type { IRevisionParser } from "@spacedb/core/i-revision-parser";
import { InvalidArgumentError } from "@spacedb/core/invalid-argument-error";
import { TimestampRevision } from "@spacedb/core/timestamp-revision";
import { zedTokenFromRevision } from "@spacedb/core/zed-tokens";
import type {
  IDatastore,
  IDatastoreReader,
  RevisionWithSchemaHash,
} from "@spacedb/datastore/i-datastore";
import { CaveatEvaluator } from "@spacedb/engine/caveat-evaluator";
import { caveatExpressionFromCaveat } from "@spacedb/engine/caveat-expression";
import { DEFAULT_MAX_DEPTH } from "@spacedb/engine/check-engine";
import { computeSchemaHash } from "@spacedb/engine/schema-hash";
import { compileSchema } from "@spacedb/schema/schema-compiler";
import type { GrainInterface } from "@thresh/core/grain-interface";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  MembershipClosureReply,
  MembershipWalkArgs,
  ResourceNodeWire,
} from "./i-membership-walk-grain";
import { IMembershipWalkGrain } from "./i-membership-walk-grain";
import { SchemaSnapshot } from "./i-schema-provider";
import { membershipWalkKeyBuild } from "./membership-walk-key";
import type { MembershipWalkOptions } from "./membership-walk-options";
import { PERMISSIONSHIP_MEMBER } from "./reverse-ops-dtos";
import { acquireCoveredCandidates, pinRevision, tryCollapse } from "./reverse-ops-support";

/**
 * No covering C# test that can RUN yet: every Spiceport consumer of `Grains/ReverseOpsSupport.cs`
 * reaches it through a `MeshTestCluster` and the grain implementations behind that cluster are a
 * later slice. This is a CHARACTERIZATION derived line by line from the C#.
 *
 * What this file exists to protect, and why each is load-bearing:
 *
 *   1. `PinRevision`'s ORDER OF OPERATIONS. Resolve, then `GetUniqueId`, then mint the token - and
 *      `DateTimeOffset.UtcNow` is evaluated LAST, inside the return expression, so "now" is after
 *      BOTH awaits. Capturing it earlier hands the engines a stale expiration cutoff.
 *   2. `PinRevision` mints from `resolved.SchemaHash` UNCHANGED, nullable and all - deliberately
 *      unlike `RelationshipReads.MintToken`, which falls back to the ambient provider hash.
 *   3. `AcquireCoveredCandidates`'s DECLINE ORDER, all four arms. Every `null` means "run the live
 *      traversal", so a wrong arm order changes how many grain calls a lookup makes - which the
 *      mesh metrics tests assert - and an incorrectly SHORT candidate set is a silent false
 *      negative Check confirmation can never catch.
 *   4. The TWO root walks are awaited SEQUENTIALLY (concrete, THEN wildcard). `Promise.all` would
 *      be observably different in mesh grain-call ordering.
 *   5. `TryCollapse`'s three arms, including the one where the out-param is set to Member on a
 *      FALSE return - callers must key off the boolean, never the permissionship. The port makes
 *      that unmistakable with a discriminated result, but the arms are unchanged.
 */

const SCHEMA_TEXT = `
caveat has_flag(flag bool) {
  flag == true
}

definition user {}

definition group {
  relation member: user
}

definition document {
  relation viewer: user | group#member with has_flag
  permission view = viewer
}
`;

const REVISION = new TimestampRevision(1_700_000_000_000_000_000n);
const DATASTORE_ID = "ds-unique-id";

function snapshot(): SchemaSnapshot {
  const compiled = compileSchema(SCHEMA_TEXT);
  return new SchemaSnapshot(
    compiled,
    computeSchemaHash(compiled.namespaces, compiled.caveats),
    SCHEMA_TEXT,
    0,
  );
}

// --- PinRevision ------------------------------------------------------------------------------

interface FakeDatastore {
  readonly datastore: IDatastore;
  readonly calls: string[];
}

function fakeDatastore(
  options: {
    readonly optimized?: RevisionWithSchemaHash;
    readonly head?: RevisionWithSchemaHash;
    /** Runs inside `getUniqueId`, the second await - the seam for moving the clock. */
    readonly onGetUniqueId?: () => void;
  } = {},
): FakeDatastore {
  const calls: string[] = [];
  const optimized = options.optimized ?? { revision: REVISION, schemaHash: undefined };
  const head = options.head ?? { revision: REVISION, schemaHash: "head-hash" };
  const datastore = {
    snapshotReader(): IDatastoreReader {
      throw new Error("not used");
    },
    headRevision(): Promise<RevisionWithSchemaHash> {
      calls.push("headRevision");
      return Promise.resolve(head);
    },
    optimizedRevision(): Promise<RevisionWithSchemaHash> {
      calls.push("optimizedRevision");
      return Promise.resolve(optimized);
    },
    readWriteTx(): Promise<IRevision> {
      throw new Error("not used");
    },
    checkRevision(): Promise<boolean> {
      return Promise.resolve(true);
    },
    watch(): AsyncIterable<never> {
      throw new Error("not used");
    },
    getUniqueId(): Promise<string> {
      calls.push("getUniqueId");
      options.onGetUniqueId?.();
      return Promise.resolve(DATASTORE_ID);
    },
    getRevisionParser(): Promise<IRevisionParser> {
      calls.push("getRevisionParser");
      return Promise.resolve({
        datastoreUniqueId: DATASTORE_ID,
        parse: (value: string) => new TimestampRevision(BigInt(value)),
      } as unknown as IRevisionParser);
    },
    close(): Promise<void> {
      return Promise.resolve();
    },
  };
  return { datastore: datastore as unknown as IDatastore, calls };
}

describe("pinRevision", () => {
  it("defaults ABSENT consistency to minimize-latency (the optimized revision)", async () => {
    // `(consistency ?? ConsistencyWire.MinimizeLatency).ToRequirement()`.
    const store = fakeDatastore();
    const pinned = await pinRevision(store.datastore, undefined, undefined);

    expect(store.calls).toContain("optimizedRevision");
    expect(store.calls).not.toContain("headRevision");
    expect(pinned.revision).toBe(REVISION);
  });

  it("honours an explicit fully-consistent requirement", async () => {
    const store = fakeDatastore();
    const pinned = await pinRevision(store.datastore, { mode: "fullyConsistent" }, undefined);

    expect(store.calls).toContain("headRevision");
    expect(pinned.schemaHash).toBe("head-hash");
  });

  it("resolves the revision BEFORE asking for the datastore id", async () => {
    // The two awaits are ordered in the C#: `RevisionResolver.Resolve(...)` then
    // `datastore.GetUniqueId(...)`, and the token cannot be minted before both.
    const store = fakeDatastore();
    await pinRevision(store.datastore, undefined, undefined);

    expect(store.calls.indexOf("optimizedRevision")).toBeLessThan(
      store.calls.indexOf("getUniqueId"),
    );
  });

  it("mints the token from the RESOLVED schema hash, unchanged", async () => {
    const store = fakeDatastore({ optimized: { revision: REVISION, schemaHash: "pinned-hash" } });
    const pinned = await pinRevision(store.datastore, undefined, undefined);

    expect(pinned.token).toBe(zedTokenFromRevision(REVISION, "pinned-hash", DATASTORE_ID).token);
    expect(pinned.schemaHash).toBe("pinned-hash");
  });

  it("passes an ABSENT resolved schema hash straight through - NO ambient fallback", async () => {
    // `ZedTokens.FromRevision(resolved.Revision, resolved.SchemaHash, datastoreId)`. Contrast
    // `RelationshipReads.ReadRelationships`, which writes `resolved.SchemaHash ?? ambient`. The
    // asymmetry is deliberate and is what `ReverseOps.MemoizedFrontier` later compensates for.
    const store = fakeDatastore({ optimized: { revision: REVISION, schemaHash: undefined } });
    const pinned = await pinRevision(store.datastore, undefined, undefined);

    expect(pinned.schemaHash).toBeUndefined();
    expect(pinned.token).toBe(zedTokenFromRevision(REVISION, undefined, DATASTORE_ID).token);
  });

  describe('the evaluation "now"', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("is captured AFTER both awaits, not before them", async () => {
      // `return (DateTimeOffset.UtcNow, token, ...)` - the tuple is built after `GetUniqueId`
      // completes, so a clock that moves during the resolve is observed at its LATER value.
      vi.setSystemTime(new Date(1_000));
      const store = fakeDatastore({
        onGetUniqueId: () => {
          vi.setSystemTime(new Date(5_000));
        },
      });

      const pinned = await pinRevision(store.datastore, undefined, undefined);

      // The engine "now" is epoch NANOSECONDS in this port (see `engine/src/clock.ts`).
      expect(pinned.now).toBe(5_000_000_000n);
    });
  });
});

// --- AcquireCoveredCandidates -----------------------------------------------------------------

/** One recorded `IMembershipWalkGrain.getContainingSet` call. */
interface WalkCall {
  readonly key: string;
  readonly args: MembershipWalkArgs;
  /** Resolution order, so "sequential, not Promise.all" is assertable. */
  readonly started: number;
}

interface FakeMesh {
  readonly seam: { getGrain<T>(definition: GrainInterface<T>, key: never): T };
  readonly calls: WalkCall[];
  /** True when a second walk began before the first one's reply resolved. */
  readonly overlapped: { value: boolean };
}

function mesh(replies: Readonly<Record<string, MembershipClosureReply>>): FakeMesh {
  const calls: WalkCall[] = [];
  const overlapped = { value: false };
  let inFlight = 0;
  let seq = 0;
  return {
    seam: {
      getGrain<T>(_definition: GrainInterface<T>, key: never): T {
        const grainKey = key as unknown as string;
        const grain = {
          async getContainingSet(args: MembershipWalkArgs): Promise<MembershipClosureReply> {
            calls.push({ key: grainKey, args, started: seq++ });
            inFlight += 1;
            if (inFlight > 1) overlapped.value = true;
            // A real await, so an overlapping caller would be visible.
            await Promise.resolve();
            inFlight -= 1;
            return replies[grainKey] ?? { nodes: [], cycleCut: false, incomplete: false };
          },
        };
        return grain as unknown as T;
      },
    },
    calls,
    overlapped,
  };
}

function node(type: string, id: string, relation: string): ResourceNodeWire {
  return { type, id, relation };
}

function reply(nodes: readonly ResourceNodeWire[], incomplete = false): MembershipClosureReply {
  return { nodes, cycleCut: false, incomplete };
}

const ENABLED: MembershipWalkOptions = { enabled: true };
const DISABLED: MembershipWalkOptions = { enabled: false };

function keyFor(schema: SchemaSnapshot, subjectId: string): string {
  return membershipWalkKeyBuild("user", subjectId, "...", REVISION.toString(), schema.schemaHash);
}

async function acquire(
  m: FakeMesh,
  schema: SchemaSnapshot,
  overrides: {
    readonly options?: MembershipWalkOptions;
    readonly subjectId?: string;
    readonly resourceType?: string;
    readonly permission?: string;
    readonly hasCursorOrLimit?: boolean;
  } = {},
): Promise<readonly string[] | undefined> {
  return acquireCoveredCandidates(
    m.seam,
    overrides.options ?? ENABLED,
    schema,
    "user",
    overrides.subjectId ?? "alice",
    "...",
    overrides.resourceType ?? "document",
    overrides.permission ?? "view",
    REVISION,
    overrides.hasCursorOrLimit ?? false,
    undefined,
  );
}

describe("acquireCoveredCandidates decline order", () => {
  it("declines - and dispatches NOTHING - when the accelerator is disabled", async () => {
    // Arm 1: `if (!options.Enabled || hasCursorOrLimit) return null;`
    const schema = snapshot();
    const m = mesh({});
    expect(await acquire(m, schema, { options: DISABLED })).toBeUndefined();
    expect(m.calls).toHaveLength(0);
  });

  it("is ON by default when `enabled` is not configured", async () => {
    // `resolveMemoGrainOptions` applies `?? true`; the C# member defaults to true.
    const schema = snapshot();
    const m = mesh({});
    expect(await acquire(m, schema, { options: {} })).toEqual([]);
    expect(m.calls).toHaveLength(2);
  });

  it("declines when the request is paged or resumed", async () => {
    // Arm 1, second condition. The caller derives `hasCursorOrLimit`; this helper only obeys it.
    const schema = snapshot();
    const m = mesh({});
    expect(await acquire(m, schema, { hasCursorOrLimit: true })).toBeUndefined();
    expect(m.calls).toHaveLength(0);
  });

  it("declines for a WILDCARD subject, before any walk is dispatched", async () => {
    // Arm 2: `if (subjectId == CoreConstants.PublicWildcard) return null;` - and it sits ABOVE the
    // coverage lookup and the walks, so a covered shape still dispatches nothing.
    const schema = snapshot();
    const m = mesh({});
    expect(await acquire(m, schema, { subjectId: PUBLIC_WILDCARD })).toBeUndefined();
    expect(m.calls).toHaveLength(0);
  });

  it("declines an UNCOVERED shape, before any walk is dispatched", async () => {
    // Arm 3: `if (!coverage.TryGetYields(resourceType, permission, out var yieldRelations)) return null;`
    const schema = snapshot();
    const m = mesh({});
    expect(await acquire(m, schema, { resourceType: "nosuchtype" })).toBeUndefined();
    expect(await acquire(m, schema, { permission: "nosuchpermission" })).toBeUndefined();
    expect(m.calls).toHaveLength(0);
  });

  it("declines when EITHER walk reports an incomplete result - after running both", async () => {
    // Arm 4: `if (concreteReply.Incomplete || wildcardReply.Incomplete) return null;` - it is
    // checked only after BOTH awaits, so both grain calls have already happened. Never return a
    // silently short candidate set.
    const schema = snapshot();
    const concreteIncomplete = mesh({
      [keyFor(schema, "alice")]: reply([node("document", "doc1", "viewer")], true),
    });
    expect(await acquire(concreteIncomplete, schema)).toBeUndefined();
    expect(concreteIncomplete.calls).toHaveLength(2);

    const wildcardIncomplete = mesh({
      [keyFor(schema, "alice")]: reply([node("document", "doc1", "viewer")]),
      [keyFor(schema, PUBLIC_WILDCARD)]: reply([], true),
    });
    expect(await acquire(wildcardIncomplete, schema)).toBeUndefined();
    expect(wildcardIncomplete.calls).toHaveLength(2);
  });
});

describe("acquireCoveredCandidates dispatch", () => {
  it("dispatches TWO root walks: the concrete key and the same-type wildcard key", async () => {
    // `WalkRoot(..., subjectId, ...)` then `WalkRoot(..., CoreConstants.PublicWildcard, ...)`,
    // sharing the subject TYPE and RELATION, so a `type:*#rel` userset edge is followed too.
    const schema = snapshot();
    const m = mesh({});
    await acquire(m, schema);

    expect(m.calls.map((c) => c.key)).toEqual([
      keyFor(schema, "alice"),
      keyFor(schema, PUBLIC_WILDCARD),
    ]);
  });

  it("awaits the two walks SEQUENTIALLY, never concurrently", async () => {
    // Two separate `await`s in the C#, not a `Task.WhenAll`. Observable in mesh call ordering.
    const schema = snapshot();
    const m = mesh({});
    await acquire(m, schema);

    expect(m.overlapped.value).toBe(false);
  });

  it("keys the walk grains on the EXACT revision string and the snapshot's schema hash", async () => {
    // `MembershipWalkKey.Build(subjectType, subjectId, subjectRelation, revision.ToString()!, schema.SchemaHash)`
    // - the snapshot's own hash, never the ambient provider's.
    const schema = snapshot();
    const m = mesh({});
    await acquire(m, schema);

    expect(m.calls[0]?.key).toBe(
      membershipWalkKeyBuild("user", "alice", "...", REVISION.toString(), schema.schemaHash),
    );
  });

  it("sends an EMPTY path and the ENGINE's default max depth, not the caller's budget", async () => {
    // `new MembershipWalkArgs(Path: [], DepthRemaining: CheckEngine.DefaultMaxDepth)`.
    const schema = snapshot();
    const m = mesh({});
    await acquire(m, schema);

    for (const call of m.calls) {
      expect(call.args.path).toEqual([]);
      expect(call.args.depthRemaining).toBe(DEFAULT_MAX_DEPTH);
    }
  });
});

describe("acquireCoveredCandidates result", () => {
  it("unions both walks' nodes and filters them to the coverage yields", async () => {
    // `concreteReply.Nodes.Concat(wildcardReply.Nodes)` -> `MembershipWalk.ToCoveredCandidates`,
    // which keeps only nodes whose (type, relation) matches a yield relation. `document#view`
    // flattens to the base relation `viewer`, so a `document#editor` node is discarded.
    const schema = snapshot();
    const m = mesh({
      [keyFor(schema, "alice")]: reply([
        node("document", "doc2", "viewer"),
        node("document", "ignored", "editor"),
        node("folder", "f1", "viewer"),
      ]),
      [keyFor(schema, PUBLIC_WILDCARD)]: reply([node("document", "doc1", "viewer")]),
    });

    // Sorted and distinct, with ORDINAL ordering (`ToCoveredCandidates` uses a bare sort).
    expect(await acquire(m, schema)).toEqual(["doc1", "doc2"]);
  });

  it("de-duplicates an id reached by BOTH walks", async () => {
    const schema = snapshot();
    const m = mesh({
      [keyFor(schema, "alice")]: reply([node("document", "doc1", "viewer")]),
      [keyFor(schema, PUBLIC_WILDCARD)]: reply([node("document", "doc1", "viewer")]),
    });
    expect(await acquire(m, schema)).toEqual(["doc1"]);
  });

  it("returns an EMPTY list - not null - when both walks find nothing", async () => {
    // Empty is a COMPLETE answer ("no candidates"); null means "run the live traversal". Merging
    // the two would make an empty covered set silently unlimited.
    const schema = snapshot();
    const m = mesh({});
    expect(await acquire(m, schema)).toEqual([]);
  });

  it("adds the reflexive self-membership candidate when subject and resource types match", async () => {
    // `ToCoveredCandidates`'s unconditional `if (subjectType == resourceType) found.Add(subjectId)`.
    const schema = snapshot();
    const m = mesh({});
    const result = await acquireCoveredCandidates(
      m.seam,
      ENABLED,
      schema,
      "group",
      "eng",
      "member",
      "group",
      "member",
      REVISION,
      false,
      undefined,
    );
    expect(result).toEqual(["eng"]);
  });
});

describe("acquireCoveredCandidates guards", () => {
  it("rejects an absent grain factory, options or schema", async () => {
    // Three `ArgumentNullException.ThrowIfNull` calls, ahead of every decline arm.
    const schema = snapshot();
    const m = mesh({});
    await expect(
      acquireCoveredCandidates(
        undefined as unknown as FakeMesh["seam"],
        ENABLED,
        schema,
        "user",
        "alice",
        "...",
        "document",
        "view",
        REVISION,
        false,
        undefined,
      ),
    ).rejects.toThrow(InvalidArgumentError);

    await expect(
      acquireCoveredCandidates(
        m.seam,
        undefined as unknown as MembershipWalkOptions,
        schema,
        "user",
        "alice",
        "...",
        "document",
        "view",
        REVISION,
        false,
        undefined,
      ),
    ).rejects.toThrow(InvalidArgumentError);

    await expect(
      acquireCoveredCandidates(
        m.seam,
        ENABLED,
        undefined as unknown as SchemaSnapshot,
        "user",
        "alice",
        "...",
        "document",
        "view",
        REVISION,
        false,
        undefined,
      ),
    ).rejects.toThrow(InvalidArgumentError);
  });

  it("asks the mesh for IMembershipWalkGrain specifically", async () => {
    const schema = snapshot();
    const definitions: unknown[] = [];
    const seam = {
      getGrain<T>(definition: GrainInterface<T>, _key: never): T {
        definitions.push(definition);
        return {
          getContainingSet: () => Promise.resolve(reply([])),
        } as unknown as T;
      },
    };
    await acquireCoveredCandidates(
      seam,
      ENABLED,
      schema,
      "user",
      "alice",
      "...",
      "document",
      "view",
      REVISION,
      false,
      undefined,
    );
    expect(definitions).toEqual([IMembershipWalkGrain, IMembershipWalkGrain]);
  });
});

// --- TryCollapse ------------------------------------------------------------------------------

describe("tryCollapse", () => {
  const evaluator = new CaveatEvaluator(snapshot().caveats);
  const caveat = caveatExpressionFromCaveat({ caveatName: "has_flag", context: undefined });

  it("includes an UNCAVEATED subject as an unconditional member without evaluating", () => {
    // `if (caveat is null) { permissionship = Permissionship.Member; return true; }` - the
    // evaluator is not consulted at all.
    const result = tryCollapse(undefined, undefined, evaluator);

    expect(result.included).toBe(true);
    expect(result.included && result.permissionship).toBe(PERMISSIONSHIP_MEMBER);
  });

  it("collapses a definitely-TRUE caveat to an unconditional member", () => {
    // `case CaveatOutcome.DefinitelyTrue: permissionship = Permissionship.Member; return true;`
    const result = tryCollapse(caveat, new Map([["flag", true]]), evaluator);

    expect(result.included).toBe(true);
    expect(result.included && result.permissionship.isCaveated).toBe(false);
  });

  it("collapses an unresolved caveat to a CAVEATED member carrying the missing fields", () => {
    // `case CaveatOutcome.Caveated: permissionship = Permissionship.Caveated(result.MissingFields);`
    const result = tryCollapse(caveat, undefined, evaluator);

    expect(result.included).toBe(true);
    expect(result.included && result.permissionship.isCaveated).toBe(true);
    expect(result.included ? [...result.permissionship.missingContextParams] : []).toEqual([
      "flag",
    ]);
  });

  it("SHEARS a definitely-false caveat off entirely", () => {
    // The `default:` arm returns FALSE - and sets the out-param to Member anyway, which is why a
    // caller must key off the boolean. The port makes that unrepresentable.
    const result = tryCollapse(caveat, new Map([["flag", false]]), evaluator);

    expect(result.included).toBe(false);
  });
});
