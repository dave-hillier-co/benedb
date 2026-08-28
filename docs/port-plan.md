# The port

SpaceDB is a wire-compatible SpiceDB implementation in TypeScript, built on
[Thresh](../../thresh). It is a port of [Spiceport](../../spiceport) — the .NET + Orleans
rearchitecture of SpiceDB — not of SpiceDB itself: Spiceport has already done the hard
translation from Go's hand-rolled dispatch layer to virtual actors, and that design carries
across unchanged. SpaceDB is the same architecture in a different runtime.

Three source trees inform the work, in descending order of authority:

- `../spiceport` — the design being ported. The file-for-file source.
- `../spicedb` — the Go original. Consult it when Spiceport's intent is unclear, and for the
  conformance corpus's provenance.
- `../orleans` — the runtime Spiceport targets. Consult it when a Thresh behaviour is in
  question and `../thresh/docs/deviations.md` does not settle it.

## The compatibility anchors

Three gates decide whether the port is correct. They are ordered by when they become runnable,
and none of them may be weakened to make something pass.

1. **The conformance corpus** (`packages/conformance/corpus`, copied verbatim from Spiceport's
   `TestData`) — schema + relationships + Check/Lookup assertions. Runnable from the moment the
   engine sits on the reference datastore, and run twice thereafter: once through the reference
   datastore, once through the grain mesh, with both required to agree.
2. **The differential suite** — seeded random worlds driven through both a real
   `authzed/spicedb` container and SpaceDB, asserting the verdicts agree. This is the only
   genuinely external oracle. It skips, never fails, without Docker.
3. **The `zed` CLI** — the real client against a booted host. Attended and manual; never
   invoked from the automated suite, because a backgrounded host can orphan and run forever.

## Layers

The port proceeds leaves-first along the dependency tree. Each stage ports its tests before its
implementation, and a stage is done only when its own tests pass — never when the code merely
compiles.

| Stage | Package                                            | Source                              | What it is                                                                                      |
| ----- | -------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| S1    | `@spacedb/core`                                    | `Spiceport.Core`                    | value types, tuple-string parsing, ZedTokens, revisions                                         |
| S1    | `@spacedb/schema`                                  | `Spiceport.Server/Schema`           | lexer, parser, compiler, AST                                                                    |
| S2    | `@spacedb/datastore`                               | `Spiceport.Datastore`               | the MVCC fold, filters, revision resolution, the reference datastore                            |
| S3    | `@spacedb/engine`                                  | `Spiceport.Server/Engine`           | Check, Expand, Lookup, reachability, caveats, the dispatcher seam                               |
| S4    | `@spacedb/grains`                                  | `Spiceport.Server/Grains`           | the Thresh mesh: the event-sourced datastore grain, graph shards, check grains, membership walk |
| S5    | `@spacedb/protos`, `@spacedb/api`, `@spacedb/silo` | `Spiceport.Protos`, `.Api`, `.Silo` | the `authzed.api.v1` gRPC surface and the host                                                  |

S1–S3 are pure: no Thresh surface at all, and the whole of the conformance corpus becomes
runnable at the end of S3. S4 is where Thresh is exercised as a runtime and where its bugs will
surface. S5 is a rewrite rather than a port — the gRPC hosting model has no C# analogue worth
transliterating, and only the request/response mapping carries across.

## What does not transliterate

Four things in the source have no mechanical translation and must be built deliberately:

- **CEL evaluation for caveats.** Spiceport uses the .NET `Cel` package; SpiceDB uses `cel-go`.
  SpaceDB uses `@bufbuild/cel`, which runs the official cel-spec conformance suite. The caveat
  conformance cases are the check on this.
- **The gRPC surface.** `@grpc/grpc-js` with `ts-proto` bindings generated from the vendored
  `authzed.api.v1` protos. Spiceport's `Authzed*V1Service` classes are pure translation over
  the grains, so what carries across is the mapping — including the deliberate error-code
  choices, which `zed` depends on.
- **Streaming.** Spiceport uses `IAsyncEnumerable` throughout the engine and the server-layer
  read helpers, but — checked, and important — never across a grain boundary: grain interfaces
  already use paged DTOs and explicit cursors. So async generators carry the in-process
  streaming across directly, and no Thresh feature is needed for it.
- **Dependency injection.** Orleans' container hides the object graph. Each package exposes one
  composition function that builds its graph explicitly, called by both the host and the tests.

## What Thresh needs

Two gaps in Thresh block the port, both surfaced by the event-sourced datastore grain. Both are
fixed in Thresh, test-first, before S4 — they are the point of SpaceDB being Thresh's first
production use case, not an obstacle to it.

- **`ICustomStorageInterface`.** Spiceport's `DatastoreGrain` is a `JournaledGrain` that owns
  its own persistence — per-version log rows, periodic snapshots, compaction — through a keyed
  grain-storage provider. Thresh's `LogViewAdaptorImpl` persists only through the
  `StateMachineManager` journal substrate, with no seam for a grain to supply its own
  read/append. Needs a custom-storage log-view adaptor.
- **Custom placement strategies.** `GraphLocalityPlacementDirector` places graph-shard grains
  for locality. Thresh's `placementStrategyFor` is a closed switch over five built-ins; the
  named-director registry exists for placement _filters_ but not for strategies.

## The per-file process

Every file goes through the same pipeline, and the pipeline is what makes the port repeatable:

1. **Order.** Extract the dependency graph of the stage's C# files and topologically sort it.
2. **Test first.** Port the covering test before the implementation, so the implementation has
   a failing test to satisfy rather than a compiler to satisfy.
3. **Transliterate.** Mechanical translation against
   [`../thresh/docs/orleans-to-thresh-port.md`](../../thresh/docs/orleans-to-thresh-port.md),
   which is the standing instruction for this step and is amended whenever the port teaches us
   something the guide did not say.
4. **Gate.** `pnpm typecheck` and the stage's own vitest project must pass. A file is not ported
   until its gate is green.
5. **Review.** A separate pass looks for the failure modes transliteration produces and
   compilation does not catch: record types used as `Map` keys, `int` overflow arithmetic,
   ordinal-vs-locale string comparison, reentrancy attributes dropped, `null`/`undefined` drift.

[`port-ledger.md`](port-ledger.md) records the source-to-target mapping for every file, so
"what is left" is a query rather than a judgement.
