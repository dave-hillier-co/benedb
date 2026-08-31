import type { ObjectAndRelation } from "@benedb/core/object-and-relation";
import type { Relationship } from "@benedb/core/relationship";
import type { Membership } from "@benedb/engine/membership";

/**
 * The typed model of a parsed SpiceDB validation/consistency file.
 *
 * Ported from Spiceport `Loading/ValidationModel.cs`, which declares all five types together.
 * They stay together here for the same reason `allowed-relation.ts` keeps its cluster: they are
 * one cohesive value-type family with no independent consumers.
 *
 * Port decisions:
 *   * `AssertionExpectation` is a C# enum with explicit 0/1/2 values that are NOT proto values
 *     (the gRPC permissionship enum is mapped separately at the API layer), so per the port guide
 *     it becomes a string-literal union with no wire map.
 *   * The C# records' computed properties (`ParsedAssertion.Expected`,
 *     `ParsedAssertion.ExpectedMembership`, `ExpectedSubject.Subject`, `ExpectedSubject.IsCaveated`)
 *     become free functions, name-folded with their declaring type.
 */

/**
 * A fully parsed SpiceDB validation/consistency file: schema DSL text, the
 * relationships that make up the datastore, the boolean assertions to run, and the
 * (optional, usually absent in this corpus) `validation:` expected-subjects block.
 */
export interface ValidationFile {
  /** The schema DSL text, with trailing whitespace trimmed. */
  readonly schemaText: string;
  /** The relationships that make up the datastore, in file order. */
  readonly relationships: readonly Relationship[];
  /** The boolean assertions to run, in assertTrue / assertCaveated / assertFalse order. */
  readonly assertions: readonly ParsedAssertion[];
  /** The `validation:` expected-subjects entries. Empty when the block is absent. */
  readonly validations: readonly ValidationEntry[];
}

/**
 * The expected outcome of a single Check assertion. Maps directly onto the engine
 * {@link Membership} verdict the harness should observe.
 */
export type AssertionExpectation =
  /** assertTrue: the Check is expected to return a definite allow (`"member"`). */
  | "true"
  /** assertFalse: the Check is expected to return a definite deny (`"notMember"`). */
  | "false"
  /**
   * assertCaveated: the Check is expected to be conditional on a caveat (`"caveated"`), i.e. it
   * needs context to resolve.
   */
  | "caveated";

/** A single parsed assertion, ready to be translated into a Check call. */
export interface ParsedAssertion {
  /** The resource ONR (object type, id and relation/permission). */
  readonly resource: ObjectAndRelation;
  /** The subject ONR. */
  readonly subject: ObjectAndRelation;
  /** The expected membership outcome. */
  readonly expectation: AssertionExpectation;
  /**
   * Optional caveat context supplied via the `... with {json}` suffix. This context overrides
   * any context embedded in the relationship tuple.
   *
   * REQUIRED-BUT-UNDEFINED rather than optional: the C# positional record parameter has no
   * default, so every construction site must decide.
   */
  readonly caveatContext: ReadonlyMap<string, unknown> | undefined;
  /** The original assertion line, retained for diagnostics. */
  readonly sourceText: string;
}

/**
 * True for assertTrue assertions. Retained for callers that only distinguish allow/deny; prefer
 * {@link ParsedAssertion.expectation} or {@link assertionExpectedMembership}.
 *
 * The C# computed property `ParsedAssertion.Expected`.
 */
export function isAssertionExpected(assertion: ParsedAssertion): boolean {
  return assertion.expectation === "true";
}

/**
 * The expected engine {@link Membership} verdict for this assertion.
 *
 * The C# computed property `ParsedAssertion.ExpectedMembership`. Its `_ => Membership.NotMember`
 * default arm covered an out-of-range enum value, which the string union makes unrepresentable;
 * per the house convention that arm becomes a local `assertNever`.
 */
export function assertionExpectedMembership(assertion: ParsedAssertion): Membership {
  switch (assertion.expectation) {
    case "true":
      return "member";
    case "false":
      return "notMember";
    case "caveated":
      return "caveated";
    default:
      return assertNever(assertion.expectation);
  }
}

function assertNever(value: never): never {
  throw new Error(`unexpected assertion expectation: ${String(value)}`);
}

/**
 * A single subject term parsed out of a validation-block expected-subjects string, e.g.
 * `user:tom` (terminal), `group:eng#member` (subject-with-relation), or `user:*` (wildcard).
 * {@link ExpectedSubjectTerm.isCaveated} mirrors SpiceDB's bracket-ellipsis marker (`[...]`)
 * directly suffixed to the subject: "this subject reaches the permission only via a caveat
 * expression", not a fully-evaluated caveat context.
 */
export interface ExpectedSubjectTerm {
  /** The subject (or wildcard) ONR. */
  readonly subject: ObjectAndRelation;
  /** True when the subject carried the `[...]` caveat marker. */
  readonly isCaveated: boolean;
}

/**
 * One `[subject...]` entry of a validation-block expected-subjects list, e.g.
 * `"[user:tom] is <document:first#viewer>"`. The `is <...>` resource-path suffix is a
 * human-readable breadcrumb only (per SpiceDB's own `pkg/validationfile/blocks` grammar) and is
 * intentionally NOT modeled here - only {@link ExpectedSubject.term} (and, for a wildcard term,
 * its {@link ExpectedSubject.exceptions}) matters for assertion purposes.
 */
export interface ExpectedSubject {
  /** The subject (or wildcard) this entry asserts. */
  readonly term: ExpectedSubjectTerm;
  /**
   * For a wildcard {@link ExpectedSubject.term}, the concrete subjects excluded from it
   * (SpiceDB's `excluded_subjects`): the wildcard means "every subject of the type EXCEPT
   * these". Each exception carries its own optional caveat marker. Empty for non-wildcard terms.
   */
  readonly exceptions: readonly ExpectedSubjectTerm[];
}

/** The term's subject ONR. The C# computed property `ExpectedSubject.Subject`. */
export function expectedSubjectSubject(expected: ExpectedSubject): ObjectAndRelation {
  return expected.term.subject;
}

/** The term's caveat marker. The C# computed property `ExpectedSubject.IsCaveated`. */
export function isExpectedSubjectCaveated(expected: ExpectedSubject): boolean {
  return expected.term.isCaveated;
}

/**
 * One `resource#permission: [...]` entry of a validation block: the resource ONR key and the
 * full set of subjects it is expected to resolve to.
 */
export interface ValidationEntry {
  /** The resource ONR the entry keys on. */
  readonly objectAndRelation: ObjectAndRelation;
  /** The full set of subjects the resource is expected to resolve to. */
  readonly expectedSubjects: readonly ExpectedSubject[];
}
