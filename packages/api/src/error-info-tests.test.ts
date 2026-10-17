import { status } from "@grpc/grpc-js";
import { SchemaSnapshot } from "@benedb/grains/i-schema-provider";
import {
  type Relationship,
  RelationshipUpdate_Operation,
  Relationship as RelationshipMessage,
} from "@benedb/protos/authzed/api/v1/core";
import { ErrorReason } from "@benedb/protos/authzed/api/v1/error_reason";
import {
  Precondition_Operation,
  WriteRelationshipsRequest,
} from "@benedb/protos/authzed/api/v1/permission_service";
import { ErrorInfo } from "@benedb/protos/google/rpc/error_info";
import { Status } from "@benedb/protos/google/rpc/status";
import { compileSchema } from "@benedb/schema/schema-compiler";
import { describe, expect, it } from "vitest";

import { goFloat } from "./go-relationship-strings";
import {
  decodeReadRelationshipsCursor,
  encodeReadRelationshipsCursor,
} from "./read-relationships-cursor";
import { validateLimit } from "./request-ceilings";
import { validateTransactionMetadataSize, validateWriteRelationships } from "./request-limits";
import { assertErrorInfo } from "./error-info-assertions";
import { RpcError } from "./rpc-error";
import { rpcErrorWithReason, toRpcStatus } from "./rpc-errors";
import {
  checkNamespaceAndRelations,
  rejectWildcardSubject,
  toRpcStatus as pairStatus,
  wildcardSubjectError,
} from "./schema-validation";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/ErrorInfoTests.cs`.
 *
 * Pure tests (no cluster) for the `google.rpc.ErrorInfo` SpiceDB attaches to the errors it gives a
 * reason (`pkg/spiceerrors.ForReason`): domain `authzed.com`, the `ErrorReason` name, and the
 * metadata each error type's `GRPCStatus` builds, carried in the `grpc-status-details-bin` trailer.
 * Each expectation names the SpiceDB v1.49.2 error type it mirrors.
 *
 * PORT NOTES.
 *  - `RequestCeilings.ValidateTransactionMetadata` is `validateTransactionMetadataSize` in
 *    `request-limits.ts`; its byte size is BeneDB's own JSON measure.
 *  - The expiration is a `Date`, so the duplicate's expiration carries millisecond precision.
 */

function thrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected the action to throw");
}

function rel(resourceId: string, relation = "viewer"): Relationship {
  return {
    resource: { objectType: "document", objectId: resourceId },
    relation,
    subject: { object: { objectType: "user", objectId: "alice" }, optionalRelation: "" },
    optionalCaveat: undefined,
    optionalExpiresAt: undefined,
  };
}

function touch(relationship: Relationship) {
  return { operation: RelationshipUpdate_Operation.OPERATION_TOUCH, relationship };
}

const SCHEMA = `
definition user {}

