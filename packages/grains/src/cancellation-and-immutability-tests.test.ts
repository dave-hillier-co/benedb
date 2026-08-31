import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ELLIPSIS } from "@benedb/core/core-constants";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import { createRelationship } from "@benedb/core/relationship";
import type { DispatchCheckRequest } from "@benedb/engine/i-dispatcher";
import { GrainCallAbortedError, GrainTaskCanceledError } from "@thresh/core/errors";

import { setTestDispatchContext } from "./dispatch-context-test-helper";
import { DispatchFailedException } from "./dispatch-failed-exception";
import { grainKeyBuild } from "./grain-key";
import { ICheckGrain } from "./i-check-grain";
import { MeshTestCluster } from "./mesh-test-cluster";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/CancellationAndImmutabilityTests.cs`.
 *
 * Regression coverage for the dispatch plumbing itself, in three parts.
 *
 *  1. The dispatcher BRIDGES caller cancellation to the remote grain call: cancel after dispatching
 *     and the failure must arrive as a {@link DispatchFailedException} carrying the SPECIFIC code
 *     `cancelled`, not a generic error. It runs against a cyclic schema so the call is genuinely in
 *     flight when cancelled. Thresh's cancellation propagation across a grain call is what is under
 *     test; if the signal does not reach the callee, this fails and the fix belongs in Thresh.
 *  2. `CheckGrain` honours a cancellation signal RECEIVED ACROSS the grain boundary - the callee
 *     side of the same contract.
 *  3. The same-silo wire value types are DECLARED IMMUTABLE.
 *
 * PORT NOTES.
 *  - `CancellationToken` / `CancellationTokenSource` become `AbortSignal` / `AbortController`, per
 *    the port guide.
 *  - `dispatch.WaitAsync(TimeSpan.FromSeconds(10))` becomes {@link withTimeout}, which rejects with
 *    its own error when the bound is missed, exactly as `WaitAsync` throws `TimeoutException`. The
 *    losing timer is always cleared.
 *  - `Assert.ThrowsAnyAsync<OperationCanceledException>` has no TypeScript hierarchy behind it:
 *    C#'s `TaskCanceledException` derives from `OperationCanceledException`, so one catch covers
 *    both. The port matches the ABORT FAMILY explicitly - Thresh's `GrainCallAbortedError` and
 *    `GrainTaskCanceledError`, plus a DOM `AbortError` - which is the same list
 *    `dispatch-error-mapper.ts` already had to write out for the same reason.
 *  - `DispatchContextTestHelper` is imported from `dispatch-context-test-helper.ts`; the C#
 *    `using static` maps onto a normal import. That module used to live in a `*.test.ts` file,
 *    which would have re-registered ITS cases inside this file - see it for the ledger deviation.
 *  - THE IMMUTABILITY THEORY (deviation). The C# reflects for Orleans' `[Immutable]`, whose whole
 *    purpose is that a SAME-SILO grain call does not defensively deep-copy the value. Thresh has no
 *    such marker and performs no defensive copy on a local call, so there is no attribute to
 *    reflect over - and TypeScript erases the types entirely, so nothing about `DispatchCheckReply`
 *    or `LogEvent` exists at runtime to inspect. The case is NOT dropped: what `[Immutable]`
 *    asserted about these two wire values - that they are treated as immutable, never mutated in
 *    place by a callee that received them - is asserted here as every declared member of each
 *    interface being `readonly` in its source. That is the property a reviewer would otherwise have
 *    to take on trust, and it fails loudly the moment someone drops a `readonly`.
 */

const SRC_DIR = fileURLToPath(new URL(".", import.meta.url));

const SCHEMA = `definition user {}

definition document {
    relation viewer: user
    permission view = viewer
}`;

const CYCLIC_SCHEMA = `definition user {}

