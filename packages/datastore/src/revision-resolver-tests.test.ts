import { describe, expect, it } from "vitest";

import {
  atExactSnapshot,
  atLeastAsFresh,
  FULLY_CONSISTENT,
  MINIMIZE_LATENCY,
} from "@spacedb/core/consistency-requirement";
import { ELLIPSIS } from "@spacedb/core/core-constants";
import type { IRevision } from "@spacedb/core/i-revision";
import { InvalidConsistencyTokenException } from "@spacedb/core/invalid-consistency-token-exception";
import { createRelationship, type Relationship } from "@spacedb/core/relationship";
import { TimestampRevision } from "@spacedb/core/timestamp-revision";
import type { ZedToken } from "@spacedb/core/zed-token";
import { decodeRevision, zedTokenFromRevision } from "@spacedb/core/zed-tokens";

import { ReferenceDatastore } from "./reference-datastore";
import { resolveRevision } from "./revision-resolver";

// Port of Spiceport `tests/Spiceport.Datastore.Tests/RevisionResolverTests.cs`. Sociable: every
// case builds a real `ReferenceDatastore` and drives the resolver against it, exactly as the C#
// does. The cases and their assertions are carried across one-for-one; only the mechanics move:
//
// 1. `RevisionResolver.Resolve` is a member of a `static class` used as a namespace, so it
//    becomes a module-level free function. `Resolve` alone would be ambiguous at a call site, so
//    the type name folds in: `resolveRevision`. There is no namespace object and no barrel.
//
// 2. `MismatchingTokenOption` is NOT wire-visible - it is a policy knob local to the resolver -
//    so despite the explicit 0/1/2 in the C# it is a plain string-literal union with no wire map.
//    `TreatAsError` is `"treatAsError"`.
//
// 3. `new ReferenceDatastore(quantization: TimeSpan.Zero)` becomes the positional
//    `new ReferenceDatastore({ ms: 0 })`, and `gcWindow: TimeSpan.FromMilliseconds(1)` becomes
//    `new ReferenceDatastore(undefined, { ms: 1 })` - the C# named arguments skip a parameter the
//    positional form has to pass through.
//
// 4. `new ZedToken("...")` is a constructor over a record in the C#; the port's `ZedToken` is a
//    plain interface, so a garbage token is the object literal `{ token: "..." }`.
//
// 5. Revisions are compared through `.equals` / `.compareTo`, never `===`: a fresh
//    `TimestampRevision` is allocated on every access, so identity is meaningless. Nanos are
//    `bigint`, so the fresher-token case adds `1_000_000n`, not `1_000_000`.
//
// 6. Every failure asserted here is core's `InvalidConsistencyTokenException` - the resolver
//    never raises a datastore exception, because these messages surface as gRPC InvalidArgument.

function rel(id: string): Relationship {
  return createRelationship(
    { objectType: "document", objectId: id, relation: "viewer" },
    { objectType: "user", objectId: "alice", relation: ELLIPSIS },
  );
}

async function write(ds: ReferenceDatastore, id: string): Promise<IRevision> {
  return await ds.readWriteTx(async (tx) => {
    await tx.writeRelationships([{ relationship: rel(id), operation: "create" }]);
  });
}

// No quantization: optimizedRevision === headRevision, so revision comparisons are exact and
// deterministic.
function newExactDatastore(): ReferenceDatastore {
  return new ReferenceDatastore({ ms: 0 });
}

async function tokenFor(ds: ReferenceDatastore, rev: IRevision): Promise<ZedToken> {
  const id = await ds.getUniqueId();
  return zedTokenFromRevision(rev, undefined, id);
}

