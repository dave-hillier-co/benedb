import {
  createFileRegistry,
  fromBinary,
  getOption,
  hasOption,
  toJson,
  type DescExtension,
  type DescField,
  type DescMessage,
  type DescOneof,
  type FileRegistry,
} from "@bufbuild/protobuf";
import { FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { AUTHZED_API_V1_DESCRIPTOR_SET } from "@benedb/protos/authzed-api-v1-descriptor-set";

/**
 * Ported from Spiceport `src/Spiceport.Api/ProtoValidation.cs`.
 *
 * The protoc-gen-validate (PGV) request contract of the vendored `authzed.api.v1` protos, read from
 * their `(validate.rules)` annotations at run time. SpiceDB's first interceptor, go-grpc-middleware's
 * `validator`, calls the `ValidateAll` method PGV generated into authzed-go for every request message
 * and rejects a violation with INVALID_ARGUMENT and `err.Error()` as the detail. {@link validateAll}
 * reproduces that method generically: the same checks, in the same order, with the same text.
 *
 * The order follows PGV's Go message template: the fields outside any oneof in declaration order,
 * then each oneof, then proto3 `optional` fields. Each violation reads
 * `invalid {GoMessage}.{GoField}: {reason}`; a nested message's own violations follow
 * `embedded message failed validation | caused by: `, and the violations of one message are joined
 * with `"; "` (PGV's `MultiError`).
 *
 * A rule this module does not implement throws when the message's plan is first built, so a vendored
 * proto that grows a new kind of rule fails loudly in tests rather than being silently unenforced.
 *
 * Port decisions:
 *   * ts-proto drops descriptor options, so the rules come from the FileDescriptorSet that
 *     `packages/protos/scripts/generate.sh` embeds, read through `@bufbuild/protobuf`'s registry; an
 *     extension value is read as its proto JSON, whose keys are exactly the rules that are set.
 *   * A ts-proto message is a plain object with no type tag, so the caller names the message type
 *     (`"authzed.api.v1.CheckPermissionRequest"`) where the C# reads `IMessage.Descriptor`.
 *   * A field is read by its descriptor's `localName`, which is ts-proto's property name. An absent
 *     message (or unset oneof member) is `undefined`; a `Struct` arrives unwrapped as a plain object
 *     and a `Timestamp` as a `Date`, neither of which PGV validates.
 */

const EMBEDDED_FAILURE = "embedded message failed validation";

/** One check over a message: appends any violations it finds. */
type Check = (message: Record<string, unknown>, violations: string[]) => void;

/** One check over a single field value, reported under `label` (`Field` or `Field[i]`). */
type ElementCheck = (value: unknown, label: string, violations: string[]) => void;

/** The `validate.FieldRules` subset this module reads, as proto JSON (uint64 values are strings). */
interface FieldRules {
  readonly message?: { readonly required?: boolean; readonly skip?: boolean };
  readonly string?: StringRules;
  readonly enum?: EnumRules;
  readonly bool?: { readonly const?: boolean };
  readonly uint32?: NumberRules;
  readonly repeated?: RepeatedRules;
  readonly [other: string]: unknown;
}

interface StringRules {
  readonly const?: string;
  readonly len?: string;
  readonly minLen?: string;
  readonly maxLen?: string;
  readonly lenBytes?: string;
  readonly minBytes?: string;
  readonly maxBytes?: string;
  readonly pattern?: string;
  readonly prefix?: string;
  readonly suffix?: string;
  readonly contains?: string;
  readonly notContains?: string;
  readonly in?: readonly string[];
  readonly notIn?: readonly string[];
  readonly ignoreEmpty?: boolean;
  readonly [wellKnown: string]: unknown;
}

interface EnumRules {
  readonly const?: number;
  readonly definedOnly?: boolean;
  readonly in?: readonly number[];
  readonly notIn?: readonly number[];
}

interface NumberRules {
  readonly const?: number;
  readonly lt?: number;
  readonly lte?: number;
  readonly gt?: number;
  readonly gte?: number;
  readonly in?: readonly number[];
  readonly notIn?: readonly number[];
  readonly ignoreEmpty?: boolean;
}

interface RepeatedRules {
  readonly minItems?: string;
  readonly maxItems?: string;
  readonly unique?: boolean;
  readonly items?: FieldRules;
  readonly ignoreEmpty?: boolean;
}

const STRING_RULE_KEYS = new Set([
  "const",
  "len",
  "minLen",
  "maxLen",
  "lenBytes",
  "minBytes",
  "maxBytes",
  "pattern",
  "prefix",
  "suffix",
  "contains",
  "notContains",
  "in",
  "notIn",
]);

interface Registry {
  readonly files: FileRegistry;
  readonly rules: DescExtension;
  readonly required: DescExtension;
  readonly disabled: DescExtension;
  readonly ignored: DescExtension;
}

let registry: Registry | undefined;

function theRegistry(): Registry {
  if (registry === undefined) {
    const files = createFileRegistry(
      fromBinary(FileDescriptorSetSchema, Buffer.from(AUTHZED_API_V1_DESCRIPTOR_SET, "base64")),
    );
    const extension = (name: string): DescExtension => {
      const found = files.getExtension(name);
      if (found === undefined) throw new Error(`descriptor set has no extension ${name}`);
      return found;
    };
    registry = {
      files,
      rules: extension("validate.rules"),
      required: extension("validate.required"),
      disabled: extension("validate.disabled"),
      ignored: extension("validate.ignored"),
    };
  }
  return registry;
}

/**
 * The descriptor of the fully qualified `typeName` from the embedded descriptor set, which other
 * Go-text renderings (`go-prototext.ts`) walk as this module does.
 */
export function messageDescriptor(typeName: string): DescMessage {
  const found = theRegistry().files.getMessage(typeName);
  if (found === undefined) throw new Error(`unknown message type ${typeName}`);
  return found;
}

const plans = new Map<DescMessage, Plan>();

/**
 * Returns PGV's `ValidateAll()` error text for `message` of the fully qualified `typeName`, or
 * `undefined` when the message satisfies every rule.
 */
export function validateAll(typeName: string, message: object): string | undefined {
  const found = violations(messageDescriptor(typeName), message);
  return found.length === 0 ? undefined : found.join("; ");
}

/**
 * Builds the plan for `typeName` and every message reachable from it, throwing for a rule this
 * module does not implement.
 */
export function ensureSupported(typeName: string): void {
  const visited = new Set<DescMessage>();
  const pending = [messageDescriptor(typeName)];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (visited.has(next) || !hasValidator(next)) continue;
    visited.add(next);
    planFor(next);
    for (const field of next.fields) {
      if (field.message !== undefined) pending.push(field.message);
    }
  }
}

