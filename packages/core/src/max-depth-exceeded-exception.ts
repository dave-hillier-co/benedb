/**
 * Thrown when a permission check exhausts its recursion depth budget before reaching a definitive
 * answer. Mirrors SpiceDB's `MaxDepthExceededError` (dispatch.CheckDepth): a graph/schema deeper
 * than the configured max depth (or a true cycle the visited set cannot otherwise bound) is treated
 * as a misconfiguration error, NOT a confident "not a member" verdict. The API layer maps this to
 * gRPC `FailedPrecondition`, matching observable `zed`/SpiceDB behaviour.
 *
 * Ported from Spiceport `src/Spiceport.Server/MaxDepthExceededException.cs`.
 *
 * LEDGER AMENDMENT. `docs/port-ledger.md` originally targeted `packages/grains/src/...` (S4).
 * `LocalDispatcher` throws this and `@spacedb/engine` may not import from `@spacedb/grains`, so the
 * row is amended to S3 / `packages/core/src/...`. The C# file already declares
 * `namespace Spiceport.Core`; only its directory said otherwise.
 *
 * The C# `[GenerateSerializer]` exists so the error round-trips the Orleans grain boundary with its
 * concrete type intact. Under Thresh that becomes an error registration at the grain layer (S4);
 * the class itself carries no state beyond its message.
 */
export class MaxDepthExceededException extends Error {
  /**
   * Creates the exception, defaulting to the standard max-depth-exceeded message.
   *
   * The C# has two constructors - one taking a message, one parameterless with a hard-coded
   * message. They collapse to one optional parameter plus a `??` resolver, so an explicitly
   * supplied message still wins.
   */
  constructor(message?: string | undefined) {
    super(
      message ??
        "the check request has exceeded the maximum allowable depth; this usually indicates a " +
          "misconfigured schema or a cycle, and may be raised for legitimately deep data",
    );
    this.name = "MaxDepthExceededException";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
