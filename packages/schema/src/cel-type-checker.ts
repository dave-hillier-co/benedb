import { CEL_DECLARATIONS } from "./cel-declarations";
import type { CelFunction } from "./cel-declarations";
import type {
  CelCall,
  CelComprehension,
  CelExpr,
  CelIdent,
  CelList,
  CelLiteralKind,
  CelLocation,
  CelMap,
  CelSelect,
  CelStruct,
} from "./cel-expr";
import type { CelIssues } from "./cel-issues";
import { CheckedType } from "./checked-type";

type Mapping = Map<string, CheckedType>;

/**
 * A static CEL type checker over a parsed expression (`CelExpr`): a transliteration of cel-go's
 * `checker/checker.go`, `checker/types.go` and the parts of `checker/env.go` the SpiceDB caveat
 * environment exercises (`authzed/cel-go` v0.20.2). It computes each node's type, unifying the
 * standard library's type-parameterized overloads, and reports the errors cel-go's checker reports,
 * with its wording.
 *
 * Faithfully reproduced cel-go behaviours that are easy to "fix" by accident:
 *   * Mixed int/uint/double ordering overloads (`1 < 1.0`) are disabled, but a comprehension (any
 *     macro) replaces the environment with one built without that filter, so they are enabled from
 *     then on (cel-go's `Env.enterScope`/`exitScope` drop `filteredOverloadIDs`).
 *   * Heterogeneous list and map literals join to `dyn` rather than failing.
 *   * A `dyn` or error operand is assignable everywhere, so a type error is reported once, at its
 *     source, and does not cascade.
 *
 * Ported from Spiceport `Engine/CelCheck/CelTypeChecker.cs`.
 *
 * Port decisions:
 *   * The C# private-constructor class with a static `Check` entry point becomes an exported
 *     function over a module-private class holding the walk's state.
 *   * The type map is a `Map` keyed by node identity, as the C# dictionary uses
 *     `ReferenceEqualityComparer`.
 */
export function checkCelExpr(
  expr: CelExpr,
  variables: ReadonlyMap<string, CheckedType>,
  errors: CelIssues,
): CheckedType {
  const checker = new TypeChecker(variables, errors);
  checker.checkExpr(expr);
  return substitute(checker.mapping, checker.getType(expr) ?? CheckedType.dyn, true);
}

class TypeChecker {
  readonly #errors: CelIssues;
  readonly #types = new Map<CelExpr, CheckedType>();
  readonly #scopes: Map<string, CheckedType>[];
  mapping: Mapping = new Map();
  #freeTypeVarCounter = 0;
  #crossTypeNumericComparisonsDisabled = true;

  constructor(variables: ReadonlyMap<string, CheckedType>, errors: CelIssues) {
    this.#errors = errors;
    const global = new Map(CEL_DECLARATIONS.typeIdentifiers);
    for (const [name, type] of variables) global.set(name, type);
    this.#scopes = [global];
  }

  checkExpr(e: CelExpr | undefined): void {
    if (e === undefined) return;
    switch (e.kind) {
      case "literal":
        this.#setType(e, literalType(e.literalKind));
        return;
      case "ident":
        this.#checkIdent(e);
        return;
      case "select":
        this.#checkSelect(e);
        return;
      case "call":
        this.#checkCall(e);
        return;
      case "list":
        this.#checkCreateList(e);
        return;
      case "map":
        this.#checkCreateMap(e);
        return;
      case "struct":
        this.#checkCreateStruct(e);
        return;
      case "comprehension":
        this.#checkComprehension(e);
        return;
      case "unspecified":
        this.#errors.report(e.location, "unexpected unspecified type: Expr");
        return;
      default:
        assertNever(e);
    }
  }

  #checkIdent(e: CelIdent): void {
    const type = this.#lookupIdent(e.name);
    if (type !== undefined) {
      this.#setType(e, type);
      return;
    }

