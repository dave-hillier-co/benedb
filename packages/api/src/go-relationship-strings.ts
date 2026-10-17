import type { Relationship } from "@benedb/protos/authzed/api/v1/core";

/**
 * Ported from Spiceport `src/Spiceport.Api/GoRelationshipStrings.cs`.
 *
 * SpiceDB's string forms of an `authzed.api.v1` relationship (`pkg/tuple/v1.go`), which its error
 * messages and `ErrorInfo` metadata quote: `resource:id#relation@subject:id[#relation]`, then for
 * {@link full} the caveat as `[name:{context}]` and the expiration as `[expiration:RFC3339Nano]`.
 *
 * The caveat context is Go protojson's compact rendering of a `Struct`: keys sorted, no
 * insignificant whitespace. (protojson deliberately perturbs its whitespace per build, so a given
 * SpiceDB binary may add a space after a separator; the compact form is the canonical one.)
 *
 * Port decisions:
 *   * ts-proto unwraps a `Struct` to a plain object and a `Timestamp` to a `Date`, so the context is
 *     walked as JSON values and the expiration carries millisecond precision.
 */

/** `V1StringRelationshipWithoutCaveatOrExpiration`. */
export function withoutCaveatOrExpiration(rel: Relationship): string {
  const subject = rel.subject;
  const object = subject?.object;
  let subjectText = `${object?.objectType ?? ""}:${object?.objectId ?? ""}`;
  if ((subject?.optionalRelation ?? "") !== "")
    subjectText += `#${subject?.optionalRelation ?? ""}`;
  return `${rel.resource?.objectType ?? ""}:${rel.resource?.objectId ?? ""}#${rel.relation}@${subjectText}`;
}

/** `MustV1StringRelationship`: the relationship with its caveat and expiration. */
export function full(rel: Relationship): string {
  let text = withoutCaveatOrExpiration(rel);
  const caveat = rel.optionalCaveat;
  if (caveat !== undefined && caveat.caveatName !== "") {
    text += `[${caveat.caveatName}`;
    const context = caveat.context;
    if (context !== undefined && Object.keys(context).length > 0) text += `:${goJson(context)}`;
    text += "]";
  }

  if (rel.optionalExpiresAt !== undefined)
    text += `[expiration:${rfc3339Nano(rel.optionalExpiresAt)}]`;

  return text;
}

/** Go's `time.RFC3339Nano` of a UTC instant: trailing fractional zeros dropped, `Z` zone. */
function rfc3339Nano(date: Date): string {
  const iso = date.toISOString(); // yyyy-MM-ddTHH:mm:ss.fffZ
  const [seconds, fraction = ""] = iso.slice(0, -1).split(".");
  const trimmed = fraction.replace(/0+$/u, "");
  return `${seconds ?? ""}${trimmed === "" ? "" : `.${trimmed}`}Z`;
}

function goJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return goString(value);
  if (typeof value === "number") return goFloat(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(goJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, field]) => `${goString(key)}:${goJson(field)}`).join(",")}}`;
}

/** protojson's string escaping: `"`, `\` and control characters only. */
function goString(value: string): string {
  let text = '"';
  for (const ch of value) {
    switch (ch) {
      case '"':
        text += '\\"';
        break;
      case "\\":
        text += "\\\\";
        break;
      case "\b":
        text += "\\b";
        break;
      case "\f":
        text += "\\f";
        break;
      case "\n":
        text += "\\n";
        break;
      case "\r":
        text += "\\r";
        break;
      case "\t":
        text += "\\t";
        break;
      default: {
        const code = ch.codePointAt(0) ?? 0;
        text += code < 0x20 ? `\\u${code.toString(16).padStart(4, "0")}` : ch;
      }
    }
  }
  return `${text}"`;
}

/**
 * protojson's rendering of a double: the shortest round-trip digits, in plain notation for
 * magnitudes in [1e-6, 1e21) and Go's exponent notation (`1e+21`, `1e-07` shortened to `1e-7`)
 * otherwise.
 */
export function goFloat(value: number): string {
  if (Number.isNaN(value)) return '"NaN"';
  if (!Number.isFinite(value)) return value > 0 ? '"Infinity"' : '"-Infinity"';
  if (value === 0) return "0";

  const negative = value < 0;
  const { digits, point } = decompose(Math.abs(value).toExponential());
  const sign = negative ? "-" : "";
  const abs = Math.abs(value);

  if (abs < 1e-6 || abs >= 1e21) {
    const mantissa = digits.length === 1 ? digits : `${digits[0] ?? ""}.${digits.slice(1)}`;
    const exponent = point - 1;
    let exponentText =
      exponent < 0
        ? `-${String(-exponent).padStart(2, "0")}`
        : `+${String(exponent).padStart(2, "0")}`;
    if (exponentText.length === 3 && exponentText.startsWith("-0"))
      exponentText = `-${exponentText.charAt(2)}`;
    return `${sign}${mantissa}e${exponentText}`;
  }

  let plain: string;
  if (point <= 0) plain = `0.${"0".repeat(-point)}${digits}`;
  else if (point >= digits.length) plain = digits + "0".repeat(point - digits.length);
  else plain = `${digits.slice(0, point)}.${digits.slice(point)}`;
  return sign + plain;
}

/** Splits JavaScript's shortest exponential text (`d.ddde±x`) into digits and the point position. */
function decompose(text: string): { digits: string; point: number } {
  const [mantissa = "", exponent = "0"] = text.split("e");
  const digits = mantissa.replace(".", "").replace(/0+$/u, "");
  return { digits: digits === "" ? "0" : digits, point: Number(exponent) + 1 };
}
