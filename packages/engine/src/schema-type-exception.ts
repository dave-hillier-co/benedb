/**
 * Thrown by the schema type validator when a compiled schema fails type-system or caveat
 * validation at write time: an undefined relation/permission/subject-type reference, a permission
 * used on the left of an arrow, a wildcard imported into an arrow, a self-referential relation, a
 * missing allowed-types list, a duplicate allowed type, an undefined `with <caveat>`, a duplicate
 * or reused definition/caveat name, or a caveat whose CEL is unparseable, parameterless, or leaves
 * a declared parameter unreferenced. Mirrors SpiceDB's `schema.TypeError` /
 * `ValidateCaveatDefinition`, which surface as gRPC `FailedPrecondition`.
 *
 * Ported from Spiceport `Engine/SchemaTypeException.cs`. A plain engine-local exception; the grain
 * boundary re-wraps it in a serializable carrier so it round-trips to the gRPC front door.
 *
 * Its messages are asserted verbatim by the schema type validator suite, so they are carried
 * through byte-identically.
 */
export class SchemaTypeException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaTypeException";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