    this.#setType(e, CheckedType.error);
    this.#undeclaredReference(e.location, e.name);
  }

  #checkSelect(e: CelSelect): void {
    // Before traversing down the tree, try to interpret as a qualified name.
    const qualified = toQualifiedName(e);
    if (qualified !== undefined) {
      const identType = this.#lookupIdent(qualified);
      if (identType !== undefined) {
        this.#setType(e, identType);
        return;
      }
    }

    let resultType = this.#checkSelectField(e, e.operand, e.field, false);
    if (e.testOnly) resultType = CheckedType.bool;
    this.#setType(e, substitute(this.mapping, resultType, false));
  }

  #checkOptSelect(e: CelCall): void {
    const operand = e.args[0] as CelExpr;
    const field = e.args[1] as CelExpr;
    if (
      field.kind !== "literal" ||
      field.literalKind !== "string" ||
      field.stringValue === undefined
    ) {
      this.#errors.report(field.location, "unsupported optional field selection");
      return;
    }

    const resultType = this.#checkSelectField(e, operand, field.stringValue, true);
    this.#setType(e, substitute(this.mapping, resultType, false));
  }

  #checkSelectField(e: CelExpr, operand: CelExpr, field: string, optional: boolean): CheckedType {
    this.checkExpr(operand);
    const operandType = substitute(this.mapping, this.#requireType(operand), false);
    const [targetType, isOpt] = maybeUnwrapOptional(operandType);

    let resultType = CheckedType.error;
    switch (targetType.kind) {
      case "map":
        resultType = targetType.parameters[1] as CheckedType;
        break;
      case "struct": {
        const fieldType = this.#lookupFieldType(e.location, targetType.name, field);
        if (fieldType !== undefined) resultType = fieldType;
        break;
      }
      case "typeParam":
        this.#isAssignable(CheckedType.dyn, targetType);
        resultType = CheckedType.dyn;
        break;
      default:
        if (!isDynOrError(targetType)) {
          this.#errors.report(
            e.location,
            `type '${targetType.format()}' does not support field selection`,
          );
        }
        resultType = CheckedType.dyn;
        break;
    }

    return isOpt || optional ? CheckedType.optional(resultType) : resultType;
  }

  #checkCall(e: CelCall): void {
    if (e.function === "_?._") {
      this.#checkOptSelect(e);
      return;
    }

    for (const arg of e.args) this.checkExpr(arg);

    if (e.target === undefined) {
      const fn = lookupFunction(e.function);
      if (fn === undefined) {
        this.#undeclaredReference(e.location, e.function);
        this.#setType(e, CheckedType.error);
        return;
      }

      this.#resolveOverloadOrError(e, fn, undefined, e.args);
      return;
    }

    // A receiver may be a namespace: given a.b.c(), either a.b.c is a function or c is a function
    // with target a.b.
    const qualifiedPrefix = toQualifiedName(e.target);
    if (qualifiedPrefix !== undefined) {
      const namespaced = lookupFunction(`${qualifiedPrefix}.${e.function}`);
      if (namespaced !== undefined) {
        this.#resolveOverloadOrError(e, namespaced, undefined, e.args);
        return;
      }
    }

    this.checkExpr(e.target);
    const member = lookupFunction(e.function);
    if (member !== undefined) {
      this.#resolveOverloadOrError(e, member, e.target, e.args);
      return;
    }

    this.#setType(e, CheckedType.error);
    this.#undeclaredReference(e.location, e.function);
  }

  #resolveOverloadOrError(
    e: CelExpr,
    fn: CelFunction,
    target: CelExpr | undefined,
    args: readonly CelExpr[],
  ): void {
    const resolution = this.#resolveOverload(e, fn, target, args);
    this.#setType(e, resolution ?? CheckedType.error);
  }

  #resolveOverload(
    call: CelExpr,
    fn: CelFunction,
    target: CelExpr | undefined,
    args: readonly CelExpr[],
  ): CheckedType | undefined {
    const argTypes: CheckedType[] = [];
    if (target !== undefined) argTypes.push(this.#requireType(target));
    for (const a of args) argTypes.push(this.#requireType(a));

    let resultType: CheckedType | undefined;
    for (const overload of fn.overloads) {
      if (this.#crossTypeNumericComparisonsDisabled && overload.crossTypeNumericComparison)
        continue;
      if (
        (target === undefined && overload.isMember) ||
        (target !== undefined && !overload.isMember)
      ) {
        continue;
      }

      // Logical operators are checked argument by argument, so a non-bool operand is reported at
      // the operand rather than as an overload failure.
      if (fn.name === "_&&_" || fn.name === "_||_") {
        argTypes.forEach((argType, i) => {
          if (!this.#isAssignable(argType, CheckedType.bool)) {
            this.#typeMismatch((args[i] as CelExpr).location, CheckedType.bool, argType);
            resultType = CheckedType.error;
          }
        });

        return resultType !== undefined && isError(resultType) ? undefined : CheckedType.bool;
      }

      let overloadType = CheckedType.opaque("function", overload.resultType, ...overload.argTypes);
      if (overload.typeParams.length !== 0) {
        const substitutions: Mapping = new Map();
        for (const typeParam of overload.typeParams)
          substitutions.set(typeParam, this.#newTypeVar());
        overloadType = substitute(substitutions, overloadType, false);
      }

      const candidateArgTypes = overloadType.parameters.slice(1);
      if (this.#isAssignableList(argTypes, candidateArgTypes)) {
        const fnResultType = substitute(
          this.mapping,
          overloadType.parameters[0] as CheckedType,
          false,
        );
        if (resultType === undefined) {
          resultType = fnResultType;
        } else if (!isDyn(resultType) && !fnResultType.isExactType(resultType)) {
          resultType = CheckedType.dyn;
        }
      }
    }

    if (resultType === undefined) {
      const formatted = argTypes.map((t) => substitute(this.mapping, t, true));
      const signature = CheckedType.formatFunction(undefined, formatted, target !== undefined);
      this.#errors.report(
        call.location,
        `found no matching overload for '${fn.name}' applied to '${signature}'`,
      );
      return undefined;
    }

    return resultType;
  }

  #checkCreateList(e: CelList): void {
    let elemsType: CheckedType | undefined;
    e.elements.forEach((element, i) => {
      this.checkExpr(element);
      let elemType = this.#requireType(element);
      if (e.optionalIndices.has(i)) {
        const [unwrapped, isOptional] = maybeUnwrapOptional(elemType);
        elemType = unwrapped;
        if (!isOptional && !isDyn(elemType)) {
          this.#typeMismatch(element.location, CheckedType.optional(elemType), elemType);
        }
      }

      elemsType = this.#joinTypes(elemsType, elemType);
    });

    this.#setType(e, CheckedType.list(elemsType ?? this.#newTypeVar()));
  }

  #checkCreateMap(e: CelMap): void {
    let keyType: CheckedType | undefined;
    let valueType: CheckedType | undefined;
    for (const entry of e.entries) {
      this.checkExpr(entry.key);
      keyType = this.#joinTypes(keyType, this.#requireType(entry.key));

      this.checkExpr(entry.value);
      let valType = this.#requireType(entry.value);
      if (entry.optional) {
        const [unwrapped, isOptional] = maybeUnwrapOptional(valType);
        valType = unwrapped;
        if (!isOptional && !isDyn(valType)) {
          this.#typeMismatch(entry.value.location, CheckedType.optional(valType), valType);
        }
      }

      valueType = this.#joinTypes(valueType, valType);
    }

    if (keyType === undefined) {
      keyType = this.#newTypeVar();
      valueType = this.#newTypeVar();
    }

    this.#setType(e, CheckedType.map(keyType, valueType as CheckedType));
  }

  #checkCreateStruct(e: CelStruct): void {
    let resultType = CheckedType.error;
    const identType = this.#lookupIdent(e.typeName);
    if (identType === undefined) {
      this.#undeclaredReference(e.location, e.typeName);
      this.#setType(e, CheckedType.error);
      return;
    }

    // The identifier's fully qualified name: a leading dot only roots the lookup.
    let typeName = e.typeName.startsWith(".") ? e.typeName.slice(1) : e.typeName;
    if (identType.kind !== "error") {
      if (identType.kind !== "type") {
        this.#errors.report(e.location, `'${identType.declaredTypeName}' is not a type`);
      } else {
        resultType = identType.parameters[0] as CheckedType;
        if (isWellKnownType(resultType)) {
          typeName = wellKnownTypeName(resultType);
        } else if (resultType.kind === "struct") {
          typeName = resultType.declaredTypeName;
        } else {
          this.#errors.report(e.location, `'${resultType.declaredTypeName}' is not a message type`);
          resultType = CheckedType.error;
        }
      }
    }

    this.#setType(e, resultType);

    for (const field of e.fields) {
      this.checkExpr(field.value);
      const fieldType =
        this.#lookupFieldType(field.location, typeName, field.name) ?? CheckedType.error;
      let valType = this.#requireType(field.value);
      if (field.optional) {
        const [unwrapped, isOptional] = maybeUnwrapOptional(valType);
        valType = unwrapped;
        if (!isOptional && !isDyn(valType)) {
          this.#typeMismatch(field.value.location, CheckedType.optional(valType), valType);
        }
      }

      if (!this.#isAssignable(fieldType, valType)) {
        this.#errors.report(
          field.location,
          `expected type of field '${field.name}' is '${fieldType.format()}' but provided type is '${valType.format()}'`,
        );
      }
    }
  }

  #checkComprehension(e: CelComprehension): void {
    this.checkExpr(e.iterRange);
    this.checkExpr(e.accuInit);
    const accuType = this.#requireType(e.accuInit);
    const rangeType = substitute(this.mapping, this.#requireType(e.iterRange), false);
    let varType: CheckedType;
    switch (rangeType.kind) {
      case "list":
      case "map":
        // A map ranges over its keys.
        varType = rangeType.parameters[0] as CheckedType;
        break;
      case "dyn":
      case "error":
      case "typeParam":
        this.#isAssignable(CheckedType.dyn, rangeType);
        varType = CheckedType.dyn;
        break;
      default:
        this.#errors.report(
          e.iterRange.location,
          `expression of type '${rangeType.format()}' cannot be range of a comprehension (must be list, map, or dynamic)`,
        );
        varType = CheckedType.error;
        break;
    }

    // cel-go builds each scoped environment without the cross-type numeric comparison filter, and
    // the environment it restores on exit is rebuilt the same way, so the filter is gone for good.
    this.#crossTypeNumericComparisonsDisabled = false;

    this.#scopes.push(new Map([[e.accuVar, accuType]]));
    this.#scopes.push(new Map([[e.iterVar, varType]]));
    this.checkExpr(e.loopCondition);
    this.#assertType(e.loopCondition, CheckedType.bool);
    this.checkExpr(e.loopStep);
    this.#assertType(e.loopStep, accuType);
    this.#scopes.pop();
    this.checkExpr(e.result);
    this.#scopes.pop();
    this.#setType(e, substitute(this.mapping, this.#requireType(e.result), false));
  }

  #joinTypes(previous: CheckedType | undefined, current: CheckedType): CheckedType {
    if (previous === undefined) return current;
    if (this.#isAssignable(previous, current)) return mostGeneral(previous, current);

    // SpiceDB's environment keeps cel-go's default of dynamic aggregate literal element types.
    return CheckedType.dyn;
  }

  #newTypeVar(): CheckedType {
    return CheckedType.typeParam(`_var${this.#freeTypeVarCounter++}`);
  }

  #isAssignable(t1: CheckedType, t2: CheckedType): boolean {
    const copy = new Map(this.mapping);
    if (!internalIsAssignable(copy, t1, t2)) return false;
    this.mapping = copy;
    return true;
  }

  #isAssignableList(l1: readonly CheckedType[], l2: readonly CheckedType[]): boolean {
    const copy = new Map(this.mapping);
    if (!internalIsAssignableList(copy, l1, l2)) return false;
    this.mapping = copy;
    return true;
  }

  #setType(e: CelExpr, type: CheckedType): void {
    this.#types.set(e, type);
  }

  getType(e: CelExpr): CheckedType | undefined {
    return this.#types.get(e);
  }

  /** The type of an already-checked node (the C# `GetType(e)!`). */
  #requireType(e: CelExpr): CheckedType {
    return this.#types.get(e) as CheckedType;
  }

  #assertType(e: CelExpr, type: CheckedType): void {
    const actual = this.#requireType(e);
    if (!this.#isAssignable(type, actual)) this.#typeMismatch(e.location, type, actual);
  }

  #typeMismatch(location: CelLocation, expected: CheckedType, actual: CheckedType): void {
    this.#errors.report(
      location,
      `expected type '${expected.format()}' but found '${actual.format()}'`,
    );
  }

  #undeclaredReference(location: CelLocation, name: string): void {
    this.#errors.report(location, `undeclared reference to '${name}' (in container '')`);
  }

  #lookupFieldType(
    location: CelLocation,
    structType: string,
    fieldName: string,
  ): CheckedType | undefined {
    const fields = CEL_DECLARATIONS.structTypes.get(structType);
    if (fields === undefined) {
      this.#errors.report(location, `unexpected failed resolution of '${structType}'`);
      return undefined;
    }

    const fieldType = fields.get(fieldName);
    if (fieldType !== undefined) return fieldType;

    this.#errors.report(location, `undefined field '${fieldName}'`);
    return undefined;
  }

  /** cel-go's `Env.LookupIdent` in the empty container. */
  #lookupIdent(name: string): CheckedType | undefined {
    const candidate = resolveCandidateName(name);
    for (let i = this.#scopes.length - 1; i >= 0; i--) {
      const type = (this.#scopes[i] as Map<string, CheckedType>).get(candidate);
      if (type !== undefined) return type;
    }

    if (CEL_DECLARATIONS.structTypes.has(candidate)) {
      return CheckedType.typeOf(CheckedType.object(candidate));
    }
    const registryType = CEL_DECLARATIONS.registryTypeIdentifiers.get(candidate);
    if (registryType !== undefined) return registryType;
    if (CEL_DECLARATIONS.enumValueIdentifiers.has(candidate)) return CheckedType.int;
    return undefined;
  }
}

