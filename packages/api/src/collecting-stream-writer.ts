import type { ServerStreamWriter } from "./server-stream-writer";

/**
 * The `CollectingStreamWriter<T>` that Spiceport's streaming suites
 * (`tests/Spiceport.Grains.Tests/WatchGrpcServiceTests.cs`,
 * `AuthzedWatchV1ServiceTests.cs`, `BulkGrpcServiceTests.cs`) each declare privately: an
 * `IServerStreamWriter<T>` that records every response AND signals each arrival, so a test can wait
 * for the next message of a stream that is still running.
 *
 * LEDGER DEVIATION: this harness has no C# file of its own - the C# forks one copy of the class per
 * suite because a nested private class cannot be shared. TypeScript can share it, and the batch
 * brief says to, so the three ported suites import this single copy. It lands as a plain `.ts` (not
 * `*.test.ts`) because it declares no cases and a caseless `*.test.ts` fails a vitest run outright -
 * the same deviation `mesh-test-cluster.ts` already took.
 *
 * PORT DECISIONS.
 *  * `IServerStreamWriter<T>` becomes {@link ServerStreamWriter} (one `write` member); the C#'s
 *    `WriteOptions` property is part of the gRPC interface only and nothing reads it, so it is gone.
 *  * `Channel.CreateUnbounded<T>()` becomes a FIFO queue of already-written messages plus a FIFO
 *    queue of pending resolvers. The semantics that matter are the channel's: every write is
 *    buffered, and `waitForNext` consumes the OLDEST unread message rather than only observing
 *    messages that arrive after the call.
 *  * `WaitForNext(timeout, watchTask)` keeps the C#'s race EXACTLY: the read is started, and when a
 *    watch task is supplied the two are raced so that a FAULT in the stream surfaces as itself
 *    rather than as a timeout. Note that even when the watch task wins the race, the C# still
 *    `return await read` - so a watch that COMPLETED without writing anything still ends in the
 *    timeout, and the port does the same.
 *  * `new CancellationTokenSource(timeout)` on the read becomes a timer that rejects the read.
 */
export class CollectingStreamWriter<T> implements ServerStreamWriter<T> {
  /** Every response written, in order (the C#'s `Collected`). */
  readonly collected: T[] = [];

  /** Written-but-not-yet-awaited messages: the unbounded channel's buffer. */
  readonly #queue: T[] = [];

  /** Awaiting readers, oldest first: the channel's parked `ReadAsync` calls. */
  readonly #waiters: ((message: T) => void)[] = [];

  async write(message: T): Promise<void> {
    this.collected.push(message);
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter(message);
      return;
    }
    this.#queue.push(message);
  }

  /**
   * Awaits the next unread response, failing after `timeoutMs`. When `watchTask` is supplied it is
   * raced against the read so that a faulted stream surfaces its own error.
   */
  async waitForNext(timeoutMs: number, watchTask?: Promise<unknown> | undefined): Promise<T> {
    const queued = this.#queue.shift();
    if (queued !== undefined) {
      return queued;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = new Promise<T>((resolve, reject) => {
      this.#waiters.push(resolve);
      timer = setTimeout(
        () => reject(new Error(`timed out after ${timeoutMs}ms awaiting the next stream message`)),
        timeoutMs,
      );
    });

    try {
      if (watchTask !== undefined) {
        const marker = Symbol("watchTask");
        const done = await Promise.race([read, watchTask.then(() => marker)]);
        if (done === marker) {
          // `if (done == watchTask) await watchTask;` - surface any fault from the watch stream.
          await watchTask;
        }
      }
      return await read;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
