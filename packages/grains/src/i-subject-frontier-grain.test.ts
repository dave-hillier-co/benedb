import type { GrainKeyFor } from "@thresh/core/key-kinds";
import { describe, expect, it } from "vitest";

import { ISubjectFrontierGrain } from "./i-subject-frontier-grain";
import type { SubjectFrontierReply } from "./subject-frontier-dtos";

// Characterization test for
// `src/Spiceport.Server/Grains.Abstractions/ISubjectFrontierGrain.cs`, which has no covering C#
// test of its own. NOTHING HERE ACTIVATES A GRAIN: `SubjectFrontierGrain` is a later slice.

describe("ISubjectFrontierGrain", () => {
  it("is both a type and a registered GrainInterface VALUE named for the C# interface", () => {
    expect(ISubjectFrontierGrain.name).toBe("ISubjectFrontierGrain");
  });

  it("carries NO per-method invocation options: GetFrontier has no interleave attribute", () => {
    expect(ISubjectFrontierGrain.options).toEqual({});
  });

  it("is string-keyed by SEVEN segments - there is no subjectId in this identity", () => {
    // resType/resId/relation/subjType/subjRelation/quantizedRevision/schemaHash. Seven, not eight:
    // the frontier is the whole set of subjects, so it is keyed by subject TYPE and relation and
    // never by an individual subject id. See subject-frontier-key.ts.
    const key: GrainKeyFor<ISubjectFrontierGrain> = "document/readme/view/user/.../12345/hash-abc";

    expect(key.split("/")).toHaveLength(7);
  });

  it("declares getFrontier(signal?) => Promise<SubjectFrontierReply>, the whole frontier in ONE call", () => {
    // Unlike ICheckGrain there is NO dispatcher seam here: the engine walk this grain wraps
    // computes the whole frontier in-process behind a single call, not a recursive dispatch tree.
    const reply: SubjectFrontierReply = { subjects: [] };
    const fake: ISubjectFrontierGrain = {
      getFrontier: (_signal?: AbortSignal) => Promise.resolve(reply),
    };

    expect(Object.keys(fake)).toEqual(["getFrontier"]);
    return expect(fake.getFrontier(new AbortController().signal)).resolves.toEqual(reply);
  });
});
