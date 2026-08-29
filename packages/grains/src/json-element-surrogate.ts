/**
 * Ported from Spiceport `src/Spiceport.Server/Grains/JsonElementSurrogate.cs` - as a record of why
 * there is NOTHING TO REGISTER here.
 *
 * The C# file exists because .NET's caveat context is a `Dictionary<string, object?>` whose values
 * are BOXED `JsonElement`s, a type Orleans can neither copy nor code. Its surrogate captures each
 * element's raw JSON text on the wire and re-parses it on the way back, and its copier calls
 * `JsonElement.Clone()` because an element backed by a live `JsonDocument` is only a view.
 *
 * THAT PROBLEM DOES NOT EXIST IN THE PORT. The ported `ContextualizedCaveat.context` is a
 * `ReadonlyMap<string, unknown>` of plain JSON values (string, number, boolean, null, array,
 * nested Map), and Thresh's value codec already encodes and decodes `Map` natively, as a tagged
 * entries array - see `packages/core/src/value-codec.ts` in the Thresh checkout. Registering a
 * surrogate for it would double-encode. There is no live-document view to detach either, so the
 * copier has no counterpart.
 *
 * The C# test that covered this file (`DatastoreStateWireRoundTripTests`) asserted that caveat
 * context survives the grain boundary. That INTENT is carried across in `json-element-surrogate.
 * test.ts` as assertions on the Map's contents, types and KEY ORDER. Key order is observable - the
 * S1 port pinned it in tuple-string formatting - so a codec that lost it would be a Thresh bug to
 * fix in Thresh, not something to work around here.
 */
export const CAVEAT_CONTEXT_SURROGATE_NOT_REQUIRED = true;
