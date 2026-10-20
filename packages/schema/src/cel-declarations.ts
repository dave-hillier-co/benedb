import { CheckedType } from "./checked-type";

/**
 * One overload of a declared CEL function: cel-go's `decls.OverloadDecl`, reduced to what the type
 * checker reads. `crossTypeNumericComparison` marks the mixed int/uint/double ordering overloads,
 * which cel-go's checker disables unless the environment enables cross-type numeric comparisons
 * (SpiceDB's does not).
 */
export interface CelOverload {
  readonly id: string;
  readonly isMember: boolean;
  readonly argTypes: readonly CheckedType[];
  readonly resultType: CheckedType;
  readonly crossTypeNumericComparison: boolean;
  /** The names of the type parameters occurring in the signature, as `decls.Overload` collects them. */
  readonly typeParams: readonly string[];
}

/** A declared CEL function and its overloads, in declaration order. */
export interface CelFunction {
  readonly name: string;
  readonly overloads: readonly CelOverload[];
}

/**
 * The static declarations of the CEL environment SpiceDB compiles caveats in
 * (`pkg/caveats/env.go` `asCelEnvironment`): `cel.NewEnv`'s standard library
 * (`common/stdlib/standard.go`), the optional-types library at version 0 (`cel/library.go`,
 * `cel.OptionalTypes(cel.OptionalTypesVersion(0))`), and the caveat type set's custom functions
 * (`pkg/caveats/types/basic.go`, `ipaddress.go`): `isSubtreeOf` on `map(string, dyn)` and
 * `in_cidr` on `IPAddress`. Mirrors `authzed/cel-go` v0.20.2, the fork SpiceDB pins.
 *
 * There is deliberately no `ipaddress(string)` function: SpiceDB declares `ipaddress` only as a
 * parameter type, so a caveat calling it fails SpiceDB's checker, even though the runtime caveat
 * environment binds one for evaluation.
 *
 * Ported from Spiceport `Engine/CelCheck/CelDeclarations.cs`.
 *
 * Port decisions:
 *   * The C# static class of readonly fields becomes one exported constant object, so the module
 *     keeps a single primary export.
 */
export const CEL_DECLARATIONS = buildDeclarations();

function buildDeclarations() {
  const A = CheckedType.typeParam("A");
  const B = CheckedType.typeParam("B");

  /** cel-go's `cel.ObjectType("IPAddress")`, the CEL type of an `ipaddress` parameter. */
  const ipAddress = CheckedType.object("IPAddress");

  const typeIdentifiers: ReadonlyMap<string, CheckedType> = new Map(
    [
      CheckedType.bool,
      CheckedType.bytes,
      CheckedType.double,
      CheckedType.duration,
      CheckedType.int,
      CheckedType.list(A),
      CheckedType.map(A, B),
      CheckedType.null,
      CheckedType.string,
      CheckedType.timestamp,
      CheckedType.typeType,
      CheckedType.uint,
    ].map((t) => [t.name, CheckedType.typeOf(t)]),
  );

  const fields = (
    ...entries: (readonly [string, CheckedType])[]
  ): ReadonlyMap<string, CheckedType> => new Map(entries);

  const structTypes: ReadonlyMap<string, ReadonlyMap<string, CheckedType>> = new Map([
    ["google.protobuf.Any", fields(["type_url", CheckedType.string], ["value", CheckedType.bytes])],
    ["google.protobuf.Duration", fields(["seconds", CheckedType.int], ["nanos", CheckedType.int])],
    ["google.protobuf.Timestamp", fields(["seconds", CheckedType.int], ["nanos", CheckedType.int])],
    ["google.protobuf.Empty", fields()],
    ["google.protobuf.FieldMask", fields(["paths", CheckedType.list(CheckedType.string)])],
    [
      "google.protobuf.Struct",
      fields(["fields", CheckedType.map(CheckedType.string, CheckedType.dyn)]),
    ],
    [
      "google.protobuf.Value",
      fields(
        ["null_value", CheckedType.null],
        ["number_value", CheckedType.double],
        ["string_value", CheckedType.string],
        ["bool_value", CheckedType.bool],
        ["struct_value", CheckedType.map(CheckedType.string, CheckedType.dyn)],
        ["list_value", CheckedType.list(CheckedType.dyn)],
      ),
    ],
    ["google.protobuf.ListValue", fields(["values", CheckedType.list(CheckedType.dyn)])],
    ["google.protobuf.BoolValue", fields(["value", CheckedType.bool])],
    ["google.protobuf.BytesValue", fields(["value", CheckedType.bytes])],
    ["google.protobuf.DoubleValue", fields(["value", CheckedType.double])],
    ["google.protobuf.FloatValue", fields(["value", CheckedType.double])],
    ["google.protobuf.Int64Value", fields(["value", CheckedType.int])],
    ["google.protobuf.Int32Value", fields(["value", CheckedType.int])],
    ["google.protobuf.UInt64Value", fields(["value", CheckedType.uint])],
    ["google.protobuf.UInt32Value", fields(["value", CheckedType.uint])],
    ["google.protobuf.StringValue", fields(["value", CheckedType.string])],
  ]);

  return {
    ipAddress,
    functions: buildFunctions(ipAddress),
    /**
     * The standard type identifiers (`stdlib.Types()`: `decls.TypeVariable` of each standard
     * type, named by its runtime type name).
     */
    typeIdentifiers,
    /**
     * The registry types found by `Provider.FindIdent` that the declarations above do not
     * already shadow: the optional type registered by the optional library.
     */
    registryTypeIdentifiers: new Map([
      ["optional_type", CheckedType.typeOf(CheckedType.opaque("optional_type"))],
    ]) as ReadonlyMap<string, CheckedType>,
    /** The enum values the default registry resolves as identifiers. */
    enumValueIdentifiers: new Set(["google.protobuf.NullValue.NULL_VALUE"]) as ReadonlySet<string>,
    /**
     * The message types of the default registry (the protobuf well-known types cel-go registers)
     * and their fields' CEL types, as `Provider.FindStructType` / `FindStructFieldType` report them.
     */
    structTypes,
  } as const;
}

