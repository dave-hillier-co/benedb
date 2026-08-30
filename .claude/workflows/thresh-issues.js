export const meta = {
  name: "thresh-issues",
  description: "Fix a set of open Thresh GitHub issues test-first, gating both Thresh and SpaceDB",
  whenToUse:
    "Run when a batch of Thresh findings raised by the SpaceDB port needs fixing. Pass args: { issues: [numbers], notes }.",
  phases: [
    { title: "Triage", detail: "read each issue and the code, group by file overlap" },
    { title: "Fix", detail: "failing test first, then the change" },
    { title: "Gate", detail: "typecheck + test in BOTH repos" },
    { title: "Review", detail: "parity, blast radius, and whether the tests are load-bearing" },
  ],
};

const THRESH = "/Users/davehillier/repos/thresh";
const SPACEDB = "/Users/davehillier/repos/spacedb";
const ORLEANS = "/Users/davehillier/repos/orleans";

const issues = args?.issues ?? [];
const notes = args?.notes ?? "";
if (issues.length === 0) throw new Error("thresh-issues: args.issues must list issue numbers");

const CONTEXT = `
You are fixing open issues in Thresh (${THRESH}), a TypeScript virtual-actor runtime targeting
Microsoft Orleans 10 parity. Orleans itself is at ${ORLEANS} — consult it whenever "what should
this do?" is in question, and prefer its answer over an invention.

Every one of these issues was raised by SpaceDB (${SPACEDB}), a wire-compatible SpiceDB
implementation that is Thresh's first production consumer. SpaceDB links Thresh from source, so a
change here takes effect there IMMEDIATELY. That cuts both ways:
  * A Thresh change that breaks SpaceDB is not done. Both repos must be green.
  * SpaceDB is the evidence. When an issue says "SpaceDB needed X", read the consumer it names.

Read ${THRESH}/docs/orleans-to-thresh-port.md (the standing Orleans->Thresh translation guide) and
${THRESH}/docs/deviations.md (where Thresh knowingly differs from Orleans) BEFORE changing
anything. If your change adds or removes a deviation, update deviations.md in the same breath.

House rules: no index.ts barrels, kebab-case filenames, one primary export per file, no emojis,
classic sociable TDD. Use \`gh issue view <n> --repo dave-hillier-co/thresh\` to read an issue.
${notes ? `\n${notes}\n` : ""}`;

const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    batches: {
      type: "array",
      description:
        "Groups of issues that must be fixed together or in sequence because they touch the same files. Ordered: an earlier batch never depends on a later one.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "short kebab-case name" },
          issues: { type: "array", items: { type: "number" } },
          files: {
            type: "array",
            items: { type: "string" },
            description: "the Thresh files this batch is expected to touch",
          },
          rationale: { type: "string" },
          risk: {
            type: "string",
            description:
              "what could break in SpaceDB or in Thresh's own suite, and which existing tests encode the CURRENT behaviour",
          },
        },
        required: ["name", "issues", "files", "rationale", "risk"],
      },
    },
  },
  required: ["batches"],
};

const FIX_SCHEMA = {
  type: "object",
  properties: {
    issues: { type: "array", items: { type: "number" } },
    done: { type: "boolean" },
    testsAdded: { type: "array", items: { type: "string" } },
    testsChanged: {
      type: "array",
      items: { type: "string" },
      description:
        "existing tests whose EXPECTATION changed, each with why the old expectation was wrong",
    },
    behaviourChanges: {
      type: "array",
      items: { type: "string" },
      description: "observable changes a consumer could notice, including SpaceDB",
    },
    deferred: {
      type: "array",
      items: { type: "string" },
      description: "anything in the issue deliberately NOT done, and why",
    },
  },
  required: ["issues", "done", "testsAdded", "testsChanged", "behaviourChanges", "deferred"],
};

