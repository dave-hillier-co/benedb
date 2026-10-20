# The port

BeneDB is a wire-compatible SpiceDB implementation in TypeScript, built on
[Thresh](../../thresh). It is a port of [Spiceport](../../spiceport) — the .NET + Orleans
rearchitecture of SpiceDB — not of SpiceDB itself: Spiceport has already done the hard
translation from Go's hand-rolled dispatch layer to virtual actors, and that design carries
across unchanged. BeneDB is the same architecture in a different runtime.

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
   `authzed/spicedb` container and BeneDB, asserting the verdicts agree. This is the only
   genuinely external oracle. It skips, never fails, without Docker.
3. **The `zed` CLI** — the real client against a booted host. Attended and manual; never
   invoked from the automated suite, because a backgrounded host can orphan and run forever.

## Layers

The port proceeds leaves-first along the dependency tree. Each stage ports its tests before its
implementation, and a stage is done only when its own tests pass — never when the code merely
compiles.

| Stage | Package                                         | Source                              | What it is                                                                                      |
| ----- | ----------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| S1    | `@benedb/core`                                  | `Spiceport.Core`                    | value types, tuple-string parsing, ZedTokens, revisions                                         |
| S1    | `@benedb/schema`                                | `Spiceport.Server/Schema`           | lexer, parser, compiler, AST                                                                    |
| S2    | `@benedb/datastore`                             | `Spiceport.Datastore`               | the MVCC fold, filters, revision resolution, the reference datastore                            |
| S3    | `@benedb/engine`                                | `Spiceport.Server/Engine`           | Check, Expand, Lookup, reachability, caveats, the dispatcher seam                               |
| S4    | `@benedb/grains`                                | `Spiceport.Server/Grains`           | the Thresh mesh: the event-sourced datastore grain, graph shards, check grains, membership walk |
| S5    | `@benedb/protos`, `@benedb/api`, `@benedb/silo` | `Spiceport.Protos`, `.Api`, `.Silo` | the `authzed.api.v1` gRPC surface and the host                                                  |

S1–S3 are pure: no Thresh surface at all, and the whole of the conformance corpus becomes
runnable at the end of S3. S4 is where Thresh is exercised as a runtime and where its bugs will
surface. S5 is a rewrite rather than a port — the gRPC hosting model has no C# analogue worth
transliterating, and only the request/response mapping carries across.

## What does not transliterate

Four things in the source have no mechanical translation and must be built deliberately:

- **CEL evaluation for caveats.** Spiceport uses the .NET `Cel` package; SpiceDB uses `cel-go`.
  BeneDB uses `@bufbuild/cel`, which runs the official cel-spec conformance suite. The caveat
  conformance cases are the check on this. Schema-write compilation (parse and static type check
  of a caveat body) parses with the same `@bufbuild/cel` parser and type-checks its canonical
  `cel.expr.Expr` with a checker transliterated from Spiceport's, so a type error carries
  cel-go's message, line, column and caret. `packages/schema/src/cel-parsed-expr.ts` converts
  that parse into the tree cel-go's parser builds: `@bufbuild/cel` keeps no source positions
  through its public API (they are recovered by walking the tree over the expression's tokens),
  folds `!(!x)` and `-(-x)` to `x`, parses `&&`/`||` chains as one call, drops a leading dot from
  a name, and expands macros differently, and each of those is undone. Its lexer also cannot end
  the input inside a `//` comment, which matters because a caveat body is stored trimmed and so
  can end in one; both the schema-write compile and evaluation parse the text with a newline
  appended, which ends the comment and is otherwise whitespace. What is not undone is the
  grammar itself, and these are deliberate divergences from SpiceDB:
  - A syntax error carries `@bufbuild/cel`'s message and position (for `x > > 0`, "found > but
    expecting end of input" at the first `>`), not cel-go's ANTLR wording. A reserved
    identifier, a misused macro and an out-of-range literal are reported with cel-go's message at
    cel-go's position.
  - `@bufbuild/cel` is lenient with escape sequences: `"a\q"` is accepted where cel-go rejects
    it. It also accepts a list of bare commas (`[,]`).
  - `@bufbuild/cel` rejects some expressions cel-go parses: the optional syntax (`a.?b`,
    `a[?b]`, `[?a]`, `{?k: v}`, `Msg{?f: v}`), a `0X` hex prefix, an `rb` bytes prefix, a
    triple-quoted string spanning lines, and repeated unary operators separated by a space
    (`! !a`). Each is a syntax error at schema write here, and a type-checked caveat in SpiceDB.
    The optional functions (`optional.of`, `hasValue`, `orValue`, `optMap`, ...) are unaffected.

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
fixed in Thresh, test-first, before S4 — they are the point of BeneDB being Thresh's first
production use case, not an obstacle to it.

- **Durable journaled grains, and storage the host does not choose.** Spiceport's
  `DatastoreGrain` is a `JournaledGrain` over Orleans' state-storage log-consistency provider, and
  its shard and index grains persist their projections through a named grain-storage provider.
  Thresh persists a journaled grain through its `StateMachineManager` journal substrate, so it
  needs durable journal providers (Postgres, Redis), a conditional append that never applies an
  event its caller was told failed, and a storage backend that serves every provider name a silo
  uses — so BeneDB names its providers and never picks a database.
- **Custom placement strategies.** `GraphLocalityPlacementDirector` places graph-shard grains
  for locality. Thresh's `placementStrategyFor` is a closed switch over five built-ins; the
  named-director registry exists for placement _filters_ but not for strategies.

The sequencer's write scaling follows Spiceport's staged plan
([`../spiceport/docs/transaction-system.md`](../../spiceport/docs/transaction-system.md)), one
stage at a time and only once Spiceport has built it. Group commit needs Thresh to write a
confirm's pending events in one journal append (`raiseConditionalEvents`), and a `BatchWorker` for
the sequencer's single writer. The fault-injection harness (`packages/grains/src/fault-harness.ts`)
needs Thresh's `TestCluster.migrate`, to put the sequencer on the silo it is about to kill. From
the version-only
sequencer onward the plan builds a general transactional key-value layer; when it is ported, that
generic half is Thresh's, and BeneDB keeps only the SpiceDB layer over it.

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
