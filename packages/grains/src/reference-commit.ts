import type { IRevision } from "@benedb/core/i-revision";
import { CreateRelationshipExistsException } from "@benedb/datastore/datastore-exceptions";
import type { ReferenceDatastore } from "@benedb/datastore/reference-datastore";

import type { CommitFailureKind, CommitReply, CommitRequest } from "./commit-contract";
import { toCoreFilter, toWriteUpdate } from "./wire-convert";

/**
 * Applies a declarative `CommitRequest` to `ReferenceDatastore` with the sequencer's semantics, in
 * the sequencer's order: preconditions against the state before the commit (mustMatch needs a
 * matching row, mustNotMatch none), then the updates, then the delete-by-filter. A rejection applies
 * nothing. Covers what the fault harness generates: preconditions, relationship updates and
 * delete-by-filter, not schema or counter changes. The request's transaction metadata is stored
 * with the revision the reference commits, as the sequencer journals it with its event.
 */
export async function applyReferenceCommit(
  reference: ReferenceDatastore,
  request: CommitRequest,
): Promise<{ readonly reply: CommitReply; readonly revision: IRevision | undefined }> {
  let deleted = 0n;
  let reachedLimit = false;
  try {
    const revision = await reference.readWriteTx(async (tx) => {
      for (const precondition of request.preconditions) {
        let matched = false;
        for await (const _ of tx.queryRelationships(toCoreFilter(precondition.filter))) {
          matched = true;
          break;
        }
        if (matched !== precondition.mustMatch) throw new Rejected("preconditionFailed");
      }

      if (request.updates.length > 0)
        await tx.writeRelationships(request.updates.map(toWriteUpdate));

      if (request.deleteByFilter !== undefined) {
        const result = await tx.deleteRelationships(
          toCoreFilter(request.deleteByFilter.filter),
          request.deleteByFilter.limit,
        );
        deleted = result.count;
        reachedLimit = result.reachedLimit;
      }
    }, request.transactionMetadata);
    return { reply: { revision: 0n, deletedCount: deleted, reachedLimit }, revision };
  } catch (error) {
    if (error instanceof Rejected) return { reply: failed(error.kind), revision: undefined };
    if (error instanceof CreateRelationshipExistsException)
      return { reply: failed("createAlreadyExists"), revision: undefined };
    throw error;
  }
}

function failed(kind: CommitFailureKind): CommitReply {
  return { failure: { kind }, deletedCount: 0n, reachedLimit: false };
}

class Rejected extends Error {
  constructor(readonly kind: CommitFailureKind) {
    super(kind);
  }
}
