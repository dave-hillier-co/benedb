import { ScalarType, type DescMessage } from "@bufbuild/protobuf";

import { messageDescriptor } from "./proto-validation";

/**
 * Ported from Spiceport `src/Spiceport.Api/GoPrototext.cs`.
 *
 * Go's `String()` of a generated protobuf message (`prototext`, single-line): each populated field as
 * `name:value` in declaration order, separated by one space, a string quoted and a message in
 * braces. SpiceDB quotes it in `ErrorInfo` metadata, e.g. `InvalidFilterError`'s `filter`.
 *
 * Only the field shapes the quoted messages use are supported: singular strings (whose validated
 * values are printable ASCII, so escaping a quote and a backslash suffices) and singular messages.
 * Go's prototext deliberately perturbs its whitespace per build; a given SpiceDB binary may add a
 * space after a separator, and the single-space form here is the canonical one.
 *
 * Port decisions: a ts-proto message carries no type, so the caller names it (`typeName`, fully
 * qualified) and its descriptor comes from the embedded descriptor set `proto-validation.ts` reads;
 * a field is read by its descriptor's `localName`, an absent message being `undefined`.
 */
export function formatGoPrototext(typeName: string, message: object): string {
  return format(messageDescriptor(typeName), message as Record<string, unknown>);
}

function format(descriptor: DescMessage, message: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const field of descriptor.fields) {
    const value = message[field.localName];
    if (field.fieldKind === "scalar" && field.scalar === ScalarType.STRING) {
      const s = (value as string | undefined) ?? "";
      if (s.length === 0) continue;
      parts.push(`${field.name}:${quote(s)}`);
    } else if (field.fieldKind === "message") {
      if (value === undefined) continue;
      parts.push(`${field.name}:{${format(field.message, value as Record<string, unknown>)}}`);
    } else {
      throw new Error(`prototext of ${field.fieldKind} field ${field.toString()} is not supported`);
    }
  }
  return parts.join(" ");
}

function quote(s: string): string {
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
