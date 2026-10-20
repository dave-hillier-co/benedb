import type { ServerStreamWriter } from "./server-stream-writer";

/**
 * Ported from Spiceport `src/Spiceport.Api/MappedServerStreamWriter.cs`.
 *
 * A server-stream writer that converts each outbound message before writing it to the real stream,
 * the response-side counterpart of `mapAsyncStream`.
 *
 * PORT DECISION. The C# forwards `WriteOptions` to the inner writer; {@link ServerStreamWriter}
 * has no such member (see `collecting-stream-writer.ts`), so only `write` remains.
 */
export class MappedServerStreamWriter<TSource, TTarget> implements ServerStreamWriter<TSource> {
  readonly #inner: ServerStreamWriter<TTarget>;
  readonly #map: (message: TSource) => TTarget;

  constructor(inner: ServerStreamWriter<TTarget>, map: (message: TSource) => TTarget) {
    this.#inner = inner;
    this.#map = map;
  }

  write(message: TSource): Promise<void> {
    return this.#inner.write(this.#map(message));
  }
}