function violations(descriptor: DescMessage, message: object): string[] {
  const found: string[] = [];
  planFor(descriptor).run(message as Record<string, unknown>, found);
  return found;
}

/**
 * The cached plan for `descriptor`. A plan holds only its own message's checks; an embedded
 * message's plan is looked up when that message is validated, so a recursive message type needs no
 * special handling.
 */
function planFor(descriptor: DescMessage): Plan {
  let plan = plans.get(descriptor);
  if (plan === undefined) {
    plan = new Plan(descriptor);
    plans.set(descriptor, plan);
  }
  return plan;
}

/**
 * Whether PGV generated a validator for `descriptor`'s Go type. The well-known `google.protobuf`
 * types have none, so an embedded one is never validated.
 */
function hasValidator(descriptor: DescMessage): boolean {
  if (descriptor.file.proto.package === "google.protobuf") return false;
  const { ignored } = theRegistry();
  return !(hasOption(descriptor, ignored) && getOption(descriptor, ignored) === true);
}

function fieldRules(field: DescField): FieldRules | undefined {
  const { rules } = theRegistry();
  if (!hasOption(field, rules)) return undefined;
  const value = getOption(field, rules) as never;
  return toJson(rules.message as DescMessage, value) as FieldRules;
}

/** The `type` oneof case of a `FieldRules`: every key but the separate `message` rules. */
function typeCase(rules: FieldRules | undefined): string | undefined {
  if (rules === undefined) return undefined;
  return Object.keys(rules).find((key) => key !== "message");
}

/** One message's checks, in PGV's order. */
class Plan {
  private readonly goMessage: string;
  private readonly checks: Check[];

  constructor(private readonly descriptor: DescMessage) {
    this.goMessage = goMessageName(descriptor);
    this.checks = this.build();
  }