function literalType(kind: CelLiteralKind): CheckedType {
  switch (kind) {
    case "bool":
      return CheckedType.bool;
    case "bytes":
      return CheckedType.bytes;
    case "double":
      return CheckedType.double;
    case "int":
      return CheckedType.int;
    case "null":
      return CheckedType.null;
    case "string":
      return CheckedType.string;
    case "uint":
      return CheckedType.uint;
    default:
      return assertNever(kind);
  }
}

function lookupFunction(name: string): CelFunction | undefined {
  return CEL_DECLARATIONS.functions.get(resolveCandidateName(name));
}

/** In the empty container a name's only candidate is itself, a leading dot rooting it. */
function resolveCandidateName(name: string): string {
  return name.startsWith(".") ? name.slice(1) : name;
}

/** cel-go's `containers.ToQualifiedName`. */
function toQualifiedName(e: CelExpr): string | undefined {
  if (e.kind === "ident") return e.name;
  if (e.kind === "select" && !e.testOnly) {
    const prefix = toQualifiedName(e.operand);
    return prefix === undefined ? undefined : `${prefix}.${e.field}`;
  }
  return undefined;
}

function isWellKnownType(t: CheckedType): boolean {
  switch (t.kind) {
    case "any":
    case "timestamp":
    case "duration":
    case "dyn":
    case "null":
      return true;
    case "bool":
    case "bytes":
    case "double":
    case "int":
    case "string":
    case "uint":
      return t.isAssignableType(CheckedType.null);
    case "list":
      return t.parameters[0] === CheckedType.dyn;
    case "map":
      return t.parameters[0] === CheckedType.string && t.parameters[1] === CheckedType.dyn;
    default:
      return false;
  }
}

