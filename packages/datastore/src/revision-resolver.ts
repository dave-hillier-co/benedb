import type { ConsistencyRequirement } from "@benedb/core/consistency-requirement";
import type { IRevisionParser } from "@benedb/core/i-revision-parser";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import { InvalidConsistencyTokenException } from "@benedb/core/invalid-consistency-token-exception";
import type { ResolvedRevision } from "@benedb/core/resolved-revision";
import type { ZedToken } from "@benedb/core/zed-token";
import { decodeRevision } from "@benedb/core/zed-tokens";

import type { IDatastore } from "./i-datastore";

/**
 * How to treat a token that references a different datastore instance, mirroring SpiceDB's
 * `MismatchingTokenOption`.
 *
 * The C# enum has explicit values (0/1/2), but it is NOT wire-visible - it is a policy knob local
 * to the resolver - so it becomes a plain string-literal union with no bidirectional wire map.
 *
 * - `treatAsFullConsistency` - fall back to full consistency (head). SpiceDB's default for
 *   at-least-as-fresh.
 * - `treatAsMinLatency` - fall back to minimize-latency (optimized).
 * - `treatAsError` - raise an error.
 */
export type MismatchingTokenOption =
  "treatAsFullConsistency" | "treatAsMinLatency" | "treatAsError";

/**
 * Resolves the revision (and schema hash + cache mode) the request should be evaluated at against
 * a datastore. Mirrors SpiceDB's `addRevisionToContextFromConsistency` + `pickBestRevision`.
 *
 * The C# `RevisionResolver` is a `static class` used as a namespace, so it becomes module-level
 * free functions; `Resolve` alone would be ambiguous at a call site, so the type name folds in.
 *
 * @throws InvalidConsistencyTokenException The token is malformed, references a different
 * datastore where that is an error, or the exact-snapshot revision is no longer available.
 */
export async function resolveRevision(
  datastore: IDatastore,
  requirement: ConsistencyRequirement,
  mismatchOption: MismatchingTokenOption = "treatAsFullConsistency",
  signal?: AbortSignal | undefined,
): Promise<ResolvedRevision> {
  if (datastore === undefined || datastore === null) {
    throw new InvalidArgumentError("datastore must not be null");
  }
  if (requirement === undefined || requirement === null) {
    throw new InvalidArgumentError("requirement must not be null");
  }

  const parser = await datastore.getRevisionParser(signal);

  switch (requirement.kind) {
    case "minimizeLatency": {
      const opt = await datastore.optimizedRevision(signal);
      return { revision: opt.revision, schemaHash: opt.schemaHash, mode: "optimized" };
    }

    case "fullyConsistent": {
      const head = await datastore.headRevision(signal);
      return { revision: head.revision, schemaHash: head.schemaHash, mode: "exact" };
    }

    case "atLeastAsFresh":
      return await resolveAtLeastAsFresh(
        datastore,
        parser,
        requirement.token,
        mismatchOption,
        signal,
      );

    case "atExactSnapshot":
      return await resolveAtExactSnapshot(datastore, parser, requirement.token, signal);

    default:
      return assertNever(requirement);
  }
}

async function resolveAtLeastAsFresh(
  datastore: IDatastore,
  parser: IRevisionParser,
  token: ZedToken,
  mismatchOption: MismatchingTokenOption,
  signal: AbortSignal | undefined,
): Promise<ResolvedRevision> {
  const opt = await datastore.optimizedRevision(signal);
  const decoded = decodeRevision(token, parser);

  // The C# `switch (decoded.Status)` has NO cases for Valid or LegacyEmptyDatastoreId, so both
  // deliberately fall through to the code after the switch. This if-chain keeps both on that path.
  if (decoded.status === "unknown") {
    throw new InvalidConsistencyTokenException("at_least_as_fresh: malformed ZedToken");
  }

  if (decoded.status === "mismatchedDatastoreId") {
    switch (mismatchOption) {
      case "treatAsFullConsistency": {
        const head = await datastore.headRevision(signal);
        return { revision: head.revision, schemaHash: head.schemaHash, mode: "exact" };
      }
      case "treatAsMinLatency":
        return { revision: opt.revision, schemaHash: opt.schemaHash, mode: "optimized" };
      default:
        throw new InvalidConsistencyTokenException(
          "at_least_as_fresh: ZedToken references a different datastore instance",
        );
    }
  }

  // Valid or LegacyEmptyDatastoreId: pick max(optimized, token).
  // Use the optimized (cacheable) revision only if it is STRICTLY fresher than the token. Use
  // greaterThan, not compareTo > 0: for concurrent (incomparable) snapshots greaterThan is false,
  // so we fall through to the token and preserve read-your-writes — exactly as SpiceDB's
  // pickBestRevision does. compareTo would fall back to an ordinal string tiebreak that could
  // wrongly pick the optimized revision, which may not include the token's writes.
  if (opt.revision.greaterThan(decoded.revision)) {
    return { revision: opt.revision, schemaHash: opt.schemaHash, mode: "optimized" };
  }

  // The token is at least as fresh as the optimized bucket (read-your-writes): use it exactly.
  return { revision: decoded.revision, schemaHash: decoded.schemaHash, mode: "exact" };
}

async function resolveAtExactSnapshot(
  datastore: IDatastore,
  parser: IRevisionParser,
  token: ZedToken,
  signal: AbortSignal | undefined,
): Promise<ResolvedRevision> {
  const decoded = decodeRevision(token, parser);

  if (decoded.status === "unknown") {
    throw new InvalidConsistencyTokenException("at_exact_snapshot: malformed ZedToken");
  }
  if (decoded.status === "mismatchedDatastoreId") {
    throw new InvalidConsistencyTokenException(
      "at_exact_snapshot: ZedToken references a different datastore instance",
    );
  }

  if (!(await datastore.checkRevision(decoded.revision, signal))) {
    throw new InvalidConsistencyTokenException(
      `at_exact_snapshot: revision ${decoded.revision.toString()} is no longer available`,
    );
  }

  return { revision: decoded.revision, schemaHash: decoded.schemaHash, mode: "exact" };
}

/** Exhaustiveness check carrying the C# default branch's user-visible message. */
function assertNever(requirement: never): never {
  throw new InvalidConsistencyTokenException(
    `unknown consistency requirement: ${(requirement as { kind: string }).kind}`,
  );
}