  run(message: Record<string, unknown>, found: string[]): void {
    for (const check of this.checks) check(message, found);
  }

  private build(): Check[] {
    const built: Check[] = [];
    const { disabled } = theRegistry();
    if (hasOption(this.descriptor, disabled) && getOption(this.descriptor, disabled) === true)
      return built;

    for (const field of this.descriptor.fields) {
      if (field.oneof === undefined && field.proto.proto3Optional !== true)
        this.addFieldChecks(built, field, false);
    }

    for (const oneof of this.descriptor.oneofs) this.addOneofChecks(built, oneof);

    for (const field of this.descriptor.fields) {
      if (field.proto.proto3Optional === true) this.addFieldChecks(built, field, true);
    }

    return built;
  }

  private violation(field: string, reason: string): string {
    return `invalid ${this.goMessage}.${field}: ${reason}`;
  }

  private embedded(field: string, causes: readonly string[]): string {
    return this.violation(field, `${EMBEDDED_FAILURE} | caused by: ${causes.join("; ")}`);
  }

  private addOneofChecks(built: Check[], oneof: DescOneof): void {
    const perField = new Map<string, Check[]>();
    for (const field of oneof.fields) perField.set(field.localName, this.valueChecks(field, true));

    const { required: requiredOption } = theRegistry();
    const required = hasOption(oneof, requiredOption) && getOption(oneof, requiredOption) === true;
    const oneofName = goName(oneof.name);
    built.push((message, found) => {
      // ts-proto flattens a oneof into optional properties; at most one is set on the wire.
      const set = oneof.fields.find((field) => message[field.localName] !== undefined);
      if (set !== undefined) {
        for (const check of perField.get(set.localName) ?? []) check(message, found);
      } else if (required) {
        found.push(this.violation(oneofName, "value is required"));
      }
    });
  }

  private addFieldChecks(built: Check[], field: DescField, presenceGuarded: boolean): void {
    const fieldChecks = this.valueChecks(field, false);
    if (fieldChecks.length === 0) return;

    if (!presenceGuarded) {
      built.push(...fieldChecks);
      return;
    }

    built.push((message, found) => {
      if (message[field.localName] === undefined) return;
      for (const check of fieldChecks) check(message, found);
    });
  }

  /** The checks for one field's value, rendered as PGV renders its rule type. */
  private valueChecks(field: DescField, inOneof: boolean): Check[] {
    const rules = fieldRules(field);
    const name = goName(field.name);

    if (field.fieldKind === "map") {
      if (rules !== undefined || field.mapKind === "message") throw this.unsupported(field, "map");
      return [];
    }

    if (field.fieldKind === "list") return this.repeatedChecks(field, name, rules);

    const element = this.elementChecks(field, rules, inOneof);
    if (element === undefined) return [];
    return [(message, found) => element(message[field.localName], name, found)];
  }

  private repeatedChecks(field: DescField, name: string, rules: FieldRules | undefined): Check[] {
    const result: Check[] = [];
    let repeated: RepeatedRules | undefined;
    if (rules !== undefined) {
      if (typeCase(rules) !== "repeated") throw this.unsupported(field, typeCase(rules) ?? "?");
      repeated = rules.repeated;
    }

    if (repeated?.ignoreEmpty === true || repeated?.unique === true)
      throw this.unsupported(field, "repeated ignore_empty/unique");

    const minItems = Number(repeated?.minItems ?? 0);
    const maxItems = Number(repeated?.maxItems ?? 0);
    if (minItems !== 0 || maxItems !== 0) {
      result.push((message, found) => {
        const items = message[field.localName] as readonly unknown[] | undefined;
        const reason = itemCountViolation(items?.length ?? 0, minItems, maxItems);
        if (reason !== undefined) found.push(this.violation(name, reason));
      });
    }

    const element = this.elementChecks(field, repeated?.items, false);
    if (element === undefined) return result;

    result.push((message, found) => {
      const items = (message[field.localName] as readonly unknown[] | undefined) ?? [];
      items.forEach((item, index) => element(item, `${name}[${index}]`, found));
    });
    return result;
  }

