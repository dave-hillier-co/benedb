export const meta = {
  name: "port-stage",
  description:
    "Port one Spiceport layer to TypeScript: dependency-order, tests first, gate, review",
  whenToUse:
    "Run once per stage of the SpaceDB port (S1 core/schema, S2 datastore, S3 engine, S4 grains, S5 api). Pass args: { stage, targets: [package names], sources: [csharp paths], tests: [csharp test paths], batchCount }.",
  phases: [
    { title: "Order", detail: "dependency-sort the stage's files into cohesive batches" },
    {
      title: "Tests",
      detail: "port (or characterize) each batch's tests ahead of its implementation",
    },
    { title: "Port", detail: "transliterate each batch against the Orleans-to-Thresh guide" },
    { title: "Gate", detail: "typecheck + vitest until green" },
    { title: "Review", detail: "hunt the failure modes compilation does not catch" },
  ],
};

const SPICEPORT = "/Users/davehillier/repos/spiceport";
const SPACEDB = "/Users/davehillier/repos/spacedb";
const GUIDE = "/Users/davehillier/repos/thresh/docs/orleans-to-thresh-port.md";

const stage = args?.stage ?? "S1";
const targets = args?.targets ?? ["core"];
const sources = args?.sources ?? [];
const tests = args?.tests ?? [];
const batchCount = args?.batchCount ?? 5;
/** Stage-specific guidance appended to every agent's context. */
const notes = args?.notes ?? "";
/**
 * When set, the C# files in `tests` are DELIVERABLES of this stage rather than candidate covers to
 * name in a file's `testSource`. The completeness guard then polices the union: a mesh suite
 * silently dropped from the plan is the same invisible failure as a dropped production file, and
 * it is the LOUDER one, because the suite is what grades the port. Declared HERE, with the other
 * args, because the Order prompt below reads it -- a `const` beside the guard is in its temporal
 * dead zone by then.
 */
const portTests = args?.portTests === true;

if (sources.length === 0)
  throw new Error("port-stage: args.sources must list the C# files to port");

const CONTEXT = `
You are porting Spiceport (.NET 10 + Orleans, at ${SPICEPORT}) to SpaceDB
(TypeScript + Thresh, at ${SPACEDB}). Stage ${stage}, target packages ${targets.map((t) => `@spacedb/${t}`).join(", ")}
(sources under ${SPACEDB}/packages/<name>/src). ${SPACEDB}/docs/port-ledger.md gives every
file's target path; use it rather than inventing one.

Read ${GUIDE} before writing any code. It is the standing instruction for this work and its
substitutions are not optional. Also honour the house rules in ${SPACEDB}/CLAUDE.md: no index.ts
barrels, no emojis, kebab-case filenames, one primary export per file, classic sociable TDD.

The Go original is at /Users/davehillier/repos/spicedb and Orleans itself at
/Users/davehillier/repos/orleans. Consult them when Spiceport's intent is ambiguous; never
guess at semantics that the conformance corpus will later assert.
${notes ? `\nStage-specific guidance:\n${notes}\n` : ""}`;

const FILE_SCHEMA = {
  type: "object",
  properties: {
    source: { type: "string", description: "C# path relative to the spiceport root" },
    targetPath: { type: "string", description: "TS path relative to the spacedb root" },
    testSource: {
      type: "string",
      description: "covering C# test path, or empty if the C# has no direct test for it",
    },
    notes: { type: "string", description: "anything the transliterator must not miss" },
  },
  required: ["source", "targetPath", "testSource", "notes"],
};

const ORDER_SCHEMA = {
  type: "object",
  properties: {
    batches: {
      type: "array",
      description:
        "Cohesive groups of files, in dependency order. A batch's files may depend on earlier batches and on each other, never on a later batch.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "short kebab-case name, e.g. core-revisions" },
          rationale: { type: "string", description: "why these files belong together" },
          files: { type: "array", items: FILE_SCHEMA },
        },
        required: ["name", "rationale", "files"],
      },
    },
  },
  required: ["batches"],
};

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    targetPath: { type: "string" },
    done: { type: "boolean" },
    exportsAdded: { type: "array", items: { type: "string" } },
    deviations: {
      type: "array",
      items: { type: "string" },
      description: "places the port could not be mechanical, and what was decided instead",
    },
    guideGaps: {
      type: "array",
      items: { type: "string" },
      description: "mappings the Orleans-to-Thresh guide should have covered but did not",
    },
    threshGaps: {
      type: "array",
      items: { type: "string" },
      description: "Thresh features or bugs that blocked the port",
    },
  },
  required: ["targetPath", "done", "exportsAdded", "deviations", "guideGaps", "threshGaps"],
};

