import type { CaveatTypeReference } from "@benedb/core/caveat-definition";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";

import { CaveatCompileException } from "./caveat-compile-exception";
import { CEL_DECLARATIONS } from "./cel-declarations";
import { CheckedType } from "./checked-type";

/**
 * SpiceDB's caveat parameter type system (`pkg/caveats/types`: `basic.go`, `ipaddress.go`,
 * `typeset.go`): the keywords a caveat parameter may be declared with, and the CEL type each one
 * declares its variable as when the caveat expression is checked.
 *
 * As upstream: `uint` is declared as CEL `int` (so `x == 1u` does not type-check for a `uint`
 * parameter); `any` is `dyn`; `map<T>` takes ONE generic, the value type, keys always being
 * strings; `ipaddress` is the opaque object type `IPAddress`; and a basic type ignores any generics
 * it is given (`int<string>` is `int`).
 *
 * Ported from Spiceport `Engine/CaveatParameterTypes.cs`.
 *
 * Port decisions:
 *   * The C# static class becomes module-level functions: `Validate` is
 *     `validateCaveatParameterType`, and `ToCelType` (internal to the C# assembly) is
 *     `caveatParameterCelType`.
 */

/**
 * Throws a `CaveatCompileException` with SpiceDB's message (``unknown type `foo` ``,
 * ``type `list` requires 1 generic types; found 0``) if the reference is not a valid parameter type.
 */
export function validateCaveatParameterType(type: CaveatTypeReference): void {
  caveatParameterCelType(type);
}

/** The CEL type a parameter of the given declared type is checked as. */
export function caveatParameterCelType(type: CaveatTypeReference): CheckedType {
  if (type === undefined || type === null) {
    throw new InvalidArgumentError("type is required");
  }

  const children = (type.childTypes ?? []).map(caveatParameterCelType);
  switch (type.typeName) {
    case "any":
      return CheckedType.dyn;
    case "bool":
      return CheckedType.bool;
    case "string":
      return CheckedType.string;
    case "int":
    case "uint":
      return CheckedType.int;
    case "double":
      return CheckedType.double;
    case "bytes":
      return CheckedType.bytes;
    case "duration":
      return CheckedType.duration;
    case "timestamp":
      return CheckedType.timestamp;
    case "ipaddress":
      return CEL_DECLARATIONS.ipAddress;
    case "list":
      requireGenerics(type.typeName, children.length);
      return CheckedType.list(children[0] as CheckedType);
    case "map":
      requireGenerics(type.typeName, children.length);
      return CheckedType.map(CheckedType.string, children[0] as CheckedType);
    default:
      throw new CaveatCompileException(`unknown type \`${type.typeName}\``);
  }
}

function requireGenerics(keyword: string, found: number): void {
  if (found !== 1) {
    throw new CaveatCompileException(
      `type \`${keyword}\` requires 1 generic types; found ${found}`,
    );
  }
}
