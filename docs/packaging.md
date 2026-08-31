# Running and packaging the hosts

How to start a host during development, what a deployable artifact would look like, and the one
invariant a host has to satisfy before it can be deployed at all.

## Running a host

```sh
pnpm --filter @benedb/api start    # gRPC on 50051, plain GET / on 8080
pnpm --filter @benedb/silo start   # silo only, no gRPC surface
```

Each host has a `src/start.ts` that calls its `main()` explicitly, and `program.ts` has **no
module-scope invocation at all**. That split matters, and the obvious alternative is wrong in both
directions.

The C# runs `Program.cs` as top-level statements, so the natural port is a
`process.argv[1] === fileURLToPath(import.meta.url)` guard at the end of the module — the standard
"am I the entry point" idiom, correct for a compiled `node program.js`. This repository never
produces one: `tsconfig.base.json` sets `noEmit`, every package exports its `.ts` sources
(`"exports": { "./*": "./src/*.ts" }`), and relative imports are extensionless, so the only thing
that can execute the tree is the SWC pipeline behind vitest / vite-node. There, `argv[1]` is the
vite-node CLI, the guard never matches, and `main()` silently never runs — the module loads, does
nothing, and the process exits 0.

Bundled, the guard fails the other way. Everything is inlined into one file, so `import.meta.url`
and `argv[1]` are **both that file**: the guard fires during module evaluation, and `start.ts`'s own
call then starts a **second host** once the first returns. The symptom is an artifact that shuts
down on `SIGTERM` and immediately comes back up serving, needing a second signal to die.

So the invocation is explicit and singular. Importing `program.ts` starts nothing **by
construction** rather than by a heuristic a bundler defeats — which is the property that stops a
test booting a host. A backgrounded host orphans and runs forever, which is why `CLAUDE.md` forbids
starting one from a test or from CI.

A `zed` smoke test against a running host is attended and manual, with explicit teardown:

```sh
zed --endpoint localhost:50051 --token any --insecure schema read
zed --endpoint localhost:50051 --token any --insecure permission check document:readme view user:alice
```

The host seeds `document:readme#viewer@user:alice` and a schema whose `view` permission is
`viewer + editor`, so that check answers `true` and the same check for `user:bob` answers `false`.

## Clustering

With nothing configured, each host is a **single-process silo**: static membership over itself and
Thresh's in-process transport, needing no external dependency and no configuration. That is what
`UseLocalhostClustering()`'s no-argument form is for, and it is what both `pnpm --filter ... start`
commands above give you.

Several silos in one cluster is opt-in, through the same `Configuration` object the datastore
storage config reads — .NET's rules, so every key has an `A:B` form and an `A__B` environment form,
and both are case-insensitive.

| Key                               | Default     | Meaning                                                                                                          |
| --------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `Clustering:Silos`                | _unset_     | Comma-separated `host:port` list covering the **whole** cluster, this silo included. Its presence is the switch. |
| `Clustering:SiloPort`             | `11111`     | This silo's listen and advertise port.                                                                           |
| `Clustering:AdvertisedHost`       | `127.0.0.1` | This silo's bind host **and** the host peers dial back.                                                          |
| `Clustering:AllowInMemoryStorage` | `false`     | Accept a clustered silo whose datastore state is per-silo and disposable.                                        |
| `Api:GrpcPort`                    | `50051`     | API host only: the port of the gRPC surface.                                                                     |
| `Api:HttpPort`                    | `8080`      | API host only: the port of the plain `GET /` listener.                                                           |

Two silos on one machine — an API host and a silo-only host, in two terminals:

```sh
Clustering__Silos=127.0.0.1:11111,127.0.0.1:11112 \
Clustering__AllowInMemoryStorage=true \
  pnpm --filter @benedb/api start

Clustering__Silos=127.0.0.1:11111,127.0.0.1:11112 \
Clustering__SiloPort=11112 \
Clustering__AllowInMemoryStorage=true \
  pnpm --filter @benedb/silo start
```

Every clustered silo needs the storage opt-in or a connection string, this one included:
`resolveClustering` throws before the silo is built otherwise. A cluster that is to keep its data
sets `ConnectionStrings__OrleansStorage` on **both** and drops the opt-in. Start the silo-only host
**first** — static membership reports every configured peer `active` immediately, so the API host's
startup seed can be placed on a peer that is not listening yet.

The second silo changes **one** variable. A clustered silo's whole identity — its name, its uid and
its ring position — is derived from `AdvertisedHost:SiloPort`, so moving the port moves all three
and a collision is impossible by construction. That derivation is also why the silo list is
identical on every host: each silo must reconstruct its peers' addresses bit-identically to how
those peers construct their own, or a silo's entry in the shared view differs from its own address
and it dials itself over the wire. It is also why there is no silo-name knob — a name only one
silo's environment sets is a name its peers cannot derive.

