/**
 * Raised by the schema-introspection walks for unknown or mis-typed inputs.
 *
 * Ported from Spiceport `Engine/Reachability/SchemaIntrospection.cs`, which declares
 * `SchemaIntrospectionErrorKind` and `SchemaIntrospectionException` alongside the static walk
 * class. Under the no-barrels / one-primary-export house rule they get this module of their own,
 * and a second `docs/port-ledger.md` row against the same source file.
 *
 * The KIND must survive as DATA, not merely as message text: at the API layer it picks the gRPC
 * status (`definitionNotFound`/`relationNotFound` -> NotFound, `notAPermission` ->
 * InvalidArgument).
 */

/** The category of a {@link SchemaIntrospectionException}, for mapping to a gRPC status. */
export type SchemaIntrospectionErrorKind =
  /** The requested object definition does not exist. */
  | "definitionNotFound"
  /** The requested relation/permission does not exist under the definition. */
  | "relationNotFound"
  /** The requested target is a base relation where a permission was required. */
  | "notAPermission";

/** Raised by schema-introspection walks for unknown or mis-typed inputs. */
export class SchemaIntrospectionException extends Error {
  /** The error category, used to map to the appropriate gRPC status code. */
  readonly kind: SchemaIntrospectionErrorKind;

  constructor(kind: SchemaIntrospectionErrorKind, message: string) {
    super(message);
    this.name = "SchemaIntrospectionException";
    this.kind = kind;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
