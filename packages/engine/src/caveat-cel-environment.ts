import {
  CelList,
  CelMap,
  CelObject,
  CelUint,
  Func,
  FuncRegistry,
  createEnv,
  type CelEnv,
} from "@bufbuild/cel";
import { createRegistry } from "@bufbuild/protobuf";

/**
 * Builds the shared CEL environment used for both compiling (parse-validating at schema write) and
 * evaluating SpiceDB-style caveats. Registers the SpiceDB custom functions/types:
 * `ipaddress(string)` with `.in_cidr(string)`, and a map `.isSubtreeOf(map)` structural-subtree
 * check. `timestamp`/`duration` are provided by the underlying CEL implementation.
 *
 * Ported from Spiceport `Engine/CaveatCelEnvironment.cs`.
 *
 * Port decisions:
 *
 *   * `new CelEnvironment(null, null)` + `env.RegisterFunction(name, types, lambda)` has no
 *     counterpart in `@bufbuild/cel`. The environment is built with `createEnv("", createRegistry())`
 *     - never `new CelEnv()`, whose parser is left unset and throws "parser not set" on first use -
 *     and the customs are installed as `Func.newStrict` entries in a `FuncRegistry` handed to
 *     `env.addFuncs`. The overload id strings mirror SpiceDB's cel-go registrations.
 *
 *   * EXCEPTIONS BECOME VALUES. The C# `RequireBound` throws `CelUndeclaredReferenceException` when
 *     a custom-function argument is null - the signal that an absent caveat parameter reached the
 *     function. `@bufbuild/cel` has no such channel: an unbound identifier evaluates to a `CelError`
 *     value, and `Func.newStrict` propagates a `CelError`/`CelUnknown` argument without ever
 *     entering the op. So `RequireBound` disappears while the behaviour it existed to produce - an
 *     unbound operand is an error, never a plain `false` - survives unchanged. `CaveatEvaluator`
 *     turns that error value into `caveated`.
 *
 *   * `IPAddress.TryParse` has no JavaScript equivalent, so the parse is hand-rolled, and it is
 *     STRICT: dotted-quad IPv4 with no leading zeros, or IPv6. This is a DELIBERATE DIVERGENCE from
 *     .NET, which accepts `010.0.0.1` as octal, `1.2.3` as 1.2.0.3, `16777217` as 1.0.0.1 and
 *     `0x0a.0.0.1` as 10.0.0.1. SpiceDB's `netip.ParseAddr` rejects all of those, and an
 *     authorization decision must not turn on which reading a runtime happens to pick.
 */

/** The registered name/overload pairs, mirroring SpiceDB's cel-go registrations. */
const IPADDRESS_OVERLOAD = "ipaddress_string";
const IN_CIDR_OVERLOAD = "ipaddress_in_cidr_string";
const IS_SUBTREE_OF_OVERLOAD = "map_isSubtreeOf_map";

/** Creates a fresh environment with the SpiceDB caveat functions registered. */
export function buildCaveatCelEnvironment(): CelEnv {
  const env = createEnv("", createRegistry());
  const funcs = new FuncRegistry();

  // ipaddress(string) -> the string itself (represented as a string in this engine).
  funcs.add(
    Func.newStrict("ipaddress", [IPADDRESS_OVERLOAD], (_id, args) => {
      if (args.length !== 1) return undefined;
      return args[0];
    }),
  );

  // <ipaddress|string>.in_cidr(cidr_string) -> bool. An unbound receiver/argument never reaches
  // here: `newStrict` short-circuits a CelError/CelUnknown argument straight back out, which is
  // exactly what the C#'s `RequireBound` throw produced.
  funcs.add(
    Func.newStrict("in_cidr", [IN_CIDR_OVERLOAD], (_id, args) => {
      if (args.length !== 2) return undefined;
      return inCidr(asString(args[0]), asString(args[1]));
    }),
  );

  // <map>.isSubtreeOf(other_map) -> bool
  funcs.add(
    Func.newStrict("isSubtreeOf", [IS_SUBTREE_OF_OVERLOAD], (_id, args) => {
      if (args.length !== 2) return undefined;
      return isSubtreeOf(args[0], args[1]);
    }),
  );

  env.addFuncs(funcs);
  return env;
}

/** `o as string ?? o?.ToString() ?? string.Empty`. */
function asString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (value instanceof CelUint) return String(value.value);
  return String(value);
}

// --------------------------------------------------------------------------------------------
// in_cidr
// --------------------------------------------------------------------------------------------

/** True if `ip` is contained within the CIDR network. */
function inCidr(ip: string, cidr: string): boolean {
  const addr = parseIpAddress(ip);
  if (addr === undefined) return false;

  const slash = cidr.indexOf("/");
  if (slash < 0) {
    const single = parseIpAddress(cidr);
    return single !== undefined && bytesEqual(single, addr);
  }

  const network = parseIpAddress(cidr.slice(0, slash));
  const prefixLen = parsePrefixLength(cidr.slice(slash + 1));
  if (network === undefined || prefixLen === undefined) return false;

  // A differing address family is a definite non-match, not an error.
  if (addr.length !== network.length) return false;

  const totalBits = addr.length * 8;
  if (prefixLen < 0 || prefixLen > totalBits) return false;

  // Per-BIT mask, exactly as the C#: a byte-granular mask would accept a whole trailing octet.
  for (let bit = 0; bit < prefixLen; bit++) {
    const byteIndex = Math.trunc(bit / 8);
    const mask = 1 << (7 - (bit % 8));
    if (((addr[byteIndex] ?? 0) & mask) !== ((network[byteIndex] ?? 0) & mask)) return false;
  }

  return true;
}

