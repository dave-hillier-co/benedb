import { ELLIPSIS } from "@benedb/core/core-constants";
import type { IRevision } from "@benedb/core/i-revision";
import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import { createRelationship, type Relationship } from "@benedb/core/relationship";
import { TimestampRevision } from "@benedb/core/timestamp-revision";
import { formatRelationship } from "@benedb/core/tuple-strings";
import { RevisionNotFoundException } from "@benedb/datastore/datastore-exceptions";
import type { IDatastoreReader } from "@benedb/datastore/i-datastore";
import { ReferenceDatastore } from "@benedb/datastore/reference-datastore";
import type { RelationshipsFilter } from "@benedb/datastore/relationships-filter";
import { createSeededRandom, type SeededRandom } from "@benedb/engine/seeded-random";
import type { Duration } from "@thresh/core/duration";
import type { GrainId } from "@thresh/core/grain-id";
import { IManagementGrain } from "@thresh/core/management-grain";
import { MemoryJournalStorage } from "@thresh/journaling/memory-journal-storage";
import { MemoryGrainStorage } from "@thresh/persistence/memory-grain-storage";
import { TestCluster, type TestSiloHandle } from "@thresh/testing/test-cluster";

import type {
  CommitPreconditionWire,
  CommitReply,
  CommitRequest,
  DeleteByFilterWire,
} from "./commit-contract";
import type { DatastoreGcOptions } from "./datastore-gc-options";
import {
  FaultInjectingGrainStorage,
  FaultInjectingJournal,
  isInjectedFault,
  storageFaults,
} from "./fault-injecting-storage";
import { GrainBackedDatastore } from "./grain-backed-datastore";
import { DATASTORE_GRAIN_KEY, IDatastoreGrain } from "./i-datastore-grain";
import type { LogSegment } from "./log-event";
import { applyReferenceCommit } from "./reference-commit";
import type { RelationshipUpdateWire } from "./relationships-dtos";
import {
  addSpiceportGrainServices,
  SPICEPORT_GRAIN_REGISTRATIONS,
  type SpiceportGrainServices,
} from "./service-collection-extensions";
import { toCoreFilter, toFullFilter, toWire } from "./wire-convert";

/** One harness run: `seed` fixes every choice, `steps` its length. */
export interface FaultHarnessOptions {
  readonly seed: number;
  readonly steps: number;
  /** Plants a lost-write bug in storage, for the harness's own gate. */
  readonly loseShardWrites?: boolean | undefined;
  /** The number of silos in the cluster (default 1). */
  readonly silos?: number | undefined;
  /** Hard-kills non-primary silos at seeded points, always leaving the primary and one other. */
  readonly killSilos?: boolean | undefined;
  /** When set, runs GC rounds at seeded points under this retention window. */
  readonly gcWindow?: Duration | undefined;
}

/**
 * A completed run: the trace (one line per step and per commit outcome, independent of timing), how
 * many injected write failures actually fired (as opposed to being armed), how many silos were
 * killed and how many of those held the sequencer's activation, and how many GC rounds advanced the
 * floor.
 */
export interface FaultHarnessRun {
  readonly trace: readonly string[];
  readonly sequencerFaultsFired: number;
  readonly shardFaultsFired: number;
  readonly silosKilled: number;
  readonly sequencerKills: number;
  readonly gcRounds: number;
}

/** The real system and the reference disagreed. The message names the seed and the trace. */
export class FaultHarnessDivergenceError extends Error {
  override readonly name = "FaultHarnessDivergenceError";
}

const SCHEMA = "definition user {}\n\ndefinition doc {\n    relation viewer: user\n}";
const DOCS = ["d0", "d1", "d2", "d3", "d4", "d5"] as const;
const USERS = ["u0", "u1", "u2", "u3", "u4"] as const;
const CALL_TIMEOUT_MS = 30_000;
const MAX_INT = 2 ** 31 - 1;

