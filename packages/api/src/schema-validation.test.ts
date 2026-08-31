import { status } from "@grpc/grpc-js";
import { ELLIPSIS, PUBLIC_WILDCARD } from "@benedb/core/core-constants";
import type { NamespaceDefinition } from "@benedb/core/namespace-definition";
import { SchemaSnapshot } from "@benedb/grains/i-schema-provider";
import { describe, expect, it } from "vitest";

import { RpcError } from "./rpc-error";
import {
  checkNamespaceAndRelations,
  rejectWildcardSubject,
  toRpcStatus,
  tryCheckNamespaceAndRelations,
  wildcardSubjectError,
} from "./schema-validation";

/**
 * Characterization test for `src/Spiceport.Api/SchemaValidation.cs`.
 *
 * The C# has NO direct suite; it is exercised only indirectly through
 * `AuthzedPermissionsV1ServiceTests.cs`. These cases pin what a client observes: the two exact
 * messages, the FailedPrecondition-vs-InvalidArgument split, the ellipsis short-circuit, the
 * order in which pairs are validated (first failure wins, and the message differs), and the
 * throwing/non-throwing pairing the bulk-check path depends on.
 */

function namespaceOf(name: string, ...relations: readonly string[]): NamespaceDefinition {
  return { name, relations: relations.map((relationName) => ({ name: relationName })) };
}

function snapshotOf(...namespaces: readonly NamespaceDefinition[]): SchemaSnapshot {
  return new SchemaSnapshot({ namespaces, caveats: [] }, "testhash", "", 1);
}

const snapshot = snapshotOf(
  namespaceOf("user"),
  namespaceOf("group", "member"),
  namespaceOf("document", "viewer", "editor", "view"),
);

function expectRpcError(act: () => unknown): RpcError {
  try {
    act();
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(RpcError);
    return thrown as RpcError;
  }
  throw new Error("expected an RpcError to be thrown, but nothing was thrown");
}

