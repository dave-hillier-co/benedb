import { createHash } from "node:crypto";

import {
  isAllowedRelationPublicWildcard,
  type AllowedRelation,
} from "@benedb/core/allowed-relation";
import type { CaveatDefinition, CaveatTypeReference } from "@benedb/core/caveat-definition";
import { ELLIPSIS } from "@benedb/core/core-constants";
import { InvalidArgumentError } from "@benedb/core/invalid-argument-error";
import type { NamespaceDefinition } from "@benedb/core/namespace-definition";
import type { Relation } from "@benedb/core/relation";
import type { SetOperation, SetOperationChild } from "@benedb/core/userset-rewrite";

/**
 * Computes a stable hash of a compiled schema model (namespaces + caveats), used as part of the
 * caching dispatcher's key (so a schema change invalidates cached branches) and as part of the
 * per-request grain routing key.
 *
 * Ported from Spiceport `Engine/SchemaHash.cs`.
 *
 * The hash is a SHA-256 over an explicit, faithful structural rendering of the namespace and
 * caveat definitions, ordered by name ORDINALLY so the result is independent of enumeration
 * order. That sort is what makes the hash stable; it must never be "simplified away". The
 * rendering walks the full model (relations, type information, userset rewrites and their nested
 * set operations) so that two schemas sharing namespace names but differing in their relations
 * hash differently.
 *
 * EVERY CHARACTER EMITTED HERE IS LOAD-BEARING. `schema-hash.test.ts` pins the digests; if one
 * fails, the renderer changed, not the assertion.
 *
 * Two DELIBERATE, DOCUMENTED DIVERGENCES from the C#. Both are safe because this hash is internal
 * to the cluster and never appears on the wire:
 *
 *  1. CAVEATS ARE RENDERED FAITHFULLY. The C# does `sb.Append(c)` on a `CaveatDefinition`, which
 *     invokes the RECORD DEFAULT `ToString()`. That renders `SerializedExpression` as the literal
 *     text "System.Byte[]" and `ParameterTypes` as
 *     "System.Collections.Immutable.ImmutableDictionary`2[...]", so the C# caveat section hashes
 *     essentially only the NAME - two caveats differing only in their expression hash
 *     identically. That is a latent cache-correctness bug, not a contract, and reproducing it in
 *     TypeScript is impossible anyway, so this port renders the parameters and the expression
 *     bytes.
 *  2. ENUM CASING follows the BeneDB string unions, not the .NET enum names: "union" not
 *     "Union", "tupleObject" not "TupleObject", "any" not "Any". No mapping layer is introduced
 *     just to restore PascalCase.
 */