/**
 * The deterministic fault-injection harness, ported from Spiceport's `FaultHarness`. A seeded
 * workload of declarative commits (touches, creates, deletes, preconditions, delete-by-filter) runs
 * against the real sequencer and shard mesh in a `TestCluster`, sequentially and in concurrent
 * groups, with sequencer and shard-projection write failures, explicit projection flushes and
 * whole-cluster deactivations injected at seeded points, and optionally hard silo kills and GC
 * rounds. Every commit is replayed against `ReferenceDatastore` in the order the sequencer assigned
 * and must reach the same outcome; reads through the shard mesh at every committed revision must
 * return what the reference returns at the matching revision.
 *
 * The seed fixes the workload and the fault schedule, not the scheduling of the silos' work:
 * concurrent commits in one group touch disjoint resources, so every outcome is the same whatever
 * order the sequencer gives them, and the trace (which records outcomes, never revisions or timings)
 * reproduces exactly. Kills and GC rounds happen between steps, never under an in-flight call, so no
 * commit's outcome is ever unknown. Reads compare only at revisions at or above the GC floor.
 *
 * Port decisions: the C# `SharedMemoryGrainStorage` has no counterpart, because the stores here are
 * plain objects every in-process silo is handed, so a killed silo already loses only its
 * activations. Killed silos are not replaced, as in the C#, which avoids a zombie-silo failure that
 * Orleans has and Thresh does not; the cluster simply shrinks. Every call goes from the primary
 * silo, which is never killed.
 */
export async function runFaultHarness(options: FaultHarnessOptions): Promise<FaultHarnessRun> {
  storageFaults.reset();
  storageFaults.loseShardWrites = options.loseShardWrites ?? false;
  const stores = {
    storage: new FaultInjectingGrainStorage(new MemoryGrainStorage()),
    journal: new FaultInjectingJournal(new MemoryJournalStorage()),
  };
  const gcOptions: DatastoreGcOptions | undefined =
    options.gcWindow === undefined
      ? undefined
      : { window: options.gcWindow, reminderEnabled: false };
  const services = new Map<number, SpiceportGrainServices>();
  const cluster = await TestCluster.start({
    initialSilos: options.silos ?? 1,
    grains: SPICEPORT_GRAIN_REGISTRATIONS,
    configureSilo: (builder, silo) => {
      builder.addStorage("datastore", stores.storage);
      builder.useMemoryJournaling(stores.journal);
      let datastore: GrainBackedDatastore | undefined;
      const siloServices: SpiceportGrainServices = addSpiceportGrainServices(builder, {
        schemaText: SCHEMA,
        datastore: () =>
          (datastore ??= new GrainBackedDatastore(
            siloServices.grainFactory,
            siloServices.hub,
            undefined,
            undefined,
            gcOptions,
          )),
        ...(gcOptions !== undefined ? { datastoreGcOptions: gcOptions } : {}),
      });
      services.set(silo.index, siloServices);
    },
  });
  try {
    const run = new Run(options, cluster, services.get(cluster.primary.index)!);
    await run.execute();
    return {
      trace: run.trace,
      sequencerFaultsFired: storageFaults.injectedSequencerFaults,
      shardFaultsFired: storageFaults.injectedShardFaults,
      silosKilled: run.silosKilled,
      sequencerKills: run.sequencerKills,
      gcRounds: run.gcRounds,
    };
  } finally {
    storageFaults.reset();
    await cluster.dispose();
  }
}

interface HarnessCommit {
  readonly description: string;
  readonly request: CommitRequest;
}

class Run {
  readonly trace: string[] = [];
  silosKilled = 0;
  sequencerKills = 0;
  gcRounds = 0;

  readonly #options: FaultHarnessOptions;
  readonly #cluster: TestCluster;
  readonly #primary: SpiceportGrainServices;
  readonly #rng: SeededRandom;
  readonly #reference = new ReferenceDatastore();
  readonly #revisions: bigint[] = [];
  readonly #referenceAt = new Map<bigint, IRevision>();
  readonly #metadataAt = new Map<bigint, Uint8Array | undefined>();
  #commitsGenerated = 0;
  #gcFloor = 0n;

  constructor(options: FaultHarnessOptions, cluster: TestCluster, primary: SpiceportGrainServices) {
    this.#options = options;
    this.#cluster = cluster;
    this.#primary = primary;
    this.#rng = createSeededRandom(options.seed);
  }

  private get sequencer(): IDatastoreGrain {
    return this.#primary.grainFactory.getGrain(IDatastoreGrain, DATASTORE_GRAIN_KEY);
  }

