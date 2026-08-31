# Running and packaging the hosts

How to start a host during development, what a deployable artifact would look like, and the one
invariant a host has to satisfy before it can be deployed at all.

## Running a host

```sh
pnpm --filter @spacedb/api start    # gRPC on 50051, plain GET / on 8080
pnpm --filter @spacedb/silo start   # silo only, no gRPC surface
```

Each host has a `src/start.ts` that calls its `main()` explicitly. That file exists because
`program.ts` ends in the usual entry-point guard — `process.argv[1] === fileURLToPath(import.meta.url)`
— which is correct for a compiled `node program.js`, and this repository never produces one:
`tsconfig.base.json` sets `noEmit`, every package exports its `.ts` sources
(`"exports": { "./*": "./src/*.ts" }`), and relative imports are extensionless, so the only thing
that can execute the tree is the SWC pipeline behind vitest / vite-node. Under vite-node
`process.argv[1]` is the vite-node CLI, so the guard is false and `main()` silently never runs.

The guard is deliberately left in place: it is what keeps an **import** of `program.ts` inert, which
is what stops a test booting a host. A backgrounded host orphans and runs forever, which is why
`CLAUDE.md` forbids starting one from a test or from CI.

A `zed` smoke test against a running host is attended and manual, with explicit teardown:

```sh
zed --endpoint localhost:50051 --token any --insecure schema read
zed --endpoint localhost:50051 --token any --insecure permission check document:readme view user:alice
```

The host seeds `document:readme#viewer@user:alice` and a schema whose `view` permission is
`viewer + editor`, so that check answers `true` and the same check for `user:bob` answers `false`.

## The shutdown invariant

**A host must release the event loop when it stops.** Not "close its listeners" — release the loop,
so the process actually exits. An orchestrator sends `SIGTERM` and waits out a grace period
(commonly 30s) before `SIGKILL`; a host that closes its ports but never exits burns that entire
period on every rollout and loses whatever was in flight.

This is easy to break, because nothing in the test suites can see it. Tests import modules; they do
not start processes, and the rule against booting a host from a test means they never will. The
invariant is only observable by running a host and signalling it.

`shutdownApiHost` and `shutdownSiloHost` are where each host honours it. Both:

- dispose the `LogWatchHub` **before** stopping the silo — disposal deletes the hub's object
  reference, which needs a runtime that has not gone away;
- run every step even when an earlier one throws, because a shutdown that gives up half way leaves
  exactly the orphan it exists to prevent.

The hub is the trap worth knowing about. `LogWatchHub` runs a heartbeat as a detached loop over a
real `setTimeout`, so an undisposed hub keeps the loop alive indefinitely: the signal handler runs to
completion, the silo stops, `main()` returns, and the process still does not exit. The hub's own
remarks call an orphaned heartbeat "the Node analogue of the orphaned-host hazard CLAUDE.md
forbids" — `dispose()` was always there, and for a while nothing called it.

**Anything added to a host that holds a timer, a socket, or a detached loop must be released here.**

## Packaging

There is no build. `pnpm typecheck` is `tsc --noEmit`, nothing emits JavaScript, and there is no
container image. A spike established that bundling works and what shape it should take.

The constraint that decides the shape is `@thresh/*`: it is unpublished and reached through
`link:../../../thresh/packages/*`, a relative path into a sibling checkout, so it can never be
installed at a deployment target. It has to be inlined. Publishing it instead would put a registry
between the two repositories, and the absence of one is currently load-bearing — SpaceDB exists to
surface Thresh bugs, and a Thresh fix taking effect here immediately is what makes that work.

So: **bundle, do not publish.** A vite SSR build with `unplugin-swc` produces a single file that
runs on plain `node`, with no vite, no TypeScript and no workspace. SWC must own the transformation:
esbuild and Oxc do not support the standard TC39 decorators the Thresh interop surface uses. Inline
`@spacedb/*` and `@thresh/*` via `ssr.noExternal`; leave real npm packages external, since they are
installable and bundling `pg` breaks its optional `pg-native` require. Import `defineConfig` from
`vitest/config` rather than `vite`, which is not a direct dependency under pnpm's strict layout.

Measured on the API host: 1,717 modules, 5.4 MB (1.04 MB gzip), ~330 ms. The artifact boots and
serves `zed` correctly — schema reads, checks, writes and lookups.

**A bundled artifact does not yet satisfy the shutdown invariant**, so no build is committed. It
closes its listening ports on `SIGTERM` and then stays alive, holding at least one handle beyond the
watch hub that has not been identified. The same source run under vite-node exits in about 2s, and a
bundled bare Thresh silo shuts down correctly, so the residue is specific to the bundled full host
rather than to bundling, to Thresh, to grpc-js or to the HTTP server. That gap is what stands between
this and a deployable image.
