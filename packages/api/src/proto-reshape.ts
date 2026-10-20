/**
 * Ported from Spiceport `src/Spiceport.Api/ProtoReshape.cs`.
 *
 * Re-types a protobuf message as another message type with the SAME wire schema (identical field
 * numbers, types and nesting) by round-tripping its encoding. The ExperimentalService `Exp*`
 * reflection messages are field-for-field copies of the SchemaService `Reflection*` messages, and
 * upstream SpiceDB builds them from duplicated converters (`internal/services/v1/expreflection.go`
 * is `reflectionapi.go` with the types renamed); re-typing the v1 response reproduces that output
 * without a second converter.
 *
 * PORT DECISION. C# messages are nominal types, so the re-encoding is the only way across. ts-proto
 * messages are plain objects whose two shapes here are structurally identical, so an assignment
 * would type-check; the round trip is kept anyway because it is what pins the WIRE equivalence -
 * a field present on one side and absent on the other is dropped by the target's `decode`, which
 * the descriptor-free equivalence test in `proto-reshape.test.ts` detects. The ts-proto
 * `MessageFns` are taken structurally (just `encode(...).finish()` and `decode`) so this package
 * needs no direct dependency on the wire runtime.
 */
export function reshapeProto<TSource, TTarget>(
  source: TSource,
  sourceFns: { encode(message: TSource): { finish(): Uint8Array } },
  targetFns: { decode(input: Uint8Array): TTarget },
): TTarget {
  return targetFns.decode(sourceFns.encode(source).finish());
}