  private get management(): IManagementGrain {
    return this.#primary.grainFactory.getGrain(IManagementGrain, 0n);
  }

  async execute(): Promise<void> {
    const head = await this.call(this.sequencer.getHead());
    this.record(head.head, (await this.#reference.headRevision()).revision);

    // Every run injects each fault at least once, at seeded positions; the rest of the schedule is
    // drawn step by step.
    const steps = this.#options.steps;
    const sequencerFaultAt = this.#rng.next(steps);
    const shardFaultAt = this.#rng.next(steps);
    const deactivateAt = this.#rng.next(steps);
    const killAt = this.#options.killSilos === true ? this.#rng.next(steps) : -1;
    const gcAt =
      this.#options.gcWindow === undefined
        ? -1
        : Math.floor(steps / 2) + this.#rng.next(steps - Math.floor(steps / 2));

    for (let step = 0; step < steps; step += 1) {
      const roll = this.#rng.nextDouble();
      const extra = this.#rng.nextDouble();
      // Random kills leave a silo for the seeded kill that takes the sequencer down.
      if (step === killAt && this.#cluster.silos.length > 2) await this.killSilo(true);
      else if (this.#options.killSilos === true && extra < 0.04 && this.#cluster.silos.length > 3)
        await this.killSilo(false);

      if (step === gcAt || (this.#options.gcWindow !== undefined && extra > 0.9))
        await this.runGc();

      if (step === sequencerFaultAt || (step !== shardFaultAt && roll < 0.06)) {
        this.trace.push("fault sequencer-write");
        storageFaults.failSequencerWrites = 1;
        await this.commitStep();
      } else if (step === shardFaultAt || roll < 0.12) {
        this.trace.push("fault shard-write");
        storageFaults.failShardWrites = 1;
        await this.flush();
      } else if (step === deactivateAt || roll < 0.18) {
        await this.deactivateAll(true);
      } else if (roll < 0.25) {
        await this.flush();
      } else if (roll < 0.45) {
        await this.groupStep();
      } else {
        await this.commitStep();
      }

      // A fault armed for this step never leaks into a later one.
      storageFaults.failSequencerWrites = 0;
      storageFaults.failShardWrites = 0;
      await this.spotCheck();
      await this.checkLogMetadata();
    }

    // A shard-projection failure that certainly fires: one more commit leaves events pending, so the
    // flush has shards to write. Then recovery from storage alone: project everything, drop every
    // activation, and compare every resource at every committed revision and every subject at a
    // sample of them.
    await this.commitStep();
    this.trace.push("fault shard-write");
    storageFaults.failShardWrites = 1;
    await this.flush();
    storageFaults.failShardWrites = 0;
    await this.flush();
    this.trace.push("deactivate (final)");
    await this.deactivateAll(false);
    for (let i = 0; i < this.#revisions.length; i += 1) {
      for (const doc of DOCS) await this.checkResource(i, doc);
      if (i % 5 === 0 || i === this.#revisions.length - 1) {
        for (const user of USERS) await this.checkSubject(i, user);
      }
    }
  }

  private async commitStep(): Promise<void> {
    const commit = this.nextCommit(DOCS[this.#rng.next(DOCS.length)]!);
    const reply = await this.call(this.sequencer.commit(commit.request));
    await this.reconcile([{ commit, reply }]);
  }

  /**
   * Two to four commits on distinct resources, issued together so the sequencer can batch them,
   * with a read at an already committed revision racing them.
   */
  private async groupStep(): Promise<void> {
    const docs = this.shuffled(DOCS).slice(0, 2 + this.#rng.next(3));
    const commits = docs.map((doc) => this.nextCommit(doc));
    this.trace.push(`group of ${commits.length}`);

    const readAt = this.#rng.next(this.#revisions.length);
    const readDoc = DOCS[this.#rng.next(DOCS.length)]!;
    const racingRead = this.checkResource(readAt, readDoc);
    const replies = await this.call(
      Promise.all(commits.map((c) => this.sequencer.commit(c.request))),
    );
    await racingRead;
    await this.reconcile(commits.map((commit, i) => ({ commit, reply: replies[i]! })));
  }

  private async flush(): Promise<void> {
    this.trace.push("flush");
    try {
      await this.call(this.sequencer.flushProjection());
    } catch (error) {
      // The injected failure; the events stay pending and a later flush projects them.
      if (!isInjectedFault(error)) throw error;
    }
  }

  private async deactivateAll(record: boolean): Promise<void> {
    if (record) this.trace.push("deactivate");
    await this.call(this.management.forceActivationCollection({ ms: 0 }));
  }

  /**
   * Hard-kills a non-primary silo, whatever activations it held, and waits until the sequencer
   * answers again. With `withSequencer`, the sequencer is first migrated onto the victim, so the kill
   * takes the serialization point down with it.
   */
  private async killSilo(withSequencer: boolean): Promise<void> {
    this.trace.push(withSequencer ? "kill silo with the sequencer" : "kill silo");
    const others = this.#cluster.silos.filter((s) => s !== this.#cluster.primary);
    const victim: TestSiloHandle = others[this.#rng.next(others.length)]!;
    if (withSequencer) {
      // Migration completes once the activation is idle, so wait to see it land.
      await this.call(this.sequencer.getHead());
      const id = await this.sequencerId();
      await this.call(this.#cluster.migrate(id, victim.address));
      const migrateBy = Date.now() + CALL_TIMEOUT_MS;
      while (!(await this.sequencerOn(victim))) {
        if (Date.now() > migrateBy)
          this.diverge("the sequencer did not migrate onto the silo chosen to kill");
        await this.call(this.sequencer.getHead());
        await delay(50);
      }
    }

    if (await this.sequencerOn(victim)) this.sequencerKills += 1;
    await this.#cluster.killSilo(victim);
    this.silosKilled += 1;

    // getHead is a pure read, so retrying it while the cluster forgets the dead silo is safe.
    const deadline = Date.now() + CALL_TIMEOUT_MS;
    for (;;) {
      try {
        await withTimeout(this.sequencer.getHead(), 5_000);
        return;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await delay(100);
      }
    }
  }

  private async sequencerId(): Promise<GrainId> {
    const address = await this.call(this.management.getActivationAddress(this.sequencer));
    if (address === null) this.diverge("the sequencer has no activation to migrate");
    return address!.grainId;
  }

  private async sequencerOn(silo: TestSiloHandle): Promise<boolean> {
    const address = await this.call(this.management.getActivationAddress(this.sequencer));
    return address !== null && address.silo.equals(silo.address);
  }

  private async runGc(): Promise<void> {
    this.trace.push("gc");
    const floor = await this.call(this.sequencer.runGc());
    if (floor !== undefined) {
      this.#gcFloor = floor;
      this.gcRounds += 1;
    }
  }

  /**
   * Replays the step's commits against the reference in the order the sequencer committed them
   * (rejections last: they touch disjoint resources, so their position cannot matter), checking
   * each reaches the same outcome.
   */
  private async reconcile(
    results: readonly { readonly commit: HarnessCommit; readonly reply: CommitReply }[],
  ): Promise<void> {
    const ordered = [...results].sort((a, b) =>
      compareRevision(a.reply.revision, b.reply.revision),
    );
    for (const { commit, reply } of ordered) {
      const expected = await applyReferenceCommit(this.#reference, commit.request);
      if (outcome(reply) !== outcome(expected.reply)) {
        this.diverge(
          `commit ${commit.description}: sequencer replied ${outcome(reply)}, ` +
            `reference ${outcome(expected.reply)}`,
        );
      }
      if (reply.revision !== undefined) {
        this.record(reply.revision, expected.revision!);
        this.#metadataAt.set(reply.revision, commit.request.transactionMetadata);
      }
    }

    // Trace in generation order, so concurrent completion order never shows.
    for (const { commit, reply } of results)
      this.trace.push(`commit ${commit.description} -> ${outcome(reply)}`);
  }

  private async spotCheck(): Promise<void> {
    const latest = this.#revisions.length - 1;
    await this.checkResource(latest, DOCS[this.#rng.next(DOCS.length)]!);
    await this.checkSubject(latest, USERS[this.#rng.next(USERS.length)]!);
    await this.checkResource(
      this.#rng.next(this.#revisions.length),
      DOCS[this.#rng.next(DOCS.length)]!,
    );
  }

  /**
   * The log's retained tail must carry, on every commit's event, exactly the transaction metadata
   * that commit submitted - whatever faults, flushes and reactivations came before. The oldest
   * servable cursor (the projection boundary or the GC floor, whichever is higher) is found by
   * bisecting the committed revisions, since servability is monotone in the cursor.
   */
  private async checkLogMetadata(): Promise<void> {
    const tryRead = async (cursor: bigint): Promise<LogSegment | undefined> => {
      try {
        return await this.call(this.sequencer.readFrom(cursor, -1));
      } catch (error) {
        if (error instanceof RevisionNotFoundException) return undefined;
        throw error;
      }
    };

    const last = await tryRead(this.#revisions[this.#revisions.length - 1]!);
    if (last === undefined) return; // projected or collected through the newest commit
    let lo = 0;
    let hi = this.#revisions.length - 1;
    let segment = last;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const read = await tryRead(this.#revisions[mid]!);
      if (read !== undefined) {
        hi = mid;
        segment = read;
      } else {
        lo = mid + 1;
      }
    }

    const show = (metadata: Uint8Array | undefined): string =>
      metadata === undefined ? "none" : new TextDecoder().decode(metadata);
    for (const ev of segment.events) {
      if (ev.gcFloor !== undefined) continue;
      if (!this.#metadataAt.has(ev.revision))
        this.diverge(
          `the log holds a commit event at ${ev.revision} that no commit was told it minted`,
        );
      const expected = this.#metadataAt.get(ev.revision);
      const actual = ev.transactionMetadata;
      const matches =
        expected === undefined
          ? actual === undefined
          : actual !== undefined && Buffer.from(actual).equals(Buffer.from(expected));
      if (!matches) {
        this.diverge(
          `the log's event at ${ev.revision} carries transaction metadata [${show(actual)}], ` +
            `its commit submitted [${show(expected)}]`,
        );
      }
    }
  }

  private checkResource(revisionIndex: number, doc: string): Promise<void> {
    return this.compare(revisionIndex, `resource doc:${doc}`, (reader) =>
      reader.queryRelationships({ optionalResourceType: "doc", optionalResourceIds: [doc] }),
    );
  }

  private checkSubject(revisionIndex: number, user: string): Promise<void> {
    return this.compare(revisionIndex, `subject user:${user}`, (reader) =>
      reader.reverseQueryRelationships({ subjectType: "user", optionalSubjectIds: [user] }),
    );
  }

  private async compare(
    revisionIndex: number,
    what: string,
    query: (reader: IDatastoreReader) => AsyncIterable<Relationship>,
  ): Promise<void> {
    const revision = this.#revisions[revisionIndex]!;
    if (revision < this.#gcFloor) return; // collected: the floor no longer serves this revision
    const actual = await this.call(
      collect(query(this.#primary.datastore.snapshotReader(new TimestampRevision(revision)))),
    );
    const expected = await collect(
      query(this.#reference.snapshotReader(this.#referenceAt.get(revision)!)),
    );
    if (actual.join("\n") !== expected.join("\n")) {
      this.diverge(
        `${what} at committed revision #${revisionIndex}: mesh [${actual.join(", ")}], ` +
          `reference [${expected.join(", ")}]`,
      );
    }
  }

  private record(revision: bigint, referenceRevision: IRevision): void {
    this.#revisions.push(revision);
    this.#referenceAt.set(revision, referenceRevision);
  }

  private nextCommit(doc: string): HarnessCommit {
    // Every third commit carries no transaction metadata; the rest a label unique to the commit.
    // Derived from a counter, not the seeded generator, so the workload and fault schedule a seed
    // draws are unchanged by it.
    const generated = this.#commitsGenerated++;
    const metadata =
      generated % 3 === 0 ? undefined : new TextEncoder().encode(`commit-${generated}`);
    const commit = this.nextCommitShape(doc);
    return { ...commit, request: { ...commit.request, transactionMetadata: metadata } };
  }

  private nextCommitShape(doc: string): HarnessCommit {
    const kind = this.#rng.nextDouble();
    if (kind < 0.2) {
      const filter = docFilter(
        doc,
        this.#rng.next(2) === 0 ? undefined : USERS[this.#rng.next(USERS.length)],
      );
      const limit = this.#rng.next(3) === 0 ? BigInt(1 + this.#rng.next(2)) : undefined;
      const deleteByFilter: DeleteByFilterWire = { filter: toFullFilter(filter), limit };
      return {
        description: `delete-by-filter ${describe(filter)} limit ${limit?.toString() ?? "none"}`,
        request: request([], [], deleteByFilter),
      };
    }

    const users = this.shuffled(USERS).slice(0, 1 + this.#rng.next(3));
    const updates: RelationshipUpdateWire[] = users.map((user) => {
      const pick = this.#rng.next(4);
      const operation = pick === 0 ? "create" : pick === 1 ? "delete" : "touch";
      return { operation, relationship: toWire(viewer(doc, user)) };
    });

    const preconditions: CommitPreconditionWire[] = [];
    if (kind < 0.4) {
      const filter = docFilter(
        doc,
        this.#rng.next(2) === 0 ? undefined : USERS[this.#rng.next(USERS.length)],
      );
      preconditions.push({ filter: toFullFilter(filter), mustMatch: this.#rng.next(2) === 0 });
    }

    const description = [
      ...preconditions.map(
        (p) =>
          `${p.mustMatch ? "must-match" : "must-not-match"} ${describe(toCoreFilter(p.filter))}`,
      ),
      ...updates.map((u) => `${u.operation} ${doc}#${u.relationship.subjectId}`),
    ].join(" ");
    return { description, request: request(preconditions, updates, undefined) };
  }

  /** The C#'s `OrderBy(_ => rng.Next())`: a random key per element, then a stable sort. */
  private shuffled<T>(items: readonly T[]): T[] {
    return items
      .map((item) => ({ item, key: this.#rng.next(MAX_INT) }))
      .sort((a, b) => a.key - b.key)
      .map((entry) => entry.item);
  }

  private async call<T>(promise: Promise<T>): Promise<T> {
    try {
      return await withTimeout(promise, CALL_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof CallTimeoutError)
        this.diverge("a call did not complete within the timeout");
      throw error;
    }
  }

  private diverge(what: string): never {
    throw new FaultHarnessDivergenceError(
      `seed ${this.#options.seed}: ${what}\ntrace:\n  ${this.trace.join("\n  ")}`,
    );
  }
}

function docFilter(doc: string, user: string | undefined): RelationshipsFilter {
  return {
    optionalResourceType: "doc",
    optionalResourceIds: [doc],
    optionalResourceRelation: "viewer",
    optionalSubjectsSelectors:
      user === undefined
        ? undefined
        : [{ optionalSubjectType: "user", optionalSubjectIds: [user] }],
  };
}

function describe(filter: RelationshipsFilter): string {
  const subject = filter.optionalSubjectsSelectors?.[0]?.optionalSubjectIds?.[0];
  return `doc:${filter.optionalResourceIds![0]}${subject === undefined ? "" : `@user:${subject}`}`;
}

function viewer(doc: string, user: string): Relationship {
  const resource: ObjectAndRelation = { objectType: "doc", objectId: doc, relation: "viewer" };
  const subject: ObjectAndRelation = { objectType: "user", objectId: user, relation: ELLIPSIS };
  return createRelationship(resource, subject);
}

function request(
  preconditions: readonly CommitPreconditionWire[],
  updates: readonly RelationshipUpdateWire[],
  deleteByFilter: DeleteByFilterWire | undefined,
): CommitRequest {
  return {
    preconditions,
    updates,
    deleteByFilter,
    schemaBytes: undefined,
    expectedSchemaHash: undefined,
    counterChanges: [],
    expectedHead: undefined,
  };
}

function outcome(reply: CommitReply): string {
  if (reply.failure !== undefined) return reply.failure.kind;
  if (reply.deletedCount > 0n || reply.reachedLimit)
    return `ok deleted ${reply.deletedCount}${reply.reachedLimit ? " limit reached" : ""}`;
  return "ok";
}

/** Orders committed revisions ascending, with rejections (no revision) last. */
function compareRevision(a: bigint | undefined, b: bigint | undefined): number {
  if (a === undefined) return b === undefined ? 0 : 1;
  if (b === undefined) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

async function collect(rows: AsyncIterable<Relationship>): Promise<string[]> {
  const result: string[] = [];
  for await (const row of rows) result.push(formatRelationship(row));
  return result.sort();
}

class CallTimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CallTimeoutError(`timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
