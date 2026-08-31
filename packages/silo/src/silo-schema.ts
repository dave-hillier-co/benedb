/**
 * Ported from Spiceport `src/Spiceport.Silo/SiloSchema.cs`.
 *
 * The schema compiled at silo startup. For this slice it is a fixed fixture; a later phase resolves
 * schema (and its derived dispatch identity) per revision from the datastore.
 *
 * PORT NOTE - THE RAW STRING LITERAL. The C# constant is a raw string literal (`"""..."""`), which
 * strips the indentation common to the closing delimiter's line and emits NO trailing newline. A
 * TypeScript template literal does neither, so the text below is written ALREADY DEDENTED and
 * without a trailing newline: `addSpiceportGrainServices(SiloSchema.SchemaText)` compiles this
 * constant into the live schema provider, whose schema hash is folded into every ZedToken the host
 * mints, so a whitespace byte that differs from Spiceport's is a TOKEN that differs from
 * Spiceport's.
 *
 * `SEED_SCHEMA_TEXT` (`@benedb/api/seed-data`) is byte-identical to this constant today, but the
 * two are SEPARATE constants in separate C# files and drift independently by design. Neither is
 * expressed in terms of the other.
 */
export const SILO_SCHEMA_TEXT = `definition user {}

definition document {
    relation viewer: user
    relation editor: user
    permission view = viewer + editor
}`;