  /**
   * The checks for a single value of `field`'s element type, or `undefined` when there are none.
   */
  private elementChecks(
    field: DescField,
    rules: FieldRules | undefined,
    inOneof: boolean,
  ): ElementCheck | undefined {
    if (field.message !== undefined)
      return this.messageChecks(field, field.message, rules, inOneof);

    const kind = typeCase(rules);
    if (rules === undefined || kind === undefined) return undefined;

    switch (kind) {
      case "string":
        return this.stringChecks(field, rules.string ?? {});
      case "enum":
        return this.enumChecks(field, rules.enum ?? {});
      case "bool":
        return this.boolChecks(rules.bool ?? {});
      case "uint32":
        return this.numberChecks(field, rules.uint32 ?? {});
      default:
        throw this.unsupported(field, kind);
    }
  }

  private messageChecks(
    field: DescField,
    type: DescMessage,
    rules: FieldRules | undefined,
    inOneof: boolean,
  ): ElementCheck | undefined {
    // PGV keeps a message field's own rules outside FieldRules.type; a type rule here would be a
    // well-known-type rule (Any, Duration, Timestamp), which this module does not implement.
    const kind = typeCase(rules);
    if (kind !== undefined) throw this.unsupported(field, kind);

    // A message set in a oneof is present by construction: PGV's required check cannot fire there.
    const required = rules?.message?.required === true && !inOneof;
    const embedded = rules?.message?.skip !== true && hasValidator(type);
    if (!required && !embedded) return undefined;

    return (value, label, found) => {
      if (value === undefined || value === null) {
        if (required) found.push(this.violation(label, "value is required"));
        return;
      }

      if (!embedded) return;

      const causes = violations(type, value as object);
      if (causes.length > 0) found.push(this.embedded(label, causes));
    };
  }

  private stringChecks(field: DescField, r: StringRules): ElementCheck | undefined {
    if (r.ignoreEmpty === true || Object.keys(r).some((key) => !STRING_RULE_KEYS.has(key)))
      throw this.unsupported(field, "string ignore_empty/well-known format");

    const tests: ((s: string) => string | undefined)[] = [];
    const has = (key: keyof StringRules): boolean => r[key] !== undefined;
    const n = (key: keyof StringRules): number => Number(r[key]);

    if (r.const !== undefined) {
      const expected = r.const;
      tests.push((s) => (s !== expected ? `value must equal ${expected}` : undefined));
    }

    if (r.in !== undefined && r.in.length > 0) {
      const list = r.in;
      tests.push((s) => (list.includes(s) ? undefined : `value must be in list ${goList(list)}`));
    } else if (r.notIn !== undefined && r.notIn.length > 0) {
      const list = r.notIn;
      tests.push((s) =>
        list.includes(s) ? `value must not be in list ${goList(list)}` : undefined,
      );
    }

    if (has("len") || (has("minLen") && has("maxLen") && n("minLen") === n("maxLen"))) {
      const exact = has("len") ? n("len") : n("minLen");
      tests.push((s) => (runes(s) !== exact ? `value length must be ${exact} runes` : undefined));
    } else if (has("minLen")) {
      const min = n("minLen");
      const max = n("maxLen");
      tests.push(
        has("maxLen")
          ? (s) =>
              runes(s) < min || runes(s) > max
                ? `value length must be between ${min} and ${max} runes, inclusive`
                : undefined
          : (s) => (runes(s) < min ? `value length must be at least ${min} runes` : undefined),
      );
    } else if (has("maxLen")) {
      const max = n("maxLen");
      tests.push((s) => (runes(s) > max ? `value length must be at most ${max} runes` : undefined));
    }

    if (
      has("lenBytes") ||
      (has("minBytes") && has("maxBytes") && n("minBytes") === n("maxBytes"))
    ) {
      const exact = has("lenBytes") ? n("lenBytes") : n("minBytes");
      tests.push((s) => (bytes(s) !== exact ? `value length must be ${exact} bytes` : undefined));
    } else if (has("minBytes")) {
      const min = n("minBytes");
      const max = n("maxBytes");
      tests.push(
        has("maxBytes")
          ? (s) =>
              bytes(s) < min || bytes(s) > max
                ? `value length must be between ${min} and ${max} bytes, inclusive`
                : undefined
          : (s) => (bytes(s) < min ? `value length must be at least ${min} bytes` : undefined),
      );
    } else if (has("maxBytes")) {
      const max = n("maxBytes");
      tests.push((s) => (bytes(s) > max ? `value length must be at most ${max} bytes` : undefined));
    }

    if (r.prefix !== undefined) {
      const prefix = r.prefix;
      tests.push((s) =>
        s.startsWith(prefix) ? undefined : `value does not have prefix ${goQuote(prefix)}`,
      );
    }
    if (r.suffix !== undefined) {
      const suffix = r.suffix;
      tests.push((s) =>
        s.endsWith(suffix) ? undefined : `value does not have suffix ${goQuote(suffix)}`,
      );
    }
    if (r.contains !== undefined) {
      const part = r.contains;
      tests.push((s) =>
        s.includes(part) ? undefined : `value does not contain substring ${goQuote(part)}`,
      );
    }
    if (r.notContains !== undefined) {
      const part = r.notContains;
      tests.push((s) =>
        s.includes(part) ? `value contains substring ${goQuote(part)}` : undefined,
      );
    }

    if (r.pattern !== undefined) {
      const regex = goRegex(r.pattern);
      const reason = `value does not match regex pattern ${goQuote(r.pattern)}`;
      tests.push((s) => (regex.test(s) ? undefined : reason));
    }

    return this.scalar(tests);
  }

