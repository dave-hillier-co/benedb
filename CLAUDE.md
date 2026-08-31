# CLAUDE.md

Guidance for working in this repository. See [`README.md`](README.md) for what the project is,
[`docs/port-plan.md`](docs/port-plan.md) for how the port is structured,
[`docs/port-ledger.md`](docs/port-ledger.md) for the file-by-file source mapping, and
[`docs/packaging.md`](docs/packaging.md) for running a host and the shutdown invariant it must
satisfy.

## What this is

A wire-compatible SpiceDB implementation in TypeScript on **Thresh**, ported from
[Spiceport](../spiceport) (.NET 10 + Orleans). Four checkouts are in play, and which one
answers a question matters:

- `../spiceport` — **the source being ported.** The design authority. Port from here.
- `../thresh` — the virtual-actor runtime. BeneDB is its first production use case, so
  expect to find bugs in it; fixing them there is part of the work, not a detour.
- `../spicedb` — the Go original. Consult for intent when Spiceport is ambiguous.
- `../orleans` — consult when a Thresh behaviour is in question and
  [`../thresh/docs/deviations.md`](../thresh/docs/deviations.md) does not settle it.

## Build & test

```sh
pnpm install                      # links ../thresh into the workspace
pnpm test                         # unit suites (the `unit` vitest project)
pnpm test:conformance             # the SpiceDB conformance corpus
pnpm test:differential            # against a real spicedb container; skips without Docker
pnpm typecheck                    # tsc --noEmit over every package
pnpm lint                         # eslint + prettier
pnpm --filter @benedb/api start   # run a host; attended and manual, never from a test or CI
```

- **Use pnpm for dependency changes** (`pnpm add`, `pnpm --filter <pkg> add`). Do not hand-edit
  the `dependencies` blocks in `package.json`.
- Thresh is linked from the sibling checkout, so a change there takes effect here immediately —
  and a broken Thresh working tree breaks this build. Check `git -C ../thresh status` when
  something fails for no reason attributable to this repo.
- Regenerating `packages/protos/generated` needs `protoc` on PATH. The generated tree is not
  committed; the vendored `.proto` files are.

## Porting discipline

- **Port along the dependency tree, leaves first, tests before implementation.** A test that
  fails for its own reason is worth more than one that fails because a layer beneath it is
  missing. A file is ported when its test passes, not when it compiles.
- **[`../thresh/docs/orleans-to-thresh-port.md`](../thresh/docs/orleans-to-thresh-port.md) is
  the standing instruction for translation.** Its substitutions are not optional. When it does
  not cover a case, decide, then amend the guide — it is a living artifact of this port.
- **Transliterate; do not redesign.** Keep the same names, structure and order of operations as
  the C#. Spiceport's design decisions have already been paid for by its own test suite;
  re-litigating them in the port loses that.
- **Flag suspect Spiceport code; do not act on it.** Transliteration means reproducing a C# bug,
  not fixing it — but a suspicion noticed in passing should be recorded rather than absorbed.
  Raise it as an issue on `spiceport`, with the file and line, the input that shows it, and the
  consequence. The bar is "I traced this and it is wrong", not "this surprised me"; an unreachable
  one is still worth a line, marked unreachable. Do not go hunting: this is for what a file you had
  to read anyway reveals. `sourceConcerns` in the port-stage workflow is the collection point.
- **When the blocker is Thresh, fix Thresh.** Test-first, in that repo. Working around a Thresh
  limitation here hides the bug that BeneDB exists to surface.
- Record every source file's target in [`docs/port-ledger.md`](docs/port-ledger.md), so that
  "what is left" is a query rather than a judgement.

## Testing discipline

- **The conformance corpus is the compatibility anchor — a finite regression suite, not an
  oracle.** `packages/conformance/corpus/*.yaml` is copied verbatim from Spiceport and must
  stay green; it runs twice, once through the reference datastore and once through the grain
  mesh, and both must agree. Never weaken or skip a case to make something pass. Know its
  limits: it covers only the shapes its cases exercise, both runs share the same engine, and it
  tests one static snapshot — no MVCC, revision, or write-race behaviour.
- **The differential suite is the only external oracle.** It drives seeded random worlds through
  both a real `authzed/spicedb` container and BeneDB. It skips, never fails, without Docker.
- **Verify grains through Thresh's `TestCluster`**, not by booting a host.
- A real `zed`/`grpcurl` smoke test against a booted host is valuable but **attended and
  manual**, with explicit teardown. Never start a host from a test or from CI — a backgrounded
  host can orphan and run forever.
- Classic (sociable) TDD over mockist. Fake only at true boundaries: the network, Redis,
  Postgres, the clock.

## Conventions

- **No `index.ts` barrels.** One primary export per file; import from the specific module.
- Filenames are kebab-case; tests live beside their subject as `*.test.ts`.
- Prefer `interface` and `readonly` types over classes for data. Grains are written in the
  functional `defineGrain` style; the class + decorator form is an interop surface only.
- Discriminated unions with a literal `kind` field, plus a local `assertNever` in the default
  branch, wherever the C# pattern-matched a sealed hierarchy.
- Use `undefined`, not `null`, except where a wire format demands otherwise.
- Map errors to gRPC status codes deliberately — Spiceport's choices are load-bearing, because
  a wrong code makes `zed` retry or crash.

## House style (from the maintainer)

- No emojis. Semantic HTML in any web UI. Never `useMemo`.
- Don't write status updates (test counts, dates, "currently...") into committed docs — keep
  `README.md`, `CLAUDE.md` and `docs/` evergreen.