describe("tryCheckNamespaceAndRelations", () => {
  it("returns undefined when there is nothing to check", () => {
    expect(tryCheckNamespaceAndRelations(snapshot)).toBeUndefined();
  });

  it("returns undefined for a known definition and relation", () => {
    expect(
      tryCheckNamespaceAndRelations(snapshot, {
        definitionName: "document",
        relationName: "viewer",
        allowEllipsis: false,
      }),
    ).toBeUndefined();
  });

  it("accepts a permission just as it accepts a relation", () => {
    expect(
      tryCheckNamespaceAndRelations(snapshot, {
        definitionName: "document",
        relationName: "view",
        allowEllipsis: false,
      }),
    ).toBeUndefined();
  });

  it("reports an unknown definition as FailedPrecondition with SpiceDB's message", () => {
    const error = tryCheckNamespaceAndRelations(snapshot, {
      definitionName: "nonexistent",
      relationName: "viewer",
      allowEllipsis: false,
    });

    expect(error).toBeInstanceOf(RpcError);
    expect(error?.code).toBe(status.FAILED_PRECONDITION);
    expect(error?.details).toBe("object definition `nonexistent` not found");
  });

  it("reports an unknown relation as FailedPrecondition with SpiceDB's message", () => {
    const error = tryCheckNamespaceAndRelations(snapshot, {
      definitionName: "document",
      relationName: "nonexistent",
      allowEllipsis: false,
    });

    expect(error?.code).toBe(status.FAILED_PRECONDITION);
    expect(error?.details).toBe(
      "relation/permission `nonexistent` not found under definition `document`",
    );
  });

  it("uses FailedPrecondition, not NotFound and not InvalidArgument", () => {
    const error = tryCheckNamespaceAndRelations(snapshot, {
      definitionName: "nonexistent",
      relationName: "viewer",
      allowEllipsis: false,
    });

    expect(error?.code).not.toBe(status.NOT_FOUND);
    expect(error?.code).not.toBe(status.INVALID_ARGUMENT);
  });

  it("does not throw — it returns the error", () => {
    expect(() =>
      tryCheckNamespaceAndRelations(snapshot, {
        definitionName: "nonexistent",
        relationName: "viewer",
        allowEllipsis: false,
      }),
    ).not.toThrow();
  });

  it("rejects a definition that exists but has no relations at all", () => {
    const error = tryCheckNamespaceAndRelations(snapshot, {
      definitionName: "user",
      relationName: "member",
      allowEllipsis: false,
    });

    expect(error?.details).toBe("relation/permission `member` not found under definition `user`");
  });

  describe("ellipsis short-circuit", () => {
    it("accepts the ellipsis relation without a schema lookup when allowed", () => {
      expect(
        tryCheckNamespaceAndRelations(snapshot, {
          definitionName: "user",
          relationName: ELLIPSIS,
          allowEllipsis: true,
        }),
      ).toBeUndefined();
    });

    it("still rejects the ellipsis relation when it is not allowed", () => {
      const error = tryCheckNamespaceAndRelations(snapshot, {
        definitionName: "user",
        relationName: ELLIPSIS,
        allowEllipsis: false,
      });

      expect(error?.code).toBe(status.FAILED_PRECONDITION);
      expect(error?.details).toBe("relation/permission `...` not found under definition `user`");
    });

    it("does not short-circuit the DEFINITION lookup: an unknown type still fails", () => {
      const error = tryCheckNamespaceAndRelations(snapshot, {
        definitionName: "nonexistent",
        relationName: ELLIPSIS,
        allowEllipsis: true,
      });

      expect(error?.details).toBe("object definition `nonexistent` not found");
    });

    it("short-circuits only the exact ellipsis, not any other relation", () => {
      const error = tryCheckNamespaceAndRelations(snapshot, {
        definitionName: "user",
        relationName: "..",
        allowEllipsis: true,
      });

      expect(error?.details).toBe("relation/permission `..` not found under definition `user`");
    });
  });

  describe("ordering", () => {
    it("returns the FIRST failure, so a resource pair is reported before a subject pair", () => {
      const error = tryCheckNamespaceAndRelations(
        snapshot,
        { definitionName: "missingresource", relationName: "viewer", allowEllipsis: false },
        { definitionName: "missingsubject", relationName: ELLIPSIS, allowEllipsis: true },
      );

      expect(error?.details).toBe("object definition `missingresource` not found");
    });

    it("reports a later pair when the earlier ones pass", () => {
      const error = tryCheckNamespaceAndRelations(
        snapshot,
        { definitionName: "document", relationName: "viewer", allowEllipsis: false },
        { definitionName: "user", relationName: "notarelation", allowEllipsis: true },
      );

      expect(error?.details).toBe(
        "relation/permission `notarelation` not found under definition `user`",
      );
    });

    it("checks the definition before the relation within a single pair", () => {
      const error = tryCheckNamespaceAndRelations(snapshot, {
        definitionName: "nonexistent",
        relationName: "alsononexistent",
        allowEllipsis: false,
      });

      expect(error?.details).toBe("object definition `nonexistent` not found");
    });
  });

  describe("ordinal string comparison", () => {
    it("is case sensitive on the definition name", () => {
      const error = tryCheckNamespaceAndRelations(snapshot, {
        definitionName: "Document",
        relationName: "viewer",
        allowEllipsis: false,
      });

      expect(error?.details).toBe("object definition `Document` not found");
    });

    it("is case sensitive on the relation name", () => {
      const error = tryCheckNamespaceAndRelations(snapshot, {
        definitionName: "document",
        relationName: "Viewer",
        allowEllipsis: false,
      });

      expect(error?.details).toBe(
        "relation/permission `Viewer` not found under definition `document`",
      );
    });

    it("does not normalize Unicode", () => {
      const composedName = "caf\u00e9"; // e-acute as one code point
      const decomposedName = "cafe\u0301"; // "e" + combining acute
      const composed = snapshotOf(namespaceOf(composedName, "viewer"));

      expect(
        tryCheckNamespaceAndRelations(composed, {
          definitionName: composedName,
          relationName: "viewer",
          allowEllipsis: false,
        }),
      ).toBeUndefined();
      expect(
        tryCheckNamespaceAndRelations(composed, {
          definitionName: decomposedName,
          relationName: "viewer",
          allowEllipsis: false,
        })?.details,
      ).toBe(`object definition \`${decomposedName}\` not found`);
    });
  });

  it("takes the first matching namespace when a name repeats in the snapshot", () => {
    const duplicated = snapshotOf(
      namespaceOf("document", "viewer"),
      namespaceOf("document", "editor"),
    );

    expect(
      tryCheckNamespaceAndRelations(duplicated, {
        definitionName: "document",
        relationName: "viewer",
        allowEllipsis: false,
      }),
    ).toBeUndefined();
    expect(
      tryCheckNamespaceAndRelations(duplicated, {
        definitionName: "document",
        relationName: "editor",
        allowEllipsis: false,
      })?.details,
    ).toBe("relation/permission `editor` not found under definition `document`");
  });
});