function wellKnownTypeName(t: CheckedType): string {
  switch (t.kind) {
    case "any":
      return "google.protobuf.Any";
    case "bool":
      return "google.protobuf.BoolValue";
    case "bytes":
      return "google.protobuf.BytesValue";
    case "double":
      return "google.protobuf.DoubleValue";
    case "duration":
      return "google.protobuf.Duration";
    case "dyn":
      return "google.protobuf.Value";
    case "int":
      return "google.protobuf.Int64Value";
    case "list":
      return "google.protobuf.ListValue";
    case "null":
      return "google.protobuf.NullValue";
    case "map":
      return "google.protobuf.Struct";
    case "string":
      return "google.protobuf.StringValue";
    case "timestamp":
      return "google.protobuf.Timestamp";
    case "uint":
      return "google.protobuf.UInt64Value";
    default:
      return "";
  }
}

// ---- checker/types.go ----

function isDyn(t: CheckedType): boolean {
  return t.kind === "dyn" || t.kind === "any";
}

function isError(t: CheckedType): boolean {
  return t.kind === "error";
}

function isDynOrError(t: CheckedType): boolean {
  return isError(t) || isDyn(t);
}

function maybeUnwrapOptional(t: CheckedType): [CheckedType, boolean] {
  return t.kind === "opaque" && t.name === "optional_type"
    ? [t.parameters[0] as CheckedType, true]
    : [t, false];
}

