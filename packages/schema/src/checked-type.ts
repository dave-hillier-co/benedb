/**
 * A type as the static CEL checker (`cel-type-checker`) sees it. A transliteration of the
 * type-check half of cel-go's `common/types.Type` (the `authzed/cel-go` fork SpiceDB pins): a kind,
 * a runtime type name, and type parameters (a list's element type, a map's key and value types, an
 * opaque type's arguments, a type-of-type's subject).
 *
 * Ported from Spiceport `Engine/CelCheck/CheckedType.cs`.
 *
 * cel-go compares some types by pointer: `caveats.CompileCaveatWithSource` accepts a caveat only
 * when `ast.OutputType() == cel.BoolType`, so a type that is merely SHAPED like bool (a nullable
 * `google.protobuf.BoolValue` wrapper) is rejected. The singletons below play the part of cel-go's
 * package-level type values, and the checker never constructs a second instance of them, so
 * reference equality keeps that meaning.
 *
 * Port decisions:
 *   * The C# `CheckedKind` enum becomes a string-literal union.
 *   * The class survives as a class: it carries behaviour (assignability, formatting) as well as
 *     data, and its identity is load-bearing.
 */
export type CheckedKind =
  | "unspecified"
  | "dyn"
  | "any"
  | "bool"
  | "bytes"
  | "double"
  | "duration"
  | "error"
  | "int"
  | "list"
  | "map"
  | "null"
  | "opaque"
  | "string"
  | "struct"
  | "timestamp"
  | "type"
  | "typeParam"
  | "uint";

export class CheckedType {
  static readonly any = new CheckedType("any", "google.protobuf.Any", []);
  static readonly bool = new CheckedType("bool", "bool", []);
  static readonly bytes = new CheckedType("bytes", "bytes", []);
  static readonly double = new CheckedType("double", "double", []);
  static readonly duration = new CheckedType("duration", "google.protobuf.Duration", []);
  static readonly dyn = new CheckedType("dyn", "dyn", []);
  static readonly error = new CheckedType("error", "error", []);
  static readonly int = new CheckedType("int", "int", []);
  static readonly null = new CheckedType("null", "null_type", []);
  static readonly string = new CheckedType("string", "string", []);
  static readonly timestamp = new CheckedType("timestamp", "google.protobuf.Timestamp", []);
  static readonly typeType = new CheckedType("type", "type", []);
  static readonly uint = new CheckedType("uint", "uint", []);

  /** The kind of the type. */
  readonly kind: CheckedKind;

  /** The type-erased runtime type name (cel-go's `TypeName()`). */
  readonly name: string;

  /** The type parameters, if any. */
  readonly parameters: readonly CheckedType[];

  readonly #nullableOf: CheckedType | undefined;

  private constructor(
    kind: CheckedKind,
    name: string,
    parameters: readonly CheckedType[],
    nullableOf?: CheckedType,
  ) {
    this.kind = kind;
    this.name = name;
    this.parameters = parameters;
    this.#nullableOf = nullableOf;
  }

  /** A list of the given element type. */
  static list(element: CheckedType): CheckedType {
    return new CheckedType("list", "list", [element]);
  }

  /** A map of the given key and value types. */
  static map(key: CheckedType, value: CheckedType): CheckedType {
    return new CheckedType("map", "map", [key, value]);
  }

  /** An abstract parameterized type with the given name. */
  static opaque(name: string, ...parameters: CheckedType[]): CheckedType {
    return new CheckedType("opaque", name, parameters);
  }

  /** CEL's `optional_type(T)`. */
  static optional(parameter: CheckedType): CheckedType {
    return CheckedType.opaque("optional_type", parameter);
  }

  /** A type parameter, bound (or not) during checking. */
  static typeParam(name: string): CheckedType {
    return new CheckedType("typeParam", name, []);
  }

  /** The type of a type value, `type(T)`. */
  static typeOf(parameter: CheckedType): CheckedType {
    return new CheckedType("type", "type", [parameter]);
  }