definition document {
    relation viewer: user
    permission view = viewer
}`;

function snapshot(): SchemaSnapshot {
  return new SchemaSnapshot(compileSchema(SCHEMA), "h", SCHEMA, 0);
}

describe("ErrorInfoTests", () => {
  it("Reason_details_travel_in_the_status_details_trailer", () => {
    const error = rpcErrorWithReason(
      status.INVALID_ARGUMENT,
      "boom",
      ErrorReason.ERROR_REASON_INVALID_CURSOR,
      [["k", "v"]],
    );

    const trailer = error.metadata.get("grpc-status-details-bin")[0];
    expect(trailer).toBeInstanceOf(Buffer);
    const rpcStatus = Status.decode(trailer as Buffer);
    expect(rpcStatus.code).toBe(status.INVALID_ARGUMENT);
    expect(rpcStatus.message).toBe("boom");
    expect(rpcStatus.details).toHaveLength(1);
    expect(rpcStatus.details[0]?.typeUrl).toBe("type.googleapis.com/google.rpc.ErrorInfo");
    const info = ErrorInfo.decode(rpcStatus.details[0]?.value ?? new Uint8Array());
    expect(info.reason).toBe("ERROR_REASON_INVALID_CURSOR");
    expect(info.domain).toBe("authzed.com");
    expect(info.metadata).toEqual({ k: "v" });
  });

  it("A_status_without_details_converts_to_a_bare_rpc_status", () => {
    const rpcStatus = toRpcStatus(new RpcError(status.NOT_FOUND, "gone"));
    expect(rpcStatus).toEqual({ code: status.NOT_FOUND, message: "gone", details: [] });
  });

  // ExceedsMaximumLimitError
  it("An_over_limit_page_size_exceeds_the_maximum_allowable_limit", () => {
    assertErrorInfo(
      thrown(() => validateLimit(5000, 1000)),
      status.INVALID_ARGUMENT,
      "ERROR_REASON_EXCEEDS_MAXIMUM_ALLOWABLE_LIMIT",
      ["limit_provided", "5000"],
      ["maximum_limit_allowed", "1000"],
    );
  });

  // TransactionMetadataTooLargeError
  it("Oversized_transaction_metadata_is_too_large", () => {
    const metadata = { k: "x".repeat(65_000) };
    const size = new TextEncoder().encode(JSON.stringify(metadata)).length;
    assertErrorInfo(
      thrown(() => validateTransactionMetadataSize(metadata)),
      status.INVALID_ARGUMENT,
      "ERROR_REASON_TRANSACTION_METADATA_TOO_LARGE",
      ["metadata_byte_size", String(size)],
      ["maximum_allowed_metadata_byte_size", "65000"],
    );
  });

  // ExceedsMaximumUpdatesError
  it("Too_many_updates_in_a_write", () => {
    const request = WriteRelationshipsRequest.fromPartial({
      updates: Array.from({ length: 1001 }, (_, i) => touch(rel(`doc${i}`))),
    });
    assertErrorInfo(
      thrown(() => validateWriteRelationships(request)),
      status.INVALID_ARGUMENT,
      "ERROR_REASON_TOO_MANY_UPDATES_IN_REQUEST",
      ["update_count", "1001"],
      ["maximum_updates_allowed", "1000"],
    );
  });

  // ExceedsMaximumPreconditionsError (its metadata reuses the key maximum_updates_allowed)
  it("Too_many_preconditions_in_a_write", () => {
    const request = WriteRelationshipsRequest.fromPartial({
      optionalPreconditions: Array.from({ length: 1001 }, () => ({
        operation: Precondition_Operation.OPERATION_MUST_MATCH,
        filter: { resourceType: "document" },
      })),
    });
    assertErrorInfo(
      thrown(() => validateWriteRelationships(request)),
      status.INVALID_ARGUMENT,
      "ERROR_REASON_TOO_MANY_PRECONDITIONS_IN_REQUEST",
      ["precondition_count", "1001"],
      ["maximum_updates_allowed", "1000"],
    );
  });

  // DuplicateRelationErrorshipError: the relationship is MustV1StringRelationship, caveat and
  // expiration included.
  it("A_relationship_updated_twice_is_updates_on_same_relationship", () => {
    const caveated: Relationship = {
      ...rel("doc1"),
      optionalCaveat: { caveatName: "only_on_tuesday", context: { day: "tuesday", count: 2 } },
      optionalExpiresAt: new Date(Date.UTC(2030, 0, 2, 3, 4, 5, 500)),
    };
    const request = WriteRelationshipsRequest.fromPartial({
      updates: [touch(rel("doc1")), touch(caveated)],
    });
    assertErrorInfo(
      thrown(() => validateWriteRelationships(request)),
      status.INVALID_ARGUMENT,
      "ERROR_REASON_UPDATES_ON_SAME_RELATIONSHIP",
      ["definition_name", "document"],
      [
        "relationship",
        'document:doc1#viewer@user:alice[only_on_tuesday:{"count":2,"day":"tuesday"}][expiration:2030-01-02T03:04:05.5Z]',
      ],
    );
  });

  // ErrMaxRelationshipContextError: context_size is proto.Size of the whole relationship.
  it("An_oversized_relationship_caveat_context_exceeds_the_maximum", () => {
    const relationship: Relationship = {
      ...rel("doc1"),
      optionalCaveat: { caveatName: "c", context: { k: "x".repeat(25_000) } },
    };
    const request = WriteRelationshipsRequest.fromPartial({ updates: [touch(relationship)] });
    assertErrorInfo(
      thrown(() => validateWriteRelationships(request)),
      status.INVALID_ARGUMENT,
      "ERROR_REASON_MAX_RELATIONSHIP_CONTEXT_SIZE",
      ["relationship", "document:doc1#viewer@user:alice"],
      ["max_allowed_size", "25000"],
      ["context_size", String(RelationshipMessage.encode(relationship).finish().length)],
    );
  });

  // NamespaceNotFoundError through rewriteError
  it("An_unknown_definition_is_unknown_definition", () => {
    assertErrorInfo(
      thrown(() =>
        checkNamespaceAndRelations(snapshot(), {
          definitionName: "folder",
          relationName: "view",
          allowEllipsis: false,
        }),
      ),
      status.FAILED_PRECONDITION,
      "ERROR_REASON_UNKNOWN_DEFINITION",
      ["definition_name", "folder"],
    );
  });

  // RelationNotFoundError through rewriteError
  it("An_unknown_relation_is_unknown_relation_or_permission", () => {
    assertErrorInfo(
      thrown(() =>
        checkNamespaceAndRelations(snapshot(), {
          definitionName: "document",
          relationName: "edit",
          allowEllipsis: false,
        }),
      ),
      status.FAILED_PRECONDITION,
      "ERROR_REASON_UNKNOWN_RELATION_OR_PERMISSION",
      ["definition_name", "document"],
      ["relation_or_permission_name", "edit"],
    );
  });

  // WildcardNotAllowedError from checkInternal
  it("Checking_a_wildcard_subject_is_wildcard_not_allowed", () => {
    assertErrorInfo(
      thrown(() => rejectWildcardSubject("*")),
      status.INVALID_ARGUMENT,
      "ERROR_REASON_WILDCARD_NOT_ALLOWED",
      ["field", "subject.object_id"],
    );
  });

  // A bulk-check pair's error is status.Convert(err).Proto(): its details come along.
  it("A_bulk_check_pair_error_keeps_its_details", () => {
    const error = wildcardSubjectError("*");
    expect(error).toBeDefined();
    const rpcStatus = pairStatus(error as RpcError);
    expect(rpcStatus.code).toBe(status.INVALID_ARGUMENT);
    expect(rpcStatus.details).toHaveLength(1);
    const info = ErrorInfo.decode(rpcStatus.details[0]?.value ?? new Uint8Array());
    expect(info.reason).toBe("ERROR_REASON_WILDCARD_NOT_ALLOWED");
  });

  // pkg/cursor InvalidCursorError (no metadata), for an undecodable cursor and one minted for
  // another call
  it("An_undecodable_or_foreign_cursor_is_an_invalid_cursor", () => {
    assertErrorInfo(
      thrown(() => decodeReadRelationshipsCursor({ token: "%%%" }, "hash")),
      status.INVALID_ARGUMENT,
      "ERROR_REASON_INVALID_CURSOR",
    );
    const foreign = encodeReadRelationshipsCursor("other", "document:doc1#viewer@user:alice");
    assertErrorInfo(
      thrown(() => decodeReadRelationshipsCursor({ token: foreign }, "hash")),
      status.INVALID_ARGUMENT,
      "ERROR_REASON_INVALID_CURSOR",
    );
  });

  // v1 InvalidCursorError: NewInvalidCursorErr never sets the reason field, so its metadata
  // carries an empty "reason".
  it("An_unparseable_resume_relationship_is_an_invalid_cursor_with_an_empty_reason", () => {
    const cursor = encodeReadRelationshipsCursor("hash", "not a tuple");
    assertErrorInfo(
      thrown(() => decodeReadRelationshipsCursor({ token: cursor }, "hash")),
      status.FAILED_PRECONDITION,
      "ERROR_REASON_INVALID_CURSOR",
      ["reason", ""],
    );
  });

  /** Go protojson's rendering of each number (from protobuf-go v1.36.10's encoder). */
  it.each([
    [2, "2"],
    [0.5, "0.5"],
    [1e21, "1e+21"],
    [1.5e21, "1.5e+21"],
    [1e-7, "1e-7"],
    [1.25e-7, "1.25e-7"],
    [123456789012, "123456789012"],
    [1e20, "100000000000000000000"],
    [0.000001, "0.000001"],
    [-3.75, "-3.75"],
    [1e300, "1e+300"],
    [5e-324, "5e-324"],
    [0.1, "0.1"],
  ])("Caveat_context_numbers_render_as_go_protojson_does(%s)", (value, expected) => {
    expect(goFloat(value)).toBe(expected);
  });
});