describe("revision resolver", () => {
  describe("token round-trip", () => {
    it("decodes a minted token to the committed revision, and that revision reads as a snapshot", async () => {
      const ds = new ReferenceDatastore();
      const committed = await write(ds, "doc1");
      const token = await tokenFor(ds, committed);

      const parser = await ds.getRevisionParser();
      const decoded = decodeRevision(token, parser);

      expect(decoded.status).toBe("valid");
      expect(decoded.revision.equals(committed)).toBe(true);
      // The decoded revision must be snapshot-readable by the datastore.
      const reader = ds.snapshotReader(decoded.revision);
      expect(reader.isValid).toBe(true);
    });

    it("decodes a token from a different datastore id as mismatched", async () => {
      const ds = new ReferenceDatastore();
      const committed = await write(ds, "doc1");
      const foreign = zedTokenFromRevision(committed, undefined, "some-other-id");

      const parser = await ds.getRevisionParser();
      const decoded = decodeRevision(foreign, parser);

      expect(decoded.status).toBe("mismatchedDatastoreId");
    });
  });

  describe("minimize latency", () => {
    it("resolves to the optimized revision in optimized mode", async () => {
      const ds = newExactDatastore();
      await write(ds, "doc1");
      const opt = await ds.optimizedRevision();

      const resolved = await resolveRevision(ds, MINIMIZE_LATENCY);

      expect(resolved.mode).toBe("optimized");
      expect(resolved.revision.equals(opt.revision)).toBe(true);
    });
  });

  describe("fully consistent", () => {
    it("resolves to the head revision in exact mode", async () => {
      const ds = new ReferenceDatastore();
      const head = await write(ds, "doc1");

      const resolved = await resolveRevision(ds, FULLY_CONSISTENT);

      expect(resolved.mode).toBe("exact");
      expect(resolved.revision.equals(head)).toBe(true);
    });
  });

  // at-least-as-fresh is max(token, optimized).
  describe("at least as fresh", () => {
    it("picks the optimized revision, in optimized mode, when it is strictly fresher", async () => {
      const ds = newExactDatastore();
      // Old token captured before later writes; optimized (=== head) is strictly fresher.
      const oldRev = await write(ds, "doc1");
      const oldToken = await tokenFor(ds, oldRev);
      await write(ds, "doc2"); // advances head past the token revision
      const opt = await ds.optimizedRevision();
      expect(opt.revision.compareTo(oldRev)).toBeGreaterThan(0); // precondition

      const resolved = await resolveRevision(ds, atLeastAsFresh(oldToken));

      expect(resolved.mode).toBe("optimized");
      expect(resolved.revision.equals(opt.revision)).toBe(true);
    });

    it("picks the token, in exact mode, when the token is fresher", async () => {
      const ds = newExactDatastore();
      await write(ds, "doc1");
      const opt = await ds.optimizedRevision();
      // Mint a token strictly fresher than the current optimized/head revision (the future
      // read-your-writes case).
      const fresherRev = new TimestampRevision(
        (opt.revision as TimestampRevision).timestampNanosSinceEpoch + 1_000_000n,
      );
      const fresherToken = await tokenFor(ds, fresherRev);

      const resolved = await resolveRevision(ds, atLeastAsFresh(fresherToken));

      expect(resolved.mode).toBe("exact");
      expect(resolved.revision.equals(fresherRev)).toBe(true);
    });

    it("picks the token, in exact mode, when the revisions are equal", async () => {
      const ds = newExactDatastore();
      await write(ds, "doc1");
      const opt = await ds.optimizedRevision();
      const token = await tokenFor(ds, opt.revision);

      const resolved = await resolveRevision(ds, atLeastAsFresh(token));

      // token >= optimized -> token wins (exact). The boundary of the max.
      expect(resolved.mode).toBe("exact");
      expect(resolved.revision.equals(opt.revision)).toBe(true);
    });

    it("falls back to full consistency for a token from a different datastore", async () => {
      const ds = new ReferenceDatastore();
      const rev = await write(ds, "doc1");
      const foreign = zedTokenFromRevision(rev, undefined, "other-instance");

      const resolved = await resolveRevision(ds, atLeastAsFresh(foreign));
      const head = await ds.headRevision();

      expect(resolved.mode).toBe("exact");
      expect(resolved.revision.equals(head.revision)).toBe(true);
    });

    it("throws for a token from a different datastore when told to treat it as an error", async () => {
      const ds = new ReferenceDatastore();
      const rev = await write(ds, "doc1");
      const foreign = zedTokenFromRevision(rev, undefined, "other-instance");

      await expect(resolveRevision(ds, atLeastAsFresh(foreign), "treatAsError")).rejects.toThrow(
        InvalidConsistencyTokenException,
      );
    });

    it("throws for a malformed token", async () => {
      const ds = new ReferenceDatastore();
      await write(ds, "doc1");
      const garbage: ZedToken = { token: "!!!not-base64!!!" };

      await expect(resolveRevision(ds, atLeastAsFresh(garbage))).rejects.toThrow(
        InvalidConsistencyTokenException,
      );
    });
  });

  describe("at exact snapshot", () => {
    it("resolves to the token revision in exact mode, ignoring later writes", async () => {
      const ds = newExactDatastore();
      const rev = await write(ds, "doc1");
      const token = await tokenFor(ds, rev);
      await write(ds, "doc2"); // advances head; must not change the resolved exact snapshot

      const resolved = await resolveRevision(ds, atExactSnapshot(token));

      expect(resolved.mode).toBe("exact");
      expect(resolved.revision.equals(rev)).toBe(true);
    });

    it("throws for a token from a different datastore", async () => {
      const ds = new ReferenceDatastore();
      const rev = await write(ds, "doc1");
      const foreign = zedTokenFromRevision(rev, undefined, "other-instance");

      await expect(resolveRevision(ds, atExactSnapshot(foreign))).rejects.toThrow(
        InvalidConsistencyTokenException,
      );
    });

    it("throws for a revision outside the GC window", async () => {
      // Very tight GC window so an old revision is no longer available.
      const ds = new ReferenceDatastore(undefined, { ms: 1 });
      const staleRev = new TimestampRevision(1n); // far in the past, before the GC floor
      const token = await tokenFor(ds, staleRev);

      await expect(resolveRevision(ds, atExactSnapshot(token))).rejects.toThrow(
        InvalidConsistencyTokenException,
      );
    });

    it("throws for a malformed token", async () => {
      const ds = new ReferenceDatastore();
      await write(ds, "doc1");
      const garbage: ZedToken = { token: "###" };

      await expect(resolveRevision(ds, atExactSnapshot(garbage))).rejects.toThrow(
        InvalidConsistencyTokenException,
      );
    });
  });
});