function isEqualOrLessSpecific(t1: CheckedType, t2: CheckedType): boolean {
  if (isDyn(t1) || t1.kind === "typeParam") return true;
  if (isDyn(t2) || t2.kind === "typeParam") return false;
  if (t1.kind !== t2.kind) return false;

  switch (t1.kind) {
    case "opaque":
      if (t1.name !== t2.name || t1.parameters.length !== t2.parameters.length) return false;
      return t1.parameters.every((p, i) =>
        isEqualOrLessSpecific(p, t2.parameters[i] as CheckedType),
      );
    case "list":
      return isEqualOrLessSpecific(
        t1.parameters[0] as CheckedType,
        t2.parameters[0] as CheckedType,
      );
    case "map":
      return (
        isEqualOrLessSpecific(t1.parameters[0] as CheckedType, t2.parameters[0] as CheckedType) &&
        isEqualOrLessSpecific(t1.parameters[1] as CheckedType, t2.parameters[1] as CheckedType)
      );
    case "type":
      return true;
    default:
      return t1.isExactType(t2);
  }
}

function internalIsAssignable(m: Mapping, t1: CheckedType, t2: CheckedType): boolean {
  if (t2.kind === "typeParam") {
    const [valid, t2HasSub] = isValidTypeSubstitution(m, t1, t2);
    if (valid) return true;
    if (t2HasSub) return false;
  }

  if (t1.kind === "typeParam") return isValidTypeSubstitution(m, t2, t1)[0];

  if (isDynOrError(t1) || isDynOrError(t2)) return true;
  if (t1.kind === "null") return internalIsAssignableNull(t2);
  if (t2.kind === "null") return internalIsAssignableNull(t1);

  switch (t1.kind) {
    case "bool":
    case "bytes":
    case "double":
    case "int":
    case "string":
    case "uint":
    case "any":
    case "duration":
    case "timestamp":
    case "struct":
      return t2.isAssignableType(t1);
    case "type":
      return t2.kind === "type";
    case "opaque":
    case "list":
    case "map":
      return (
        t1.kind === t2.kind &&
        t1.name === t2.name &&
        internalIsAssignableList(m, t1.parameters, t2.parameters)
      );
    default:
      return false;
  }
}