phase("Triage");
const plan = await agent(
  `${CONTEXT}

Read each of these Thresh issues and the code each one names:
${issues.map((n) => `  - #${n}`).join("\n")}

Then group them into batches. Two issues belong in the same batch when they touch the same file or
the same subsystem, because these are fixed sequentially and a later batch inherits the earlier
one's edits. Order the batches so the broadest / most depended-upon change lands first.

For each batch, name the files you expect to touch, and in "risk" name the EXISTING tests that
encode the behaviour you are about to change — in Thresh and in SpaceDB. Some Thresh tests
deliberately document a current limitation (for example a test asserting that only RejectionError
survives the wire with its subtype). Those are not obstacles to route around, but changing one is a
deliberate act that has to be justified, so find them now rather than discovering them mid-fix.

Do not write any code in this phase.`,
  { label: "triage", schema: TRIAGE_SCHEMA, effort: "high" },
);

const planned = plan.batches.flatMap((b) => b.issues);
const missing = issues.filter((n) => !planned.includes(n));
const duplicated = planned.filter((n, i) => planned.indexOf(n) !== i);
const unknown = planned.filter((n) => !issues.includes(n));
if (missing.length > 0 || duplicated.length > 0 || unknown.length > 0) {
  throw new Error(
    `thresh-issues: the plan does not cover the issues exactly once.\n` +
      (missing.length > 0 ? `  missing: ${missing.join(", ")}\n` : "") +
      (duplicated.length > 0 ? `  duplicated: ${duplicated.join(", ")}\n` : "") +
      (unknown.length > 0 ? `  not an input: ${unknown.join(", ")}\n` : ""),
  );
}

log(`${issues.length} issues in ${plan.batches.length} batches, coverage verified`);

const results = [];
for (const batch of plan.batches) {
  const manifest =
    `Issues: ${batch.issues.map((n) => `#${n}`).join(", ")}\n` +
    `Rationale: ${batch.rationale}\n` +
    `Expected files: ${batch.files.join(", ")}\n` +
    `Known risk: ${batch.risk}`;

  phase("Fix");
  const fixed = await agent(
    `${CONTEXT}

Fix batch "${batch.name}".

${manifest}

TEST FIRST, and prove the test is load-bearing. For each issue: write a test that fails for the
reason the issue describes, watch it fail, then make the change, then confirm it passes. A test
written after the fix that has never been seen red is not evidence.

Where a fix is genuinely untestable in-process, say so in "deferred" rather than writing a test
that restates the implementation. A test that would pass against the unfixed code is worse than no
test, because it reports coverage that does not exist.

If an EXISTING test asserts the behaviour you are changing, do not delete it and do not weaken it.
Decide whether the old expectation was documenting a limitation (update it, and say why in
"testsChanged") or was protecting something real (then your change is wrong). Same for
docs/deviations.md.

Additive beats disruptive: prefer a change that leaves every current caller working. If an issue
cannot be resolved additively, do it properly anyway and record the break in "behaviourChanges" —
but do not go looking for a redesign the issue did not ask for.`,
    { label: `fix:${batch.name}`, phase: "Fix", schema: FIX_SCHEMA, effort: "high" },
  );
  results.push(fixed);

  phase("Gate");
  await agent(
    `${CONTEXT}

Batch "${batch.name}" was just changed:

${manifest}

Run, and get every one of them green:
  cd ${THRESH}   && pnpm typecheck && pnpm test && pnpm lint
  cd ${SPACEDB}  && pnpm typecheck && pnpm test && pnpm test:conformance && pnpm lint

BOTH repos. SpaceDB links Thresh from source, so a Thresh change lands there instantly — that is
the whole point of running its suite here, and a SpaceDB failure is this batch's failure.

Do NOT run pnpm test:differential (it needs Docker and a real spicedb container), and never start
a silo host: a backgrounded host orphans and runs forever.

Two rules. Fix the code, not the assertion — if a test fails, the change is wrong until you have
read Orleans and proved otherwise. And never edit ${SPACEDB}/packages/conformance/corpus: it is a
verbatim compatibility corpus and weakening a case to get green is the one unrecoverable mistake
here.

Report exactly which commands ended green and what you changed.`,
    { label: `gate:${batch.name}`, phase: "Gate", effort: "medium" },
  );
}

phase("Review");
const LENSES = [
  {
    key: "parity",
    prompt:
      "Orleans parity. For each change, find the Orleans 10 behaviour it claims to mirror (in " +
      `${ORLEANS}) and check it actually does — including the edge cases: what Orleans does on a ` +
      "null/absent value, on a repeat call, on an already-cancelled token, on a concurrent caller. " +
      "Report any place the fix invents a behaviour Orleans does not have, or mirrors the wrong API.",
  },
  {
    key: "blast-radius",
    prompt:
      "Blast radius. These are runtime changes under a live consumer. For each change, find every " +
      "caller (in Thresh AND in SpaceDB) and check none silently changed meaning: a widened type " +
      "that now accepts something it should reject, a new base class that makes an existing " +
      "instanceof match more than it did, a default that shifted, an error that now escapes where " +
      "it was previously swallowed. Serialization changes deserve particular suspicion: anything " +
      "written to durable storage or sent on the wire must still round-trip values written before.",
  },
  {
    key: "test-quality",
    prompt:
      "Are the new tests load-bearing? For each test added in this run, work out whether it would " +
      "actually FAIL against the unfixed code — mentally revert the change and re-read the test. " +
      "Report any test that restates the implementation, asserts a tautology, tests a local " +
      "re-implementation of the contract rather than the real code path, or would pass either way. " +
      "Also report any issue in this batch that got a fix but no test at all.",
  },
];

const reviews = await parallel(
  LENSES.map(
    (lens) => () =>
      agent(
        `${CONTEXT}

Review this run's Thresh changes for one failure mode only: ${lens.key}.

${lens.prompt}

Issues fixed in this run: ${issues.map((n) => `#${n}`).join(", ")}.
Use \`git -C ${THRESH} diff\` and \`git -C ${THRESH} status\` to see exactly what changed; the run
started from a clean tree at HEAD.

Report only defects you can state concretely, with the file and line and the input that shows it.
If you find none, say so plainly; do not pad.`,
        { label: `review:${lens.key}`, phase: "Review", effort: "high" },
      ),
  ),
);

return {
  issues,
  batches: plan.batches.map((b) => ({ name: b.name, issues: b.issues })),
  testsAdded: results.flatMap((r) => r?.testsAdded ?? []),
  testsChanged: results.flatMap((r) => r?.testsChanged ?? []),
  behaviourChanges: results.flatMap((r) => r?.behaviourChanges ?? []),
  deferred: results.flatMap((r) => r?.deferred ?? []),
  reviews: LENSES.map((l, i) => ({ lens: l.key, findings: reviews[i] })),
};
