/**
 * Raised when Check meets an exclusion with a lone operand.
 *
 * Ported from the `InvalidOperationException` Spiceport's `LocalDispatcher.CheckRewrite` throws for a
 * single-child exclusion. Per the port guide an `InvalidOperationException` becomes a project error
 * class named for the invariant it protects, declared beside its one throw site rather than as a
 * package-wide vocabulary the C# does not have.
 *
 * SpiceDB's `difference` treats a lone operand as a bug (`MustBugf("difference requires more than a
 * single child")`). The schema parser never builds one, so reaching this means a malformed stored
 * rewrite. It is deliberately NOT a dispatch domain exception: crossing a grain hop it classifies as
 * `internal`, exactly as the C#'s `InvalidOperationException` does.
 */
export class SingleChildExclusionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SingleChildExclusionError";
  }
}
