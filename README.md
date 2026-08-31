# BeneDB

A wire-compatible [SpiceDB](https://github.com/authzed/spicedb) implementation in TypeScript,
built on [Thresh](https://github.com/dave-hillier/thresh) — a TypeScript virtual-actor runtime
in the Orleans model, hosted on Kubernetes.

BeneDB answers the [Zanzibar](https://authzed.com/zanzibar) question — _"can subject X perform
action Y on resource Z?"_ — from a relationship graph defined by a schema, and runs the
recursive permission-check dispatch on Thresh grains. It speaks the `authzed.api.v1` gRPC
protocol, so the official [`zed`](https://github.com/authzed/zed) CLI and SpiceDB clients work
against it.

It is a port of [Spiceport](../spiceport), the .NET + Orleans rearchitecture of SpiceDB, rather
than of SpiceDB itself: Spiceport has already made the translation from Go's hand-rolled
dispatch layer — consistent-hash routing, singleflight coalescing, cluster membership — to
virtual actors, where the runtime provides all three natively. BeneDB is that architecture in
a different runtime. See [`docs/port-plan.md`](docs/port-plan.md).

The name keeps SpiceDB's Dune reference and moves it from the spice to the Bene Gesserit, who
decide who may do what.

## Layout

```
packages/
  core          value types, tuple-string parsing, revisions and ZedTokens
  schema        the schema DSL: lexer -> parser -> compiler
  datastore     the MVCC state model and the reference datastore
  engine        Check / Expand / Lookup, reachability, caveats, the dispatcher seam
  grains        the Thresh mesh: event-sourced datastore, graph shards, check grains
  protos        vendored authzed.api.v1 contracts and their generated bindings
  api           the gRPC surface
  silo          the standalone host
  conformance   the SpiceDB conformance corpus and its runner
  differential  seeded differential tests against a real spicedb container
```

## Develop

A [pnpm](https://pnpm.io) workspace of `@benedb/*` packages. Requires Node 22+, pnpm, and a
sibling checkout of Thresh at `../thresh` — the workspace links to it directly so that fixes to
Thresh are visible here without a release.

```sh
pnpm install                      # install, and link ../thresh
pnpm test                         # unit suites
pnpm test:conformance             # the SpiceDB conformance corpus
pnpm test:differential            # against a real spicedb container (skips without Docker)
pnpm typecheck
pnpm lint
```

Regenerating the gRPC bindings needs `protoc` on PATH:

```sh
pnpm --filter @benedb/protos generate
```