describe("checkNamespaceAndRelations", () => {
  it("returns without throwing when every pair validates", () => {
    expect(() =>
      checkNamespaceAndRelations(
        snapshot,
        { definitionName: "document", relationName: "viewer", allowEllipsis: false },
        { definitionName: "user", relationName: ELLIPSIS, allowEllipsis: true },
      ),
    ).not.toThrow();
  });

  it("throws the same error the non-throwing variant returns", () => {
    const error = expectRpcError(() =>
      checkNamespaceAndRelations(snapshot, {
        definitionName: "nonexistent",
        relationName: "viewer",
        allowEllipsis: false,
      }),
    );

    expect(error.code).toBe(status.FAILED_PRECONDITION);
    expect(error.details).toBe("object definition `nonexistent` not found");
  });

  it("throws on the first failing pair", () => {
    const error = expectRpcError(() =>
      checkNamespaceAndRelations(
        snapshot,
        { definitionName: "document", relationName: "notarelation", allowEllipsis: false },
        { definitionName: "alsomissing", relationName: ELLIPSIS, allowEllipsis: true },
      ),
    );

    expect(error.details).toBe(
      "relation/permission `notarelation` not found under definition `document`",
    );
  });
});

describe("wildcardSubjectError", () => {
  it("returns InvalidArgument with SpiceDB's exact message for the public wildcard", () => {
    const error = wildcardSubjectError(PUBLIC_WILDCARD);

    expect(error).toBeInstanceOf(RpcError);
    expect(error?.code).toBe(status.INVALID_ARGUMENT);
    expect(error?.details).toBe("invalid argument: cannot perform check on wildcard subject");
  });

  it("returns undefined for an ordinary subject id", () => {
    expect(wildcardSubjectError("alice")).toBeUndefined();
  });

  it("matches only the exact wildcard id", () => {
    expect(wildcardSubjectError("")).toBeUndefined();
    expect(wildcardSubjectError("**")).toBeUndefined();
    expect(wildcardSubjectError(" *")).toBeUndefined();
    expect(wildcardSubjectError("* ")).toBeUndefined();
    expect(wildcardSubjectError("*alice")).toBeUndefined();
  });

  it("does not throw", () => {
    expect(() => wildcardSubjectError(PUBLIC_WILDCARD)).not.toThrow();
  });
});

describe("rejectWildcardSubject", () => {
  it("throws for the public wildcard", () => {
    const error = expectRpcError(() => rejectWildcardSubject(PUBLIC_WILDCARD));

    expect(error.code).toBe(status.INVALID_ARGUMENT);
    expect(error.details).toBe("invalid argument: cannot perform check on wildcard subject");
  });

  it("returns for any other subject id", () => {
    expect(() => rejectWildcardSubject("alice")).not.toThrow();
    expect(() => rejectWildcardSubject("")).not.toThrow();
    expect(() => rejectWildcardSubject("**")).not.toThrow();
  });
});

describe("toRpcStatus", () => {
  it("copies the numeric gRPC code into google.rpc.Status.code", () => {
    const rpcStatus = toRpcStatus(new RpcError(status.FAILED_PRECONDITION, "nope"));

    expect(rpcStatus.code).toBe(status.FAILED_PRECONDITION);
    expect(rpcStatus.code).toBe(9);
  });

  it("copies the detail into google.rpc.Status.message", () => {
    const rpcStatus = toRpcStatus(new RpcError(status.INVALID_ARGUMENT, "bad pair"));

    expect(rpcStatus.code).toBe(3);
    expect(rpcStatus.message).toBe("bad pair");
  });

  it("emits an empty details list", () => {
    expect(toRpcStatus(new RpcError(status.INTERNAL, "x")).details).toEqual([]);
  });

  it("round-trips the errors this module itself produces", () => {
    const namespaceError = wildcardSubjectError(PUBLIC_WILDCARD);
    expect(namespaceError).toBeDefined();

    const rpcStatus = toRpcStatus(namespaceError!);

    expect(rpcStatus.code).toBe(3);
    expect(rpcStatus.message).toBe("invalid argument: cannot perform check on wildcard subject");
  });
});
