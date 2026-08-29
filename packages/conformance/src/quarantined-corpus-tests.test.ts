import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

/**
 * Makes quarantined corpus files visible in every test run, not just in
 * `corpus/Quarantine/README.md`. Every `*.yaml` directly under `corpus/Quarantine/` gets one
 * explicitly-skipped test case; the skip reason is the documented quarantine reason so a reviewer
 * sees the gap without opening the README. Ported from
 * `tests/Spiceport.Conformance.Tests/QuarantinedCorpusTests.cs`.
 *
 * Quarantine here means a KNOWN DIVERGENCE that is deliberately NOT executed: an upstream SpiceDB
 * fixture Spiceport could not pass faithfully at the time it was considered for vendoring. It is
 * neither an expected-to-fail case (nothing here runs the engine) nor part of the corpus. The
 * folder is deliberately excluded from the main corpus loaders, which enumerate `corpus/*.yaml`
 * NON-recursively - quarantined files are never silently picked up as part of the main corpus.
 *
 * Port notes:
 *   * The C# reads `TestData/Quarantine`; here the same tree is vendored at `corpus/Quarantine`,
 *     and the fallback reason string points at that path instead.
 *   * `Directory.EnumerateFiles(dir, "*.yaml")` is non-recursive and returns files only;
 *     `readdirSync(dir, { withFileTypes: true })` filtered to files reproduces that. The
 *     `Directory.Exists` guard becomes an `ENOENT` catch.
 *   * `.OrderBy(p => p, StringComparer.Ordinal)` is JavaScript's default `Array.prototype.sort`,
 *     which compares UTF-16 code units - the same order for these ASCII filenames.
 *   * `Skip.If(true, reason)` becomes `ctx.skip(true, reason)`, NOT the `it.skipIf(condition)`
 *     that `orleans-to-thresh-port.md` names for `Xunit.SkippableFact`: `it.skipIf` carries no
 *     reason, and the reason is the entire point of this suite.
 */

/**
 * Per-file quarantine reasons, keyed by filename. Kept alongside (and in sync with)
 * `corpus/Quarantine/README.md`; empty because nothing is currently quarantined.
 */
const quarantineReasons: Readonly<Record<string, string>> = {};

/**
 * No-quarantine sentinel: an empty case list is itself a runner failure (vitest reports "No test
 * suite found" for a file that registers no tests), so the (expected, documented) zero-files case
 * is represented as one explicit row instead of zero rows.
 */
const noneQuarantinedSentinel = "";

const quarantineDir = fileURLToPath(new URL("../corpus/Quarantine", import.meta.url));

function quarantinedFiles(): readonly string[] {
  let files: readonly string[];
  try {
    files = readdirSync(quarantineDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") {
      throw error;
    }
    files = [];
  }

  const data = [...files];

  if (data.length === 0) {
    data.push(noneQuarantinedSentinel);
  }

  return data;
}

describe("QuarantinedCorpus", () => {
  /** Reports one skipped test per quarantined file (or a trivial pass when none exist). */
  it.for(quarantinedFiles())('quarantined file is reported as skipped: "%s"', (fileName, ctx) => {
    if (fileName === noneQuarantinedSentinel) {
      return; // Nothing is currently quarantined; nothing to skip-report.
    }

    const reason =
      quarantineReasons[fileName] ??
      "quarantined (see corpus/Quarantine/README.md for the recorded reason)";

    ctx.skip(true, `${fileName}: ${reason}`);
  });
});