  /**
   * A reference to an externally defined (message) type. As in cel-go's `NewObjectType`, the
   * protobuf well-known types are sanitized to their CEL equivalents.
   */
  static object(typeName: string): CheckedType {
    switch (typeName) {
      case "google.protobuf.BoolValue":
        return CheckedType.nullable(CheckedType.bool);
      case "google.protobuf.BytesValue":
        return CheckedType.nullable(CheckedType.bytes);
      case "google.protobuf.DoubleValue":
      case "google.protobuf.FloatValue":
        return CheckedType.nullable(CheckedType.double);
      case "google.protobuf.Int64Value":
      case "google.protobuf.Int32Value":
        return CheckedType.nullable(CheckedType.int);
      case "google.protobuf.UInt64Value":
      case "google.protobuf.UInt32Value":
        return CheckedType.nullable(CheckedType.uint);
      case "google.protobuf.StringValue":
        return CheckedType.nullable(CheckedType.string);
      case "google.protobuf.Any":
        return CheckedType.any;
      case "google.protobuf.Duration":
        return CheckedType.duration;
      case "google.protobuf.Timestamp":
        return CheckedType.timestamp;
      case "google.protobuf.ListValue":
        return CheckedType.list(CheckedType.dyn);
      case "google.protobuf.NullValue":
        return CheckedType.null;
      case "google.protobuf.Struct":
        return CheckedType.map(CheckedType.string, CheckedType.dyn);
      case "google.protobuf.Value":
        return CheckedType.dyn;
      default:
        return new CheckedType("struct", typeName, []);
    }
  }

  /** A nullable wrapper of a primitive type (cel-go's `NewNullableType`). */
  private static nullable(wrapped: CheckedType): CheckedType {
    return new CheckedType(wrapped.kind, wrapped.name, wrapped.parameters, wrapped);
  }

  /** True for dyn, any and type parameters: cel-go's private `Type.isDyn`. */
  get isDynamic(): boolean {
    return this.kind === "dyn" || this.kind === "any" || this.kind === "typeParam";
  }

  /** Whether the two types are exactly the same, type parameter names included. */
  isExactType(other: CheckedType): boolean {
    if (this === other) return true;
    if (
      this.kind !== other.kind ||
      this.parameters.length !== other.parameters.length ||
      this.name !== other.name
    ) {
      return false;
    }
    return this.parameters.every((p, i) => p.isExactType(other.parameters[i] as CheckedType));
  }

  /** Whether this type is type-check assignable from `from`. */
  isAssignableType(from: CheckedType): boolean {
    if (this.#nullableOf !== undefined) {
      return CheckedType.null.isAssignableType(from) || this.#nullableOf.isAssignableType(from);
    }

    if (this === from || this.isDynamic) return true;
    if (
      this.kind !== from.kind ||
      this.name !== from.name ||
      this.parameters.length !== from.parameters.length
    ) {
      return false;
    }
    return this.parameters.every((p, i) => p.isAssignableType(from.parameters[i] as CheckedType));
  }

  /** The parameterized type-check name: `wrapper(T)` for a nullable wrapper. */
  get declaredTypeName(): string {
    return this.kind !== "null" && !this.isDynamic && this.isAssignableType(CheckedType.null)
      ? `wrapper(${this.name})`
      : this.name;
  }

  /** cel-go's `Type.String()`, used for the non-boolean caveat output message. */
  toString(): string {
    return this.parameters.length === 0
      ? this.declaredTypeName
      : `${this.declaredTypeName}(${this.parameters.map((p) => p.toString()).join(", ")})`;
  }

  /** cel-go's `checker.FormatCELType`, used in type-check error messages. */
  format(): string {
    switch (this.kind) {
      case "any":
        return "any";
      case "duration":
        return "duration";
      case "error":
        return "!error!";
      case "null":
        return "null";
      case "timestamp":
        return "timestamp";
      case "typeParam":
        return this.name;
      case "opaque":
        if (this.name === "function") {
          return CheckedType.formatFunction(
            this.parameters[0] as CheckedType,
            this.parameters.slice(1),
            false,
          );
        }
        break;
      case "unspecified":
        return "";
      default:
        break;
    }

    return this.parameters.length === 0
      ? this.declaredTypeName
      : `${this.name}(${this.parameters.map((p) => p.format()).join(", ")})`;
  }
  /** cel-go's `formatFunctionDeclType`. */
  static formatFunction(
    result: CheckedType | undefined,
    args: readonly CheckedType[],
    isInstance: boolean,
  ): string {
    let text = "";
    let rest = args;
    if (isInstance) {
      text += `${(args[0] as CheckedType).format()}.`;
      rest = args.slice(1);
    }

    text += `(${rest.map((a) => a.format()).join(", ")})`;
    const formattedResult = result?.format() ?? "";
    if (formattedResult.length > 0) text += ` -> ${formattedResult}`;
    return text;
  }
}