  private enumChecks(field: DescField, r: EnumRules): ElementCheck | undefined {
    const values = field.enum?.values ?? [];
    const nameOf = (number: number): string =>
      values.find((value) => value.number === number)?.name ?? String(number);

    const tests: ((v: number) => string | undefined)[] = [];
    if (r.const !== undefined) {
      const expected = r.const;
      tests.push((v) => (v !== expected ? `value must equal ${nameOf(expected)}` : undefined));
    }
    if (r.in !== undefined && r.in.length > 0) {
      const list = r.in;
      tests.push((v) =>
        list.includes(v) ? undefined : `value must be in list [${list.map(nameOf).join(" ")}]`,
      );
    } else if (r.notIn !== undefined && r.notIn.length > 0) {
      const list = r.notIn;
      tests.push((v) =>
        list.includes(v) ? `value must not be in list [${list.map(nameOf).join(" ")}]` : undefined,
      );
    }
    if (r.definedOnly === true)
      tests.push((v) =>
        values.some((value) => value.number === v)
          ? undefined
          : "value must be one of the defined enum values",
      );

    return this.scalar(tests);
  }

  private boolChecks(r: { readonly const?: boolean }): ElementCheck | undefined {
    if (r.const === undefined) return undefined;
    const expected = r.const;
    return this.scalar<boolean>([
      (v) => (v !== expected ? `value must equal ${String(expected)}` : undefined),
    ]);
  }

  private numberChecks(field: DescField, r: NumberRules): ElementCheck | undefined {
    const upper = r.lt !== undefined || r.lte !== undefined;
    const lower = r.gt !== undefined || r.gte !== undefined;
    if (r.ignoreEmpty === true || (upper && lower))
      throw this.unsupported(field, "uint32 ignore_empty/range");

    const tests: ((v: number) => string | undefined)[] = [];
    if (r.const !== undefined) {
      const expected = r.const;
      tests.push((v) => (v !== expected ? `value must equal ${expected}` : undefined));
    }
    if (r.lt !== undefined) {
      const bound = r.lt;
      tests.push((v) => (v >= bound ? `value must be less than ${bound}` : undefined));
    } else if (r.lte !== undefined) {
      const bound = r.lte;
      tests.push((v) => (v > bound ? `value must be less than or equal to ${bound}` : undefined));
    } else if (r.gt !== undefined) {
      const bound = r.gt;
      tests.push((v) => (v <= bound ? `value must be greater than ${bound}` : undefined));
    } else if (r.gte !== undefined) {
      const bound = r.gte;
      tests.push((v) =>
        v < bound ? `value must be greater than or equal to ${bound}` : undefined,
      );
    }
    if (r.in !== undefined && r.in.length > 0) {
      const list = r.in;
      tests.push((v) =>
        list.includes(v) ? undefined : `value must be in list [${list.join(" ")}]`,
      );
    } else if (r.notIn !== undefined && r.notIn.length > 0) {
      const list = r.notIn;
      tests.push((v) =>
        list.includes(v) ? `value must not be in list [${list.join(" ")}]` : undefined,
      );
    }

    return this.scalar(tests);
  }