/** `int.TryParse` over the prefix length: an optionally-signed run of ASCII digits, nothing else. */
function parsePrefixLength(text: string): number | undefined {
  if (!/^[+-]?[0-9]+$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : undefined;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Parses an IPv4 or IPv6 address into its 4 or 16 network-order bytes, strictly. */
function parseIpAddress(text: string): Uint8Array | undefined {
  if (text.includes(":")) return parseIpv6(text);
  return parseIpv4(text);
}

/** Strict dotted quad: four decimal octets, 0-255, no leading zeros, no whitespace. */
function parseIpv4(text: string): Uint8Array | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = parts[i] ?? "";
    if (!/^[0-9]{1,3}$/.test(part)) return undefined;
    if (part.length > 1 && part.startsWith("0")) return undefined; // no octal reading, no ambiguity
    const value = Number(part);
    if (value > 255) return undefined;
    bytes[i] = value;
  }
  return bytes;
}

/** RFC 4291 IPv6, including `::` compression and a trailing embedded IPv4 form. */
function parseIpv6(text: string): Uint8Array | undefined {
  const doubleColon = text.indexOf("::");
  if (doubleColon !== text.lastIndexOf("::")) return undefined;

  const head = doubleColon < 0 ? text : text.slice(0, doubleColon);
  const tail = doubleColon < 0 ? "" : text.slice(doubleColon + 2);

  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === "" ? [] : tail.split(":");

  const bytes = new Uint8Array(16);
  const headBytes = groupsToBytes(headGroups);
  const tailBytes = groupsToBytes(tailGroups);
  if (headBytes === undefined || tailBytes === undefined) return undefined;

  if (doubleColon < 0) {
    if (headBytes.length !== 16) return undefined;
    return headBytes;
  }

  // `::` must stand for at least one omitted group, as netip requires.
  if (headBytes.length + tailBytes.length >= 16) return undefined;
  bytes.set(headBytes, 0);
  bytes.set(tailBytes, 16 - tailBytes.length);
  return bytes;
}

/** Converts hextet groups (with an optional trailing embedded IPv4) into bytes. */
function groupsToBytes(groups: readonly string[]): Uint8Array | undefined {
  const out: number[] = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i] ?? "";
    if (group.includes(".")) {
      // An embedded IPv4 form is only legal as the final group.
      if (i !== groups.length - 1) return undefined;
      const embedded = parseIpv4(group);
      if (embedded === undefined) return undefined;
      out.push(...embedded);
      continue;
    }
    if (!/^[0-9A-Fa-f]{1,4}$/.test(group)) return undefined;
    const value = Number.parseInt(group, 16);
    out.push((value >> 8) & 0xff, value & 0xff);
  }
  if (out.length > 16) return undefined;
  return Uint8Array.from(out);
}

// --------------------------------------------------------------------------------------------
// isSubtreeOf
// --------------------------------------------------------------------------------------------

/**
 * True if `left` is a structural subtree of `right`: every key in left exists in right with an
 * equal value (recursively for nested maps). Both sides must be string-keyed maps; anything else
 * - a list, a scalar, even against itself - is false, exactly as the C# guard.
 */
function isSubtreeOf(left: unknown, right: unknown): boolean {
  const l = asStringKeyedMap(left);
  const r = asStringKeyedMap(right);
  if (l === undefined || r === undefined) return false;

  for (const [key, lv] of l) {
    if (!r.has(key)) return false;
    const rv = r.get(key);

    if (asStringKeyedMap(lv) !== undefined && asStringKeyedMap(rv) !== undefined) {
      if (!isSubtreeOf(lv, rv)) return false;
    } else if (!valuesEqual(lv, rv)) {
      return false;
    }
  }

  return true;
}

/**
 * Views a value as a string-keyed map, or `undefined` when it is not one.
 *
 * A map reaches a custom function in two shapes and both must work. A map LITERAL plans to a
 * `CelMap` whose entries are themselves adapted CEL values; `env.set(name, new Map(...))` produces
 * a `CelMap` whose entries are still the RAW native objects handed in (a plain `Map`, a plain
 * array). The variable form is the one `CaveatEvaluator` actually supplies.
 */
function asStringKeyedMap(value: unknown): ReadonlyMap<string, unknown> | undefined {
  if (value instanceof CelMap) return asStringKeyedMap(value.value);
  if (value instanceof CelObject) {
    return new Map(Object.entries(value.value as Record<string, unknown>));
  }
  if (value instanceof Map) {
    const entries = value as ReadonlyMap<unknown, unknown>;
    for (const key of entries.keys()) {
      if (typeof key !== "string") return undefined;
    }
    return entries as ReadonlyMap<string, unknown>;
  }
  return undefined;
}

/**
 * The C# `ValuesEqual`: two numerics are compared by converting BOTH to double, so `1L == 1.0`.
 * In CEL-JS an int is a `bigint`, a double is a `number` and a uint is a `CelUint`, and
 * `1n !== 1`, so the cross-width comparison has to be spelled out or every mixed-width subtree
 * check silently regresses to false.
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === undefined || a === null || b === undefined || b === null) return a === b;

  const an = asNumber(a);
  const bn = asNumber(b);
  if (an !== undefined && bn !== undefined) return an === bn;

  if (a instanceof Uint8Array && b instanceof Uint8Array) return bytesEqual(a, b);

  if (a instanceof CelList && b instanceof CelList) return false; // the C# compares lists by reference
  return a === b;
}

/** `Convert.ToDouble` over the CEL numeric carriers, or `undefined` for a non-numeric. */
function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof CelUint) return Number(value.value);
  return undefined;
}
