import {
  ExperimentalComputablePermissionsResponse,
  ExperimentalDependentRelationsResponse,
  ExperimentalDiffSchemaResponse,
  ExperimentalReflectSchemaResponse,
  ExpSchemaDiff,
  ExpSchemaFilter,
} from "@benedb/protos/authzed/api/v1/experimental_service";
import type {
  ReflectionCaveat,
  ReflectionCaveatParameter,
  ReflectionDefinition,
  ReflectionPermission,
  ReflectionRelation,
  ReflectionTypeReference,
} from "@benedb/protos/authzed/api/v1/schema_service";
import {
  ComputablePermissionsResponse,
  DependentRelationsResponse,
  DiffSchemaResponse,
  ReflectionSchemaDiff,
  ReflectionSchemaFilter,
  ReflectSchemaResponse,
} from "@benedb/protos/authzed/api/v1/schema_service";
import { describe, expect, it } from "vitest";

import { reshapeProto } from "./proto-reshape";

/**
 * Ported from Spiceport `tests/Spiceport.Grains.Tests/ProtoReshapeTests.cs`.
 *
 * Pins the premise of {@link reshapeProto}: each ExperimentalService `Exp*` reflection message has
 * the same wire schema as its SchemaService counterpart, so re-encoding one as the other loses
 * nothing.
 *
 * PORT DECISION. The C# compares the two messages' DESCRIPTORS field by field. ts-proto emits no
 * descriptors, so the equivalence is pinned on the wire instead: a v1 message with EVERY field set
 * to a non-default value - every oneof arm of the diff included - is reshaped and must come back
 * structurally equal (the field names match too). A field number, type or nesting that differed
 * would be dropped or mis-decoded by the target's `decode` and fail the comparison.
 */

const typeRefs: ReflectionTypeReference[] = [
  { subjectDefinitionName: "user", optionalCaveatName: "c", isTerminalSubject: true },
  { subjectDefinitionName: "group", optionalCaveatName: "", optionalRelationName: "member" },
  { subjectDefinitionName: "user", optionalCaveatName: "", isPublicWildcard: true },
];

const relation: ReflectionRelation = {
  name: "viewer",
  comment: "// viewers",
  parentDefinitionName: "document",
  subjectTypes: typeRefs,
};

const permission: ReflectionPermission = {
  name: "view",
  comment: "// view",
  parentDefinitionName: "document",
};

const definition: ReflectionDefinition = {
  name: "document",
  comment: "// doc",
  relations: [relation],
  permissions: [permission],
};

const parameter: ReflectionCaveatParameter = {
  name: "allowed",
  type: "list<string>",
  parentCaveatName: "ip_match",
};

const caveat: ReflectionCaveat = {
  name: "ip_match",
  comment: "// caveat",
  parameters: [parameter],
  expression: "user_ip in allowed",
};

const readAt = { token: "read-at" };

describe("ProtoReshapeTests", () => {
  it("ReflectSchemaResponse reshapes losslessly", () => {
    const source: ReflectSchemaResponse = { definitions: [definition], caveats: [caveat], readAt };

    const reshaped = reshapeProto(source, ReflectSchemaResponse, ExperimentalReflectSchemaResponse);

    expect(reshaped).toEqual(source);
  });

  it("DiffSchemaResponse reshapes every oneof arm losslessly", () => {
    const subjectChange = { relation, changedSubjectType: typeRefs[1] };
    const arms: ReflectionSchemaDiff[] = [
      { definitionAdded: definition },
      { definitionRemoved: definition },
      { definitionDocCommentChanged: definition },
      { relationAdded: relation },
      { relationRemoved: relation },
      { relationDocCommentChanged: relation },
      { relationSubjectTypeAdded: subjectChange },
      { relationSubjectTypeRemoved: subjectChange },
      { permissionAdded: permission },
      { permissionRemoved: permission },
      { permissionDocCommentChanged: permission },
      { permissionExprChanged: permission },
      { caveatAdded: caveat },
      { caveatRemoved: caveat },
      { caveatDocCommentChanged: caveat },
      { caveatExprChanged: caveat },
      { caveatParameterAdded: parameter },
      { caveatParameterRemoved: parameter },
      { caveatParameterTypeChanged: { parameter, previousType: "string" } },
    ];
    const source: DiffSchemaResponse = { diffs: arms, readAt };

    const reshaped = reshapeProto(source, DiffSchemaResponse, ExperimentalDiffSchemaResponse);

    expect(reshaped).toEqual(source);
  });

  it("ComputablePermissions and DependentRelations responses reshape losslessly", () => {
    const refs = [{ definitionName: "document", relationName: "view", isPermission: true }];

    const computable: ComputablePermissionsResponse = { permissions: refs, readAt };
    expect(
      reshapeProto(
        computable,
        ComputablePermissionsResponse,
        ExperimentalComputablePermissionsResponse,
      ),
    ).toEqual(computable);

    const dependent: DependentRelationsResponse = { relations: refs, readAt };
    expect(
      reshapeProto(dependent, DependentRelationsResponse, ExperimentalDependentRelationsResponse),
    ).toEqual(dependent);
  });

  it("ExpSchemaFilter reshapes losslessly into ReflectionSchemaFilter", () => {
    const source: ExpSchemaFilter = {
      optionalDefinitionNameFilter: "doc",
      optionalCaveatNameFilter: "ip",
      optionalRelationNameFilter: "view",
      optionalPermissionNameFilter: "man",
    };

    expect(reshapeProto(source, ExpSchemaFilter, ReflectionSchemaFilter)).toEqual(source);
  });

  it("reshape round trips a nested oneof message", () => {
    const source: ReflectionSchemaDiff = {
      relationSubjectTypeAdded: {
        relation: {
          name: "viewer",
          comment: "",
          parentDefinitionName: "document",
          subjectTypes: [],
        },
        changedSubjectType: {
          subjectDefinitionName: "group",
          optionalCaveatName: "",
          isTerminalSubject: true,
        },
      },
    };

    const reshaped = reshapeProto(source, ReflectionSchemaDiff, ExpSchemaDiff);

    expect(reshaped.relationSubjectTypeAdded?.relation?.name).toBe("viewer");
    expect(reshaped.relationSubjectTypeAdded?.relation?.parentDefinitionName).toBe("document");
    expect(reshaped.relationSubjectTypeAdded?.changedSubjectType?.subjectDefinitionName).toBe(
      "group",
    );
    expect(reshaped.relationSubjectTypeAdded?.changedSubjectType?.isTerminalSubject).toBe(true);
  });
});