  private scalar<T>(
    tests: readonly ((value: T) => string | undefined)[],
  ): ElementCheck | undefined {
    if (tests.length === 0) return undefined;
    return (value, label, found) => {
      for (const test of tests) {
        const reason = test(value as T);
        if (reason !== undefined) found.push(this.violation(label, reason));
      }
    };
  }

  private unsupported(field: DescField, rule: string): Error {
    return new Error(
      `protoc-gen-validate rule '${rule}' on ${this.descriptor.typeName}.${field.name} is not implemented`,
    );
  }
}

function itemCountViolation(count: number, min: number, max: number): string | undefined {
  if (min !== 0) {
    if (min === max) return count !== min ? `value must contain exactly ${min} item(s)` : undefined;
    if (max !== 0)
      return count < min || count > max
        ? `value must contain between ${min} and ${max} items, inclusive`
        : undefined;
    return count < min ? `value must contain at least ${min} item(s)` : undefined;
  }

  return max !== 0 && count > max ? `value must contain no more than ${max} item(s)` : undefined;
}

function runes(s: string): number {
  let count = 0;
  for (const _ of s) count++;
  return count;
}

function bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** Go's `fmt.Sprint` of a `[]string`: the items space-separated in brackets. */
function goList(items: readonly string[]): string {
  return `[${items.join(" ")}]`;
}

/**
 * Compiles a PGV (Go RE2) pattern for JavaScript. Without the `m` flag both RE2's and JavaScript's
 * `$` match only at the very end of the input, so the pattern carries over as written; the `u` flag
 * makes a class match whole code points as RE2 does.
 */
export function goRegex(pattern: string): RegExp {
  return new RegExp(pattern, "u");
}

/** Go's `strconv.Quote`, which PGV's `%q` applies to a pattern or literal in a reason. */
export function goQuote(s: string): string {
  let quoted = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    switch (ch) {
      case '"':
        quoted += '\\"';
        break;
      case "\\":
        quoted += "\\\\";
        break;
      case "\x07":
        quoted += "\\a";
        break;
      case "\b":
        quoted += "\\b";
        break;
      case "\f":
        quoted += "\\f";
        break;
      case "\n":
        quoted += "\\n";
        break;
      case "\r":
        quoted += "\\r";
        break;
      case "\t":
        quoted += "\\t";
        break;
      case "\v":
        quoted += "\\v";
        break;
      default:
        if (isGoPrintable(ch)) quoted += ch;
        else if (cp < 0x20 || cp === 0x7f) quoted += `\\x${cp.toString(16).padStart(2, "0")}`;
        else if (cp < 0x10000) quoted += `\\u${cp.toString(16).padStart(4, "0")}`;
        else quoted += `\\U${cp.toString(16).padStart(8, "0")}`;
    }
  }
  return `${quoted}"`;
}

function isGoPrintable(ch: string): boolean {
  return ch === " " || !/[\p{C}\p{Z}]/u.test(ch);
}

/**
 * The Go type name protoc-gen-go gives a message: a nested message is its parent's name, `_`, and
 * its own (`SubjectFilter_RelationFilter`).
 */
function goMessageName(descriptor: DescMessage): string {
  return descriptor.parent === undefined
    ? goName(descriptor.name)
    : `${goMessageName(descriptor.parent)}_${goName(descriptor.name)}`;
}

/** protoc-gen-go's `GoCamelCase`, which names the Go field (and PGV's error label). */
export function goName(name: string): string {
  const isLower = (c: string | undefined): boolean => c !== undefined && c >= "a" && c <= "z";
  const isDigit = (c: string): boolean => c >= "0" && c <= "9";
  let b = "";
  for (let i = 0; i < name.length; i++) {
    const c = name.charAt(i);
    if (c === "." && isLower(name[i + 1])) continue;
    if (c === ".") {
      b += "_";
    } else if (c === "_" && (i === 0 || name[i - 1] === ".")) {
      b += "X";
    } else if (c === "_" && isLower(name[i + 1])) {
      // Dropped; the following lower-case letter is capitalised below.
    } else if (isDigit(c)) {
      b += c;
    } else {
      b += isLower(c) ? c.toUpperCase() : c;
      for (; isLower(name[i + 1]); i++) b += name.charAt(i + 1);
    }
  }
  return b;
}