function overload(
  id: string,
  isMember: boolean,
  resultType: CheckedType,
  argTypes: readonly CheckedType[],
  crossTypeNumericComparison = false,
): CelOverload {
  return {
    id,
    isMember,
    argTypes,
    resultType,
    crossTypeNumericComparison,
    typeParams: collectTypeParams([...argTypes, resultType]),
  };
}

function collectTypeParams(types: readonly CheckedType[]): readonly string[] {
  const names: string[] = [];
  const collect = (t: CheckedType): void => {
    if (t.kind === "typeParam" && !names.includes(t.name)) names.push(t.name);
    t.parameters.forEach(collect);
  };
  types.forEach(collect);
  return names;
}

function buildFunctions(ipAddress: CheckedType): ReadonlyMap<string, CelFunction> {
  const A = CheckedType.typeParam("A");
  const B = CheckedType.typeParam("B");
  const K = CheckedType.typeParam("K");
  const V = CheckedType.typeParam("V");
  const bool = CheckedType.bool;
  const bytes = CheckedType.bytes;
  const dbl = CheckedType.double;
  const dur = CheckedType.duration;
  const int = CheckedType.int;
  const str = CheckedType.string;
  const ts = CheckedType.timestamp;
  const uint = CheckedType.uint;
  const listOfA = CheckedType.list(A);
  const mapOfAB = CheckedType.map(A, B);
  const optV = CheckedType.optional(V);
  const listOfV = CheckedType.list(V);
  const mapOfKV = CheckedType.map(K, V);

  const G = (id: string, result: CheckedType, ...args: CheckedType[]): CelOverload =>
    overload(id, false, result, args);
  const M = (id: string, result: CheckedType, ...args: CheckedType[]): CelOverload =>
    overload(id, true, result, args);
  const X = (id: string, result: CheckedType, ...args: CheckedType[]): CelOverload =>
    overload(id, false, result, args, true);

  const ordering = (name: string): CelOverload[] => [
    G(`${name}_bool`, bool, bool, bool),
    G(`${name}_int64`, bool, int, int),
    X(`${name}_int64_double`, bool, int, dbl),
    X(`${name}_int64_uint64`, bool, int, uint),
    G(`${name}_uint64`, bool, uint, uint),
    X(`${name}_uint64_double`, bool, uint, dbl),
    X(`${name}_uint64_int64`, bool, uint, int),
    G(`${name}_double`, bool, dbl, dbl),
    X(`${name}_double_int64`, bool, dbl, int),
    X(`${name}_double_uint64`, bool, dbl, uint),
    G(`${name}_string`, bool, str, str),
    G(`${name}_bytes`, bool, bytes, bytes),
    G(`${name}_timestamp`, bool, ts, ts),
    G(`${name}_duration`, bool, dur, dur),
  ];

  const timeAccessor = (id: string, withDuration: boolean): CelOverload[] =>
    withDuration
      ? [
          M(`timestamp_to_${id}`, int, ts),
          M(`timestamp_to_${id}_with_tz`, int, ts, str),
          M(`duration_to_${id}`, int, dur),
        ]
      : [M(`timestamp_to_${id}`, int, ts), M(`timestamp_to_${id}_with_tz`, int, ts, str)];

  const functions: CelFunction[] = [
    // Standard library (common/stdlib/standard.go).
    { name: "_?_:_", overloads: [G("conditional", A, bool, A, A)] },
    { name: "_&&_", overloads: [G("logical_and", bool, bool, bool)] },
    { name: "_||_", overloads: [G("logical_or", bool, bool, bool)] },
    { name: "!_", overloads: [G("logical_not", bool, bool)] },
    { name: "@not_strictly_false", overloads: [G("not_strictly_false", bool, bool)] },
    { name: "_==_", overloads: [G("equals", bool, A, A)] },
    { name: "_!=_", overloads: [G("not_equals", bool, A, A)] },
    {
      name: "_+_",
      overloads: [
        G("add_bytes", bytes, bytes, bytes),
        G("add_double", dbl, dbl, dbl),
        G("add_duration_duration", dur, dur, dur),
        G("add_duration_timestamp", ts, dur, ts),
        G("add_timestamp_duration", ts, ts, dur),
        G("add_int64", int, int, int),
        G("add_list", listOfA, listOfA, listOfA),
        G("add_string", str, str, str),
        G("add_uint64", uint, uint, uint),
      ],
    },
    {
      name: "_/_",
      overloads: [
        G("divide_double", dbl, dbl, dbl),
        G("divide_int64", int, int, int),
        G("divide_uint64", uint, uint, uint),
      ],
    },
    {
      name: "_%_",
      overloads: [G("modulo_int64", int, int, int), G("modulo_uint64", uint, uint, uint)],
    },
    {
      name: "_*_",
      overloads: [
        G("multiply_double", dbl, dbl, dbl),
        G("multiply_int64", int, int, int),
        G("multiply_uint64", uint, uint, uint),
      ],
    },
    { name: "-_", overloads: [G("negate_double", dbl, dbl), G("negate_int64", int, int)] },
    {
      name: "_-_",
      overloads: [
        G("subtract_double", dbl, dbl, dbl),
        G("subtract_duration_duration", dur, dur, dur),
        G("subtract_int64", int, int, int),
        G("subtract_timestamp_duration", ts, ts, dur),
        G("subtract_timestamp_timestamp", dur, ts, ts),
        G("subtract_uint64", uint, uint, uint),
      ],
    },
    { name: "_<_", overloads: ordering("less") },
    { name: "_<=_", overloads: ordering("less_equals") },
    { name: "_>_", overloads: ordering("greater") },
    { name: "_>=_", overloads: ordering("greater_equals") },
    {
      name: "_[_]",
      overloads: [
        G("index_list", A, listOfA, int),
        G("index_map", B, mapOfAB, A),
        // The optional library adds overloads to the standard index operator; cel-go merges
        // them in declaration order after the standard ones.
        G("optional_list_index_int", optV, CheckedType.optional(listOfV), int),
        G("optional_map_index_value", optV, CheckedType.optional(mapOfKV), K),
      ],
    },
    { name: "@in", overloads: [G("in_list", bool, A, listOfA), G("in_map", bool, A, mapOfAB)] },
    {
      name: "size",
      overloads: [
        G("size_bytes", int, bytes),
        M("bytes_size", int, bytes),
        G("size_list", int, listOfA),
        M("list_size", int, listOfA),
        G("size_map", int, mapOfAB),
        M("map_size", int, mapOfAB),
        G("size_string", int, str),
        M("string_size", int, str),
      ],
    },
    { name: "type", overloads: [G("type", CheckedType.typeOf(A), A)] },
    { name: "bool", overloads: [G("bool_to_bool", bool, bool), G("string_to_bool", bool, str)] },
    {
      name: "bytes",
      overloads: [G("bytes_to_bytes", bytes, bytes), G("string_to_bytes", bytes, str)],
    },
    {
      name: "double",
      overloads: [
        G("double_to_double", dbl, dbl),
        G("int64_to_double", dbl, int),
        G("string_to_double", dbl, str),
        G("uint64_to_double", dbl, uint),
      ],
    },
    {
      name: "duration",
      overloads: [
        G("duration_to_duration", dur, dur),
        G("int64_to_duration", dur, int),
        G("string_to_duration", dur, str),
      ],
    },
    { name: "dyn", overloads: [G("to_dyn", CheckedType.dyn, A)] },
    {
      name: "int",
      overloads: [
        G("int64_to_int64", int, int),
        G("double_to_int64", int, dbl),
        G("duration_to_int64", int, dur),
        G("string_to_int64", int, str),
        G("timestamp_to_int64", int, ts),
        G("uint64_to_int64", int, uint),
      ],
    },
    {
      name: "string",
      overloads: [
        G("string_to_string", str, str),
        G("bool_to_string", str, bool),
        G("bytes_to_string", str, bytes),
        G("double_to_string", str, dbl),
        G("duration_to_string", str, dur),
        G("int64_to_string", str, int),
        G("timestamp_to_string", str, ts),
        G("uint64_to_string", str, uint),
      ],
    },
    {
      name: "timestamp",
      overloads: [
        G("timestamp_to_timestamp", ts, ts),
        G("int64_to_timestamp", ts, int),
        G("string_to_timestamp", ts, str),
      ],
    },
    {
      name: "uint",
      overloads: [
        G("uint64_to_uint64", uint, uint),
        G("double_to_uint64", uint, dbl),
        G("int64_to_uint64", uint, int),
        G("string_to_uint64", uint, str),
      ],
    },
    { name: "contains", overloads: [M("contains_string", bool, str, str)] },
    { name: "endsWith", overloads: [M("ends_with_string", bool, str, str)] },
    { name: "startsWith", overloads: [M("starts_with_string", bool, str, str)] },
    {
      name: "matches",
      overloads: [G("matches", bool, str, str), M("matches_string", bool, str, str)],
    },
    { name: "getFullYear", overloads: timeAccessor("year", false) },
    { name: "getMonth", overloads: timeAccessor("month", false) },
    { name: "getDayOfYear", overloads: timeAccessor("day_of_year", false) },
    { name: "getDayOfMonth", overloads: timeAccessor("day_of_month", false) },
    { name: "getDate", overloads: timeAccessor("day_of_month_1_based", false) },
    { name: "getDayOfWeek", overloads: timeAccessor("day_of_week", false) },
    { name: "getHours", overloads: timeAccessor("hours", true) },
    { name: "getMinutes", overloads: timeAccessor("minutes", true) },
    { name: "getSeconds", overloads: timeAccessor("seconds", true) },
    { name: "getMilliseconds", overloads: timeAccessor("milliseconds", true) },

    // Optional types library, version 0 (cel/library.go).
    { name: "optional.of", overloads: [G("optional_of", optV, V)] },
    { name: "optional.ofNonZeroValue", overloads: [G("optional_ofNonZeroValue", optV, V)] },
    { name: "optional.none", overloads: [G("optional_none", optV)] },
    { name: "value", overloads: [M("optional_value", V, optV)] },
    { name: "hasValue", overloads: [M("optional_hasValue", bool, optV)] },
    { name: "or", overloads: [M("optional_or_optional", optV, optV, optV)] },
    { name: "orValue", overloads: [M("optional_orValue_value", V, optV, V)] },
    { name: "_?._", overloads: [G("select_optional_field", optV, CheckedType.dyn, str)] },
    {
      name: "_[?_]",
      overloads: [
        G("list_optindex_optional_int", optV, listOfV, int),
        G("optional_list_optindex_optional_int", optV, CheckedType.optional(listOfV), int),
        G("map_optindex_optional_value", optV, mapOfKV, K),
        G("optional_map_optindex_optional_value", optV, CheckedType.optional(mapOfKV), K),
      ],
    },

    // The caveat type set's custom functions (pkg/caveats/types).
    {
      name: "isSubtreeOf",
      overloads: [
        M(
          "isSubtreeOf",
          bool,
          CheckedType.map(str, CheckedType.dyn),
          CheckedType.map(str, CheckedType.dyn),
        ),
      ],
    },
    { name: "in_cidr", overloads: [M("ipaddress_in_cidr_string", bool, ipAddress, str)] },
  ];

  return new Map(functions.map((f) => [f.name, f]));
}
