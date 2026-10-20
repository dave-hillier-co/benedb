/**
 * Ported from Spiceport `src/Spiceport.Api/MappedAsyncStreamReader.cs`.
 *
 * A client stream that presents each inbound message of one type as another, so a deprecated RPC
 * whose request type differs only in name can drive the implementation of its replacement.
 *
 * PORT DECISION. `IAsyncStreamReader<T>` is a plain `AsyncIterable<T>` in the ported services
 * (see `server-stream-writer.ts`), so the C# wrapper class becomes an async generator: each pull of
 * the result pulls the inner stream once and maps that message, as `Current => map(inner.Current)`
 * does after each `MoveNext`.
 */
export async function* mapAsyncStream<TSource, TTarget>(
  inner: AsyncIterable<TSource>,
  map: (message: TSource) => TTarget,
): AsyncIterable<TTarget> {
  for await (const message of inner) yield map(message);
}
