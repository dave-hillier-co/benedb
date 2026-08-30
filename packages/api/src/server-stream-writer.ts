/**
 * The S5 server-streaming seam: what Spiceport's `IServerStreamWriter<T>` becomes in TypeScript.
 *
 * Spiceport's streaming services take `(request, IServerStreamWriter<T>, ServerCallContext)`, and
 * its covering suites drive them with hand-written fakes (`CollectingStreamWriter<T>`,
 * `CancelAfterFirstStreamWriter<T>`). `@grpc/grpc-js` has no such interface: it hands the service a
 * `ServerWritableStream`, a Node duplex whose `write` returns a boolean and whose backpressure is
 * signalled by a `drain` event.
 *
 * Binding a service body to `ServerWritableStream` would drag the transport into the service and
 * leave those suites unportable, so the ported services take THIS one-method seam instead and
 * `program.ts` adapts the transport onto it. Awaiting `drain` when the underlying `write` returns
 * false is the ADAPTER's job; a service body only ever awaits `write`.
 *
 * `ServerCallContext` has no counterpart either: the only member the streaming services read off it
 * is `CancellationToken`, so it becomes a trailing `signal?: AbortSignal` parameter.
 */
export interface ServerStreamWriter<T> {
  /** Writes one message to the response stream, resolving once it has been accepted. */
  write(message: T): Promise<void>;
}