function isValidTypeSubstitution(
  m: Mapping,
  t1: CheckedType,
  t2: CheckedType,
): [valid: boolean, hasSub: boolean] {
  if (t1.kind === t2.kind && t1.isExactType(t2)) return [true, true];

  const t2Sub = m.get(t2.format());
  if (t2Sub !== undefined) {
    if (t1.kind === t2Sub.kind && t1.isExactType(t2Sub)) return [true, true];
    if (internalIsAssignable(m, t1, t2Sub)) {
      const t2New = mostGeneral(t1, t2Sub);
      if (notReferencedIn(m, t2, t2New)) m.set(t2.format(), t2New);
      return [true, true];
    }

    return [false, true];
  }

  if (notReferencedIn(m, t2, t1)) {
    m.set(t2.format(), t1);
    return [true, false];
  }

  return [false, false];
}

function internalIsAssignableList(
  m: Mapping,
  l1: readonly CheckedType[],
  l2: readonly CheckedType[],
): boolean {
  if (l1.length !== l2.length) return false;
  return l1.every((t, i) => internalIsAssignable(m, t, l2[i] as CheckedType));
}

function internalIsAssignableNull(t: CheckedType): boolean {
  return (
    t.kind === "opaque" ||
    t.kind === "struct" ||
    t.kind === "any" ||
    t.kind === "duration" ||
    t.kind === "timestamp" ||
    t.isAssignableType(CheckedType.null)
  );
}

function mostGeneral(t1: CheckedType, t2: CheckedType): CheckedType {
  return isEqualOrLessSpecific(t1, t2) ? t1 : t2;
}

function notReferencedIn(m: Mapping, t: CheckedType, withinType: CheckedType): boolean {
  if (t.isExactType(withinType)) return false;

  switch (withinType.kind) {
    case "typeParam": {
      const sub = m.get(withinType.format());
      return sub === undefined || notReferencedIn(m, t, sub);
    }
    case "opaque":
    case "list":
    case "map":
    case "type":
      return withinType.parameters.every((p) => notReferencedIn(m, t, p));
    default:
      return true;
  }
}

/** Replaces bound type parameters; unbound ones become dyn when `typeParamToDyn`. */
function substitute(m: Mapping, t: CheckedType, typeParamToDyn: boolean): CheckedType {
  const sub = m.get(t.format());
  if (sub !== undefined) return substitute(m, sub, typeParamToDyn);
  if (typeParamToDyn && t.kind === "typeParam") return CheckedType.dyn;

  switch (t.kind) {
    case "opaque":
      return CheckedType.opaque(
        t.name,
        ...t.parameters.map((p) => substitute(m, p, typeParamToDyn)),
      );
    case "list":
      return CheckedType.list(substitute(m, t.parameters[0] as CheckedType, typeParamToDyn));
    case "map":
      return CheckedType.map(
        substitute(m, t.parameters[0] as CheckedType, typeParamToDyn),
        substitute(m, t.parameters[1] as CheckedType, typeParamToDyn),
      );
    case "type":
      return t.parameters.length > 0
        ? CheckedType.typeOf(substitute(m, t.parameters[0] as CheckedType, typeParamToDyn))
        : t;
    default:
      return t;
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected CEL node: ${JSON.stringify(value)}`);
}