**Every silo gets the whole list.** Orleans' nearest counterpart,
`UseLocalhostClustering(siloPort, gatewayPort, primarySiloEndpoint)`, gossips through a _primary_
endpoint, so a joiner needs only that one address. Thresh has no development or gossip membership
provider; `useStaticMembership` takes the entire view. A `Clustering:PrimarySilo` key becomes
possible only if Thresh grows one.

**Static membership has no join/leave protocol.** Every configured peer is reported `active` from
the moment a silo starts, so a grain placed on a peer that has not come up yet fails or times out
until it does — start order matters — and a stopped silo is never removed from the view. That is
inherent to static membership and is why `useKubernetesMembership` is the production path; under
Kubernetes the pod IP satisfies both halves of `AdvertisedHost` at once.

**MVCC garbage collection does not survive clustering.** The datastore grain registers the
`mvcc-gc` reminder through the default per-silo reminder table, while `LocalReminderService` fires
only reminders whose grain hashes into the ranges that silo owns on the ring. The registering silo
and the owning silo coincide only by chance, so in a cluster the reminder can stop firing and MVCC
history is never collected. Re-registering on activation does not help — registering and firing are
keyed on different silos. Closing it means a shared table (`usePostgresReminders`), which is not
wired yet.

**A dead silo wedges the cluster.** `useStaticMembership` has no failure detection, so calls keep
routing to a silo that has exited and the caller hangs rather than failing — `zed` sees no error to
retry. Observed directly: killing one silo left a check that had just answered `true` hanging
indefinitely.

**A real multi-silo deployment needs durable grain storage.** The datastore grain is a _cluster
singleton_ over the `datastore` grain-storage provider, and that provider's fallback branch
constructs a `MemoryGrainStorage` **per silo**. The grain declares no placement, so after an idle
deactivation it reactivates on an arbitrary silo and reads an empty store: not merely non-durable
across restarts, but silent data loss during normal operation. So a clustered silo with no
`ConnectionStrings:OrleansStorage` refuses to configure, naming the key, unless
`Clustering__AllowInMemoryStorage=true` says out loud that the state is disposable. Pointing that
connection string at Postgres is sufficient — the grain's confirmed log rides the custom-storage
seam over the same named provider, so `useMemoryJournaling()` carries no state of its own.

A clustered host binds a real WebSocket listener, so `ws` must be present at the deployment target
(see the packaging note below about real npm packages being left external to the bundle).

Verifying a real socket-level cluster is an **attended, manual** check, like the `zed` smoke test:
start the two hosts above in two terminals, drive the API host with `zed`, and signal both. Nothing
automated ever starts a host. Multi-silo behaviour that _can_ be tested is tested through Thresh's
`TestCluster` (`MeshTestCluster`), which runs several silos in one process.

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
between the two repositories, and the absence of one is currently load-bearing — BeneDB exists to
surface Thresh bugs, and a Thresh fix taking effect here immediately is what makes that work.

So: **bundle, do not publish.** A vite SSR build with `unplugin-swc` produces a single file that
runs on plain `node`, with no vite, no TypeScript and no workspace. SWC must own the transformation:
esbuild and Oxc do not support the standard TC39 decorators the Thresh interop surface uses. Inline
`@benedb/*` and `@thresh/*` via `ssr.noExternal`; leave real npm packages external, since they are
installable and bundling `pg` breaks its optional `pg-native` require. `ws` is external for the same
reason and is not optional for a clustered host — `useWebSocketTransport()` needs it at runtime. Import `defineConfig` from
`vitest/config` rather than `vite`, which is not a direct dependency under pnpm's strict layout.

Measured on the API host: 1,717 modules, 5.4 MB (1.04 MB gzip), ~330 ms. The artifact boots and
serves `zed` correctly — schema reads, checks, writes and lookups.

A bundled artifact satisfies the shutdown invariant: it boots, serves, and exits about 2s after a
single `SIGTERM`. No build is committed all the same — a build path with no deployment target rots,
and nothing would exercise it. When there is somewhere to deploy, this is the shape to build, and
the artifact should be smoke-tested the way a host is: start it, drive it with `zed`, signal it
once, and check the process is gone.

Two failure modes to re-check whenever host wiring changes, because both were live at once and each
masks the other: a handle that outlives shutdown (the process closes its ports and lingers), and a
double `main()` (the process shuts down and comes straight back up).
