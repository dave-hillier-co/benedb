// Well-known constants used throughout the SpiceDB core data model.
//
// Ported from Spiceport `CoreConstants`, a C# `static class`. A static class is a namespace,
// not a value, so it becomes two sibling `const` bindings rather than an object literal. This
// file is the one sanctioned exception to the one-primary-export rule. Nothing else in the
// port may hardcode "..." or "*".

/** The relation used for a subject when no subrelation is specified. */
export const ELLIPSIS = "...";

/** The subject id used to represent a public/wildcard subject (all subjects of a type). */
export const PUBLIC_WILDCARD = "*";