// ── Order ──────────────────────────────────────────────────────────────────
// A barrier is correct here: the batching needs every file's dependencies known
// before any batch can be scheduled.
phase("Order");
const plan = await agent(
  `${CONTEXT}

Read each of these C# files and work out the dependency graph between them:
${sources.map((s) => `  - ${s}`).join("\n")}

${
  portTests
    ? `C# test files that are THEMSELVES deliverables of this stage. Place every one of them into a
batch, in the batch where its subject is ported or in a later one - never earlier. They are the
gate this stage is graded by, so a dropped suite is worse than a dropped implementation:
${tests.map((t) => `  - ${t}`).join("\n")}`
    : `Candidate covering tests:
${tests.length > 0 ? tests.map((t) => `  - ${t}`).join("\n") : "  (none supplied)"}`
}

Group them into roughly ${batchCount} cohesive batches, in dependency order: a batch may depend
on earlier batches and on its own members, never on a later one. Group by module and by what a
single test file would naturally cover, not by size. Small related value types belong in one
batch; a large file with real logic can be a batch of one.

For each file give the TypeScript target path from ${SPACEDB}/docs/port-ledger.md, and the
covering C# test path IF one genuinely exercises it. Do not guess: several Spiceport test
projects are placeholders, and a file covered only indirectly from a higher layer has NO
covering test — say so with an empty string rather than naming a test that does not test it.

In notes, name anything a mechanical transliteration would get wrong: record types used as
dictionary keys, integer-overflow arithmetic, ordinal string comparison, struct copy semantics,
nullability that does not map cleanly, and any parsing or encoding whose exact byte/char
behaviour is wire-visible.`,
  { label: "order", schema: ORDER_SCHEMA, effort: "high" },
);

const planned = plan.batches.flatMap((b) => b.files.map((f) => f.source));
const totalFiles = planned.length;

const universe = portTests ? [...sources, ...tests] : sources;

// Completeness guard. A file silently dropped from the plan would port nothing and pass
// every gate downstream, because the gates only ever see what the plan produced -- it is
// the one failure mode this pipeline cannot otherwise observe. Duplicates matter too: the
// same file ported twice in different batches means the second port overwrites the first,
// losing whatever the later batch's dependencies taught it.
const missing = universe.filter((s) => !planned.includes(s));
const duplicated = planned.filter((s, i) => planned.indexOf(s) !== i);
const unknown = planned.filter((s) => !universe.includes(s));
if (missing.length > 0 || duplicated.length > 0 || unknown.length > 0) {
  throw new Error(
    `port-stage ${stage}: the plan does not cover the inputs exactly once.\n` +
      (missing.length > 0 ? `  missing (${missing.length}): ${missing.join(", ")}\n` : "") +
      (duplicated.length > 0 ? `  duplicated: ${duplicated.join(", ")}\n` : "") +
      (unknown.length > 0 ? `  not an input: ${unknown.join(", ")}\n` : ""),
  );
}

log(`${stage}: ${totalFiles} files in ${plan.batches.length} batches, coverage verified`);