/** Computes a lowercase hex SHA-256 over the given namespaces and caveats. */
export function computeSchemaHash(
  namespaces: Iterable<NamespaceDefinition>,
  caveats?: Iterable<CaveatDefinition> | undefined,
): string {
  // `ArgumentNullException.ThrowIfNull`. Kept even though the parameter type is non-optional:
  // the caller may be untyped.
  if (namespaces === undefined || namespaces === null) {
    throw new InvalidArgumentError("namespaces must not be null or undefined");
  }

  const parts: string[] = [];
  parts.push("namespaces:\n");
  for (const ns of ordinalByName([...namespaces])) {
    appendNamespace(parts, ns);
  }

  parts.push("caveats:\n");
  // The C# guard is `if (caveats is not null)`. `!= null` here (not `!== undefined`) so an
  // explicit `null` from an untyped caller is skipped rather than reaching the spread and
  // throwing `TypeError: caveats is not iterable`, matching the `namespaces` guard above.
  if (caveats != null) {
    for (const caveat of ordinalByName([...caveats])) {
      appendCaveat(parts, caveat);
    }
  }

  const bytes = new TextEncoder().encode(parts.join(""));
  // `Convert.ToHexStringLower(SHA256.HashData(...))`. WebCrypto's `subtle.digest` is async and
  // therefore unusable from this synchronous function.
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Computes a lowercase hex SHA-256 over an already-keyed namespace map.
 *
 * The C# `Compute` OVERLOAD SET (IEnumerable vs ImmutableDictionary) becomes two distinctly named
 * functions; this one just forwards the values. The keys are ignored.
 */
export function computeSchemaHashFromNamespaceMap(
  namespaces: ReadonlyMap<string, NamespaceDefinition>,
  caveats?: Iterable<CaveatDefinition> | undefined,
): string {
  return computeSchemaHash(namespaces.values(), caveats);
}

/**
 * `OrderBy(x => x.Name, StringComparer.Ordinal)`. Ordinal comparison is `a < b`, never
 * `localeCompare`.
 */
function ordinalByName<T extends { readonly name: string }>(items: T[]): T[] {
  return items.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
}

function appendNamespace(parts: string[], ns: NamespaceDefinition): void {
  parts.push("def ", ns.name, "\n");
  for (const relation of ordinalByName([...ns.relations])) {
    appendRelation(parts, relation);
  }
}

function appendRelation(parts: string[], relation: Relation): void {
  parts.push("  rel ", relation.name);
  if (relation.aliasingRelation !== undefined) {
    parts.push(" alias=", relation.aliasingRelation);
  }

  parts.push("\n");

  if (relation.typeInformation !== undefined) {
    // Declaration order, deliberately: the allowed list is not sorted.
    for (const allowed of relation.typeInformation.allowedDirectRelations) {
      appendAllowed(parts, allowed);
    }
  }

  if (relation.usersetRewrite !== undefined) {
    parts.push("    rewrite:");
    appendSetOperation(parts, relation.usersetRewrite.operation);
    parts.push("\n");
  }
}

function appendAllowed(parts: string[], allowed: AllowedRelation): void {
  parts.push(
    "    allow ",
    allowed.objectType,
    "#",
    isAllowedRelationPublicWildcard(allowed) ? "*" : (allowed.relationName ?? ELLIPSIS),
  );
  if (allowed.requiredCaveat !== undefined) {
    parts.push(" with ", allowed.requiredCaveat.caveatName);
  }

  if (allowed.requiresExpiration) {
    parts.push(" +expiration");
  }

  parts.push("\n");
}

function appendSetOperation(parts: string[], operation: SetOperation): void {
  parts.push("(", operation.type);
  for (const child of operation.children) {
    parts.push(" ");
    appendChild(parts, child);
  }

  parts.push(")");
}

function assertNever(value: never): never {
  throw new Error(`Unhandled set operation child: ${JSON.stringify(value)}`);
}

function appendChild(parts: string[], child: SetOperationChild): void {
  switch (child.kind) {
    case "this":
      parts.push("this");
      return;
    case "nil":
      parts.push("nil");
      return;
    case "self":
      parts.push("self");
      return;
    case "computedUserset":
      parts.push("cu[", child.value.object, ":", child.value.relation, "]");
      return;
    case "tupleToUserset":
      parts.push(
        "ttu[",
        child.value.tuplesetRelation,
        "->",
        child.value.computedUserset.object,
        ":",
        child.value.computedUserset.relation,
        "]",
      );
      return;
    case "functionedTupleToUserset":
      parts.push(
        "fttu[",
        child.value.function,
        " ",
        child.value.tuplesetRelation,
        "->",
        child.value.computedUserset.object,
        ":",
        child.value.computedUserset.relation,
        "]",
      );
      return;
    case "nestedRewrite":
      appendSetOperation(parts, child.value.operation);
      return;
    default:
      return assertNever(child);
  }
}

/**
 * Renders a caveat definition. Divergence 1 (see the module remarks): the C# renders the record's
 * default `ToString()`, which discards both the expression and the parameter types.
 */
function appendCaveat(parts: string[], caveat: CaveatDefinition): void {
  parts.push("caveat ", caveat.name, "\n");
  const names = [...caveat.parameterTypes.keys()].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  for (const name of names) {
    const type = caveat.parameterTypes.get(name);
    if (type === undefined) continue;
    parts.push("  param ", name, " ", renderTypeReference(type), "\n");
  }

  parts.push("  expr ", toHex(caveat.serializedExpression), "\n");
}

/**
 * `t` for a scalar, `t<a,b>` for a generic. An ABSENT child list renders bare; an EMPTY one
 * renders `t<>`. `@benedb/core/caveat-definition` keeps the two distinct and so does this.
 */
function renderTypeReference(type: CaveatTypeReference): string {
  if (type.childTypes === undefined) return type.typeName;
  return `${type.typeName}<${type.childTypes.map(renderTypeReference).join(",")}>`;
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}