definition group {
    relation parent: group
    permission member = parent->member
}`;

function onr(objectType: string, objectId: string, relation: string): ObjectAndRelation {
  return { objectType, objectId, relation };
}

/** `Task.WaitAsync(TimeSpan)`: the same promise, but a missed bound is itself a failure. */
async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Awaits `work` and returns whatever it rejected with; fails the case if it resolves. */
async function rejection(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to fail, but it completed");
}

/**
 * The abort family that stands in for C#'s single `OperationCanceledException` catch. See the port
 * note above; the list is the one `dispatch-error-mapper.ts` already carries.
 */
function isCancellation(error: unknown): boolean {
  return (
    error instanceof GrainCallAbortedError ||
    error instanceof GrainTaskCanceledError ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

/** The declared members of one exported interface, as source lines. */
function interfaceMemberLines(moduleFile: string, interfaceName: string): readonly string[] {
  const text = readFileSync(join(SRC_DIR, moduleFile), "utf8");
  const start = text.indexOf(`export interface ${interfaceName} {`);
  expect(start, `${moduleFile} declares no exported interface ${interfaceName}`).toBeGreaterThan(
    -1,
  );

  // The declaration ends at the first closing brace in column 0, which is how every interface in
  // this package is formatted.
  const end = text.indexOf("\n}", start);
  expect(end, `could not find the end of interface ${interfaceName}`).toBeGreaterThan(start);

  const body = text.slice(text.indexOf("{", start) + 1, end);
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(readonly\s+)?[A-Za-z_$][\w$]*\??\s*:/.test(line));
}

describe("CancellationAndImmutabilityTests", () => {
  it("Dispatcher_bridges_caller_cancellation_to_the_remote_grain_call", async () => {
    const cluster = await MeshTestCluster.createMultiSilo(CYCLIC_SCHEMA, 1);
    try {
      await cluster.datastore.readWriteTx((tx) =>
        tx.writeRelationships([
          {
            relationship: createRelationship(
              onr("group", "loop", "parent"),
              onr("group", "loop", ELLIPSIS),
            ),
            operation: "create",
          },
        ]),
      );
      const head = await cluster.datastore.headRevision();
      const dispatcher = cluster.services.dispatcher;
      const request: DispatchCheckRequest = {
        resource: onr("group", "loop", "member"),
        subject: onr("user", "alice", ELLIPSIS),
        meta: {
          revision: head.revision,
          depthRemaining: 100_000,
          visited: new Set<string>(),
        },
      };

      const cancellation = new AbortController();
      const dispatch = dispatcher.dispatchCheck(request, cancellation.signal);
      cancellation.abort();

      const error = await rejection(withTimeout(dispatch, 10_000));
      expect(error).toBeInstanceOf(DispatchFailedException);
      expect((error as DispatchFailedException).code).toBe("cancelled");
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  it("Check_grain_honours_a_cancellation_token_received_across_the_grain_boundary", async () => {
    const cluster = await MeshTestCluster.create(SCHEMA);
    try {
      const head = await cluster.datastore.headRevision();
      const schemaHash = cluster.schemaProvider.current.schemaHash;
      const key = grainKeyBuild(
        onr("document", "readme", "view"),
        onr("user", "alice", ELLIPSIS),
        head.revision.toString(),
        schemaHash,
      );
      const grain = cluster.grainFactory.getGrain(ICheckGrain, key);

      const cancellation = new AbortController();
      cancellation.abort();

      setTestDispatchContext(50);
      const error = await rejection(grain.dispatchCheck(cancellation.signal));
      expect(isCancellation(error), `expected a cancellation, got ${String(error)}`).toBe(true);
    } finally {
      await cluster.dispose();
    }
  }, 120_000);

  // The C# `[Theory]` over `typeof(DispatchCheckReply)` and `typeof(LogEvent)`.
  const wireTypes: readonly (readonly [string, string])[] = [
    ["i-check-grain.ts", "DispatchCheckReply"],
    ["log-event.ts", "LogEvent"],
  ];

  for (const [moduleFile, typeName] of wireTypes) {
    it(`Same_silo_wire_values_are_declared_immutable(${typeName})`, () => {
      const members = interfaceMemberLines(moduleFile, typeName);
      expect(members.length, `${typeName} declares no members to check`).toBeGreaterThan(0);

      const mutable = members.filter((line) => !line.startsWith("readonly "));
      expect(
        mutable,
        `${typeName} must remain fully readonly so same-silo grain calls do not defensively copy ` +
          `it; mutable member(s): ${mutable.join(" | ")}`,
      ).toEqual([]);
    });
  }
});