// ── Tests, then port, then gate ────────────────────────────────────────────
// Sequential over batches rather than a pipeline: each batch's port depends on the
// earlier ones existing, which is exactly what the dependency order was computed for.
const results = [];
for (const [i, batch] of plan.batches.entries()) {
  const isTestPort = (f) => tests.includes(f.source);
  const manifest = batch.files
    .map(
      (f) =>
        `  - ${f.source} -> ${f.targetPath}` +
        (f.testSource ? `  [test: ${f.testSource}]` : "  [no covering C# test]") +
        (f.notes ? `\n      note: ${f.notes}` : ""),
    )
    .join("\n");

  phase("Tests");
  await agent(
    `${CONTEXT}

Write the tests for batch "${batch.name}" (${batch.rationale}).

${manifest}
${
  portTests && batch.files.some(isTestPort)
    ? `\nThese entries are C# TEST files and are this batch's real work — port each one to Vitest at
its target path, faithfully. Do NOT write a test for a test file:
${batch.files
  .filter(isTestPort)
  .map((f) => `  - ${f.source} -> ${f.targetPath}`)
  .join("\n")}

Port them AS THEY ARE. Keep every case and every assertion. If a case cannot run yet because its
subject is not ported, leave it failing — the port step that follows is what makes it pass. Never
delete, skip or soften a case to get a green run; a suite that has been trimmed to fit the
implementation grades nothing.\n`
    : ""
}
For a file WITH a covering C# test: port that test to Vitest, into the .test.ts path beside its
subject. Keep its cases and its assertions; do not weaken one to make it pass, and do not invent
coverage the C# did not have.

For a file with NO covering C# test: write a characterization test instead. Read the C#
carefully and pin the behaviour it actually has — parsing and formatting round-trips, boundary
and malformed inputs, encoding exactness, comparison and ordering. These files are covered only
indirectly in Spiceport, from layers this port has not reached yet, so this test is the only
gate they will have for some time. Pin behaviour, not implementation detail.

The tests come FIRST: the target files may not exist. Write against the interface the C#
implies, import what does not exist yet, and let it fail — the port step that follows makes it
pass.`,
    { label: `test:${batch.name}`, phase: "Tests", effort: "medium" },
  );

  phase("Port");
  const ported = await agent(
    `${CONTEXT}

Port batch "${batch.name}" (${batch.rationale}).

${
  portTests
    ? batch.files.filter((f) => !isTestPort(f)).length === 0
      ? "This batch is test ports only — they were just written. Make them pass by fixing the\nimplementation ported in earlier batches, never by editing the test."
      : manifest
    : manifest
}

Everything in earlier batches is already ported; import from it rather than duplicating.

This is a transliteration, not a redesign: keep the same names, the same structure, the same
order of operations as the C#. Where the guide gives a substitution, apply it. Where it does
not, and the translation needs a real decision, make the decision, record it in "deviations",
and keep going. Do not change behaviour to make something read better in TypeScript.

The tests for this batch were just written and are expected to be failing.`,
    { label: `port:${batch.name}`, phase: "Port", schema: RESULT_SCHEMA, effort: "medium" },
  );
  results.push(ported);

  phase("Gate");
  await agent(
    `${CONTEXT}

Run, from ${SPACEDB}:
  pnpm typecheck
  pnpm test

Fix whatever fails until both are green. Batch "${batch.name}" was just written:

${manifest}

Two rules. Fix the implementation, never the assertion — if a ported test fails, the port is
wrong until you have read the C# and proved otherwise. And if the blocker is in Thresh
(/Users/davehillier/repos/thresh) rather than here, stop and report it rather than working
around it: Thresh bugs are a deliverable of this port, not an obstacle.

Report what you changed and whether both commands ended green.`,
    { label: `gate:${batch.name}`, phase: "Gate", effort: "medium" },
  );
}

// ── Review ─────────────────────────────────────────────────────────────────
// Distinct lenses rather than N identical reviewers: transliteration fails in
// specific, unrelated ways, and one reviewer looking for all of them finds few.
phase("Review");
const LENSES = [
  {
    key: "equality",
    prompt:
      "Record/struct types used as Map or Set keys, or compared with === where the C# used value " +
      "equality. C# records compare structurally; JS objects compare by reference. Every such site " +
      "is a silent lookup miss. Also check Map key canonicalisation is total: two distinct values " +
      "must never produce the same key string.",
  },
  {
    key: "numerics",
    prompt:
      "Integer semantics. C# int overflow wraps; JS number does not. Check every hash, checksum, " +
      "bit manipulation and counter for missing Math.imul / |0 / >>>0 / BigInt. Check every long " +
      "and ulong that can exceed 2^53 became bigint or string, consistently, at the value type.",
  },
  {
    key: "ordering",
    prompt:
      "String comparison and ordering. CompareOrdinal is not localeCompare. Anything sorted for a " +
      "wire-visible cursor, a revision, or a canonical key must be ordinal. Also check .sort() calls " +
      "copy first (it mutates) and their comparators are total.",
  },
  {
    key: "semantics",
    prompt:
      "Behavioural drift from the C#: dropped branches, reordered short-circuits, null vs undefined " +
      "confusion, exceptions that changed type or message, off-by-one in slicing/paging, and async " +
      "iteration that eagerly materialises where the C# was lazy.",
  },
];

const reviews = await parallel(
  LENSES.map(
    (lens) => () =>
      agent(
        `${CONTEXT}

Review the ${stage} port for one failure mode only: ${lens.key}.

${lens.prompt}

Files ported in this stage:
${plan.batches
  .flatMap((b) => b.files)
  .map((f) => `  - ${f.source} -> ${f.targetPath}`)
  .join("\n")}

Read both sides — the C# and the TypeScript — for each. Report only defects you can state as a
concrete failing input, with the file and line. If you find none, say so; do not pad.`,
        { label: `review:${lens.key}`, phase: "Review", effort: "high" },
      ),
  ),
);

return {
  stage,
  targets,
  filesPorted: totalFiles,
  batches: plan.batches.map((b) => ({ name: b.name, files: b.files.length })),
  deviations: results.flatMap((r) => r?.deviations ?? []),
  guideGaps: results.flatMap((r) => r?.guideGaps ?? []),
  threshGaps: results.flatMap((r) => r?.threshGaps ?? []),
  reviews: LENSES.map((l, i) => ({ lens: l.key, findings: reviews[i] })),
};
