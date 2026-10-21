import { Metadata, status } from "@grpc/grpc-js";
import { describe, expect, it } from "vitest";
import { AuthzedWatchV1Service } from "@benedb/api/authzed-watch-v1-service";
import { CollectingStreamWriter } from "@benedb/api/collecting-stream-writer";
import { RpcError } from "@benedb/api/rpc-error";
import { MeshTestCluster } from "@benedb/grains/mesh-test-cluster";
import type { RelationshipFilter } from "@benedb/protos/authzed/api/v1/permission_service";
import { WriteSchemaRequest } from "@benedb/protos/authzed/api/v1/schema_service";
import {
  WatchKind,
  WatchRequest,
  type WatchResponse,
} from "@benedb/protos/authzed/api/v1/watch_service";
import { ErrorInfo } from "@benedb/protos/google/rpc/error_info";
import { Status } from "@benedb/protos/google/rpc/status";

import {
  spiceDbAvailable,
  spiceDbSkipReason,
  useSpiceDbContainer,
} from "./spice-db-container-fixture";
import { SpiceDbGrpcClient } from "./spice-db-grpc-client";
import { resetSpiceDb } from "./spice-db-reset";

/**
 * Directed differential gate for Watch request validation (spiceport#46). Each case sends the SAME
 * malformed `WatchRequest` to a real `authzed/spicedb` container and to BeneDB's in-process
 * `AuthzedWatchV1Service`, and asserts both reject it with the same gRPC status code, detail text
 * and `google.rpc.ErrorInfo`: protoc-gen-validate first, then the handler's own checks in order
 * (object types with relationship filters, the start cursor, each filter against the schema).
 *
 * BeneDB-only (Spiceport has no Watch differential). Left out: a start cursor that is base64 but
 * not a token, and one from another datastore, because the two systems' token formats differ; and
 * the resource-id-with-prefix filter, whose `ErrorInfo` quotes Go prototext, which perturbs its
 * whitespace per build.
 */

const fixture = useSpiceDbContainer();

const Schema = `definition user {}

definition document {
    relation viewer: user
    permission view = viewer
}`;

function filter(fields: Partial<RelationshipFilter>): RelationshipFilter {
  return {
    resourceType: "",
    optionalResourceId: "",
    optionalResourceIdPrefix: "",
    optionalRelation: "",
    ...fields,
  };
}

function watch(fields: Partial<WatchRequest>): WatchRequest {
  return WatchRequest.fromPartial(fields);
}

const Cases: readonly (readonly [name: string, expected: status, request: WatchRequest])[] = [
  ["object_type_pattern", status.INVALID_ARGUMENT, watch({ optionalObjectTypes: ["Doc", "x"] })],
  [
    "filter_resource_type_pattern",
    status.INVALID_ARGUMENT,
    watch({ optionalRelationshipFilters: [filter({ resourceType: "Doc" })] }),
  ],
  [
    "filter_wildcard_resource_id",
    status.INVALID_ARGUMENT,
    watch({
      optionalRelationshipFilters: [filter({ resourceType: "document", optionalResourceId: "*" })],
    }),
  ],
  [
    "empty_start_cursor_and_bad_object_type",
    status.INVALID_ARGUMENT,
    watch({ optionalObjectTypes: ["Doc"], optionalStartCursor: { token: "" } }),
  ],
  [
    "object_types_and_filters",
    status.INVALID_ARGUMENT,
    watch({
      optionalObjectTypes: ["document"],
      optionalRelationshipFilters: [filter({ resourceType: "folder" })],
      optionalStartCursor: { token: "garbage" },
    }),
  ],
  [
    "start_cursor_not_base64",
    status.INVALID_ARGUMENT,
    watch({
      optionalRelationshipFilters: [filter({ resourceType: "folder" })],
      optionalStartCursor: { token: "garbage" },
    }),
  ],
  [
    "filter_unknown_definition",
    status.FAILED_PRECONDITION,
    watch({ optionalRelationshipFilters: [filter({ resourceType: "folder" })] }),
  ],
  [
    "filter_unknown_relation_while_watching_schema_only",
    status.FAILED_PRECONDITION,
    watch({
      optionalObjectTypes: ["document"],
      optionalRelationshipFilters: [filter({ resourceType: "document", optionalRelation: "nope" })],
      optionalUpdateKinds: [WatchKind.WATCH_KIND_INCLUDE_SCHEMA_UPDATES],
    }),
  ],
  [
    "filter_wildcard_subject_with_relation",
    status.FAILED_PRECONDITION,
    watch({
      optionalRelationshipFilters: [
        filter({
          resourceType: "document",
          optionalSubjectFilter: {
            subjectType: "user",
            optionalSubjectId: "*",
            optionalRelation: { relation: "viewer" },
          },
        }),
      ],
    }),
  ],
  ["empty_filter", status.INVALID_ARGUMENT, watch({ optionalRelationshipFilters: [filter({})] })],
];

interface Outcome {
  readonly code: number;
  readonly details: string;
  /** The `google.rpc.ErrorInfo` in the status details, when the error carries one. */
  readonly errorInfo: ErrorInfo | undefined;
}

async function outcome(promise: Promise<unknown>): Promise<Outcome> {
  return promise.then(
    () => ({ code: status.OK, details: "", errorInfo: undefined }),
    (reason: unknown) => {
      const error = reason as { code?: unknown; details?: unknown; metadata?: unknown };
      return {
        code: Number(error.code),
        details: String(error.details),
        errorInfo: errorInfoIn(error.metadata),
      };
    },
  );
}

/** Decodes the `ErrorInfo` from a `grpc-status-details-bin` trailer, as a client reads it. */
function errorInfoIn(metadata: unknown): ErrorInfo | undefined {
  if (!(metadata instanceof Metadata)) return undefined;
  const trailer = metadata.get("grpc-status-details-bin")[0];
  if (!(trailer instanceof Buffer)) return undefined;
  const detail = Status.decode(trailer).details.find(
    (d) => d.typeUrl === "type.googleapis.com/google.rpc.ErrorInfo",
  );
  return detail === undefined ? undefined : ErrorInfo.decode(detail.value);
}

describe.sequential("WatchRequestValidationDifferentialTests", () => {
  for (const [name, expected, request] of Cases) {
    it(`Watch request validation agrees with SpiceDB [${name}]`, async (ctx) => {
      ctx.skip(!spiceDbAvailable, spiceDbSkipReason);

      let spiceDb: Outcome;
      const spiceDbClient = new SpiceDbGrpcClient(fixture().address, fixture().preSharedKey);
      try {
        await resetSpiceDb(spiceDbClient);
        await spiceDbClient.writeSchema(WriteSchemaRequest.fromPartial({ schema: Schema }));
        spiceDb = await outcome(spiceDbClient.watchFirst(request));
        expect(spiceDb.code).toBe(expected);
      } finally {
        spiceDbClient.close();
      }

      const cluster = await MeshTestCluster.create(Schema);
      try {
        const service = new AuthzedWatchV1Service(
          cluster.datastore,
          cluster.services.schemaProvider,
        );
        const controller = new AbortController();
        const benedbPromise = service.watch(
          request,
          new CollectingStreamWriter<WatchResponse>(),
          controller.signal,
        );
        const benedb = await outcome(benedbPromise);
        controller.abort();
        await benedbPromise.catch((error: unknown) => {
          expect(error).toBeInstanceOf(RpcError);
        });

        expect(benedb).toEqual(spiceDb);
      } finally {
        await cluster.dispose();
      }
    });
  }
});
