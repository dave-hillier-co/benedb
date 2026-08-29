# Port ledger

The source-to-target mapping, one row per Spiceport file. It exists so that coverage is a
query rather than a judgement: a Spiceport file with no row here has not been considered.

Paths are relative to `../spiceport` and to this repository's root respectively. A row's
presence records the mapping, not completion — the gates in
[`port-plan.md`](port-plan.md) decide that.

`tests/Spiceport.Conformance.Tests/SteelThread/SteelThreadTests.cs` is listed under S4 rather
than with the rest of the conformance suite: it drives `Spiceport.Grains.SchemaChangeValidator`,
an S4 file, so pulling it forward would break the leaves-first ordering. It also needs its
`SteelThread/TestData` and `SteelThread/Results` golden trees vendored, which the corpus under
`packages/conformance/corpus` does not carry.

| Stage | Spiceport                                                                            | SpaceDB                                                                              |
| ----- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| S1    | `src/Spiceport.Core/CaveatEvaluationException.cs`                                    | `packages/core/src/caveat-evaluation-exception.ts`                                   |
| S1    | `src/Spiceport.Core/Common/ContextualizedCaveat.cs`                                  | `packages/core/src/contextualized-caveat.ts`                                         |
| S1    | `src/Spiceport.Core/Common/CoreConstants.cs`                                         | `packages/core/src/core-constants.ts`                                                |
| S1    | `src/Spiceport.Core/Common/ObjectAndRelation.cs`                                     | `packages/core/src/object-and-relation.ts`                                           |
| S1    | `src/Spiceport.Core/Common/RelationReference.cs`                                     | `packages/core/src/relation-reference.ts`                                            |
| S1    | `src/Spiceport.Core/Common/RelationshipReference.cs`                                 | `packages/core/src/relationship-reference.ts`                                        |
| S1    | `src/Spiceport.Core/Relationships/Relationship.cs`                                   | `packages/core/src/relationship.ts`                                                  |
| S1    | `src/Spiceport.Core/Relationships/RelationshipIntegrity.cs`                          | `packages/core/src/relationship-integrity.ts`                                        |
| S1    | `src/Spiceport.Core/Relationships/RelationshipUpdate.cs`                             | `packages/core/src/relationship-update.ts`                                           |
| S1    | `src/Spiceport.Core/Relationships/TupleStrings.cs`                                   | `packages/core/src/tuple-strings.ts`                                                 |
| S1    | `src/Spiceport.Core/Revisions/ConsistencyRequirement.cs`                             | `packages/core/src/consistency-requirement.ts`                                       |
| S1    | `src/Spiceport.Core/Revisions/IRevision.cs`                                          | `packages/core/src/i-revision.ts`                                                    |
| S1    | `src/Spiceport.Core/Revisions/InvalidConsistencyTokenException.cs`                   | `packages/core/src/invalid-consistency-token-exception.ts`                           |
| S1    | `src/Spiceport.Core/Revisions/ResolvedRevision.cs`                                   | `packages/core/src/resolved-revision.ts`                                             |
| S1    | `src/Spiceport.Core/Revisions/ResolvedRevision.cs`                                   | `packages/core/src/revision-mode.ts`                                                 |
| S1    | `src/Spiceport.Core/Revisions/TimestampRevision.cs`                                  | `packages/core/src/timestamp-revision.ts`                                            |
| S1    | `src/Spiceport.Core/Revisions/ZedToken.cs`                                           | `packages/core/src/zed-token.ts`                                                     |
| S1    | `src/Spiceport.Core/Revisions/ZedToken.cs`                                           | `packages/core/src/zed-token-status.ts`                                              |
| S1    | `src/Spiceport.Core/Revisions/ZedToken.cs`                                           | `packages/core/src/decoded-revision.ts`                                              |
| S1    | `src/Spiceport.Core/Revisions/ZedToken.cs`                                           | `packages/core/src/i-revision-parser.ts`                                             |
| S1    | `src/Spiceport.Core/Revisions/ZedTokens.cs`                                          | `packages/core/src/zed-tokens.ts`                                                    |
| S1    | `src/Spiceport.Core/Schema/AllowedRelation.cs`                                       | `packages/core/src/allowed-relation.ts`                                              |
| S1    | `src/Spiceport.Core/Schema/AllowedRelationIdentity.cs`                               | `packages/core/src/allowed-relation-identity.ts`                                     |
| S1    | `src/Spiceport.Core/Schema/CaveatDefinition.cs`                                      | `packages/core/src/caveat-definition.ts`                                             |
| S1    | `src/Spiceport.Core/Schema/Relation.cs`                                              | `packages/core/src/relation.ts`                                                      |
| S1    | `src/Spiceport.Core/Schema/Relation.cs`                                              | `packages/core/src/namespace-definition.ts`                                          |
| S1    | `src/Spiceport.Core/Schema/StoredSchema.cs`                                          | `packages/core/src/stored-schema.ts`                                                 |
| S1    | `src/Spiceport.Core/Schema/UsersetRewrite.cs`                                        | `packages/core/src/userset-rewrite.ts`                                               |
| S1    | `src/Spiceport.Server/Schema/Ast.cs`                                                 | `packages/schema/src/ast.ts`                                                         |
| S1    | `src/Spiceport.Server/Schema/Lexer.cs`                                               | `packages/schema/src/lexer.ts`                                                       |
| S1    | `src/Spiceport.Server/Schema/Parser.cs`                                              | `packages/schema/src/parser.ts`                                                      |
| S1    | `src/Spiceport.Server/Schema/SchemaCompileException.cs`                              | `packages/schema/src/schema-compile-exception.ts`                                    |
| S1    | `src/Spiceport.Server/Schema/SchemaCompiler.cs`                                      | `packages/schema/src/schema-compiler.ts`                                             |
| S1    | `src/Spiceport.Server/Schema/SchemaCompiler.cs`                                      | `packages/schema/src/compiled-schema.ts`                                             |
| S1    | `tests/Spiceport.Core.Tests/UnitTest1.cs`                                            | `packages/core/src/unit-test1.test.ts`                                               |
| S1    | `tests/Spiceport.Schema.Tests/SchemaCompilerTests.cs`                                | `packages/schema/src/schema-compiler-tests.test.ts`                                  |
| S2    | `src/Spiceport.Datastore/CounterFilterJson.cs`                                       | `packages/datastore/src/counter-filter-json.ts`                                      |
| S2    | `src/Spiceport.Datastore/Counters.cs`                                                | `packages/datastore/src/counters.ts`                                                 |
| S2    | `src/Spiceport.Datastore/DatastoreExceptions.cs`                                     | `packages/datastore/src/datastore-exceptions.ts`                                     |
| S2    | `src/Spiceport.Datastore/DatastoreState.cs`                                          | `packages/datastore/src/datastore-state.ts`                                          |
| S2    | `src/Spiceport.Datastore/IDatastore.cs`                                              | `packages/datastore/src/i-datastore.ts`                                              |
| S2    | `src/Spiceport.Datastore/IGraphReader.cs`                                            | `packages/datastore/src/i-graph-reader.ts`                                           |
| S2    | `src/Spiceport.Datastore/MvccReadWriteTransaction.cs`                                | `packages/datastore/src/mvcc-read-write-transaction.ts`                              |
| S2    | `src/Spiceport.Datastore/MvccSnapshotReader.cs`                                      | `packages/datastore/src/mvcc-snapshot-reader.ts`                                     |
| S2    | `src/Spiceport.Datastore/ReferenceDatastore.cs`                                      | `packages/datastore/src/reference-datastore.ts`                                      |
| S2    | `src/Spiceport.Datastore/RelationshipKey.cs`                                         | `packages/datastore/src/relationship-key.ts`                                         |
| S2    | `src/Spiceport.Datastore/RelationshipsFilter.cs`                                     | `packages/datastore/src/relationships-filter.ts`                                     |
| S2    | `src/Spiceport.Datastore/ReverseQueryOptions.cs`                                     | `packages/datastore/src/reverse-query-options.ts`                                    |
| S2    | `src/Spiceport.Datastore/RevisionResolver.cs`                                        | `packages/datastore/src/revision-resolver.ts`                                        |
| S2    | `src/Spiceport.Datastore/TimestampRevisionParser.cs`                                 | `packages/datastore/src/timestamp-revision-parser.ts`                                |
| S2    | `src/Spiceport.Datastore/Watch.cs`                                                   | `packages/datastore/src/watch.ts`                                                    |
| S2    | `tests/Spiceport.Datastore.Tests/DatastoreStateGcTests.cs`                           | `packages/datastore/src/datastore-state-gc-tests.test.ts`                            |
| S2    | `tests/Spiceport.Datastore.Tests/ReferenceDatastoreCounterTests.cs`                  | `packages/datastore/src/reference-datastore-counter-tests.test.ts`                   |
| S2    | `tests/Spiceport.Datastore.Tests/ReferenceDatastoreTests.cs`                         | `packages/datastore/src/reference-datastore-tests.test.ts`                           |
| S2    | `tests/Spiceport.Datastore.Tests/RevisionResolverTests.cs`                           | `packages/datastore/src/revision-resolver-tests.test.ts`                             |
| S3    | `src/Spiceport.Server/Engine/CaveatCelEnvironment.cs`                                | `packages/engine/src/caveat-cel-environment.ts`                                      |
| S3    | `src/Spiceport.Server/Engine/CaveatCompiler.cs`                                      | `packages/engine/src/caveat-compiler.ts`                                             |
| S3    | `src/Spiceport.Server/Engine/CaveatEvaluator.cs`                                     | `packages/engine/src/caveat-evaluator.ts`                                            |
| S3    | `src/Spiceport.Server/Engine/CaveatEvaluator.cs`                                     | `packages/engine/src/references-identifier.ts`                                       |
| S3    | `src/Spiceport.Server/Engine/CaveatExpression.cs`                                    | `packages/engine/src/caveat-expression.ts`                                           |
| S3    | `src/Spiceport.Server/Engine/CheckEngine.cs`                                         | `packages/engine/src/check-engine.ts`                                                |
| S3    | `src/Spiceport.Server/Engine/Clock.cs`                                               | `packages/engine/src/clock.ts`                                                       |
| S3    | `src/Spiceport.Server/Engine/Expand/ExpandEngine.cs`                                 | `packages/engine/src/expand-engine.ts`                                               |
| S3    | `src/Spiceport.Server/Engine/Expand/PermissionTreeNode.cs`                           | `packages/engine/src/permission-tree-node.ts`                                        |
| S3    | `src/Spiceport.Server/Engine/IDispatcher.cs`                                         | `packages/engine/src/i-dispatcher.ts`                                                |
| S3    | `src/Spiceport.Server/Engine/ISchemaHashSource.cs`                                   | `packages/engine/src/i-schema-hash-source.ts`                                        |
| S3    | `src/Spiceport.Server/Engine/InProcessRevision.cs`                                   | `packages/engine/src/in-process-revision.ts`                                         |
| S3    | `src/Spiceport.Server/Engine/LocalDispatcher.cs`                                     | `packages/engine/src/local-dispatcher.ts`                                            |
| S3    | `src/Spiceport.Server/Engine/Lookup/FoundResource.cs`                                | `packages/engine/src/found-resource.ts`                                              |
| S3    | `src/Spiceport.Server/Engine/Lookup/FoundSubject.cs`                                 | `packages/engine/src/found-subject.ts`                                               |
| S3    | `src/Spiceport.Server/Engine/Lookup/LookupResourcesCursor.cs`                        | `packages/engine/src/lookup-resources-cursor.ts`                                     |
| S3    | `src/Spiceport.Server/Engine/Lookup/LookupResourcesEngine.cs`                        | `packages/engine/src/lookup-resources-engine.ts`                                     |
| S3    | `src/Spiceport.Server/Engine/Lookup/LookupSubjectsEngine.cs`                         | `packages/engine/src/lookup-subjects-engine.ts`                                      |
| S3    | `src/Spiceport.Server/Engine/Lookup/MembershipCoverage.cs`                           | `packages/engine/src/membership-coverage.ts`                                         |
| S3    | `src/Spiceport.Server/Engine/Lookup/MembershipWalk.cs`                               | `packages/engine/src/membership-walk.ts`                                             |
| S3    | `src/Spiceport.Server/Engine/Membership.cs`                                          | `packages/engine/src/membership.ts`                                                  |
| S3    | `src/Spiceport.Server/Engine/Reachability/ReachabilityEntrypoint.cs`                 | `packages/engine/src/reachability-entrypoint.ts`                                     |
| S3    | `src/Spiceport.Server/Engine/Reachability/ReachabilityGraph.cs`                      | `packages/engine/src/reachability-graph.ts`                                          |
| S3    | `src/Spiceport.Server/Engine/Reachability/RelationReference.cs`                      | `packages/engine/src/relation-reference.ts`                                          |
| S3    | `src/Spiceport.Server/Engine/Reachability/SchemaIntrospection.cs`                    | `packages/engine/src/schema-introspection.ts`                                        |
| S3    | `src/Spiceport.Server/Engine/Reachability/SchemaIntrospection.cs`                    | `packages/engine/src/schema-introspection-exception.ts`                              |
| S3    | `src/Spiceport.Server/Engine/SchemaHash.cs`                                          | `packages/engine/src/schema-hash.ts`                                                 |
| S3    | `src/Spiceport.Server/Engine/SchemaTypeException.cs`                                 | `packages/engine/src/schema-type-exception.ts`                                       |
| S3    | `src/Spiceport.Server/Engine/SchemaTypeValidator.cs`                                 | `packages/engine/src/schema-type-validator.ts`                                       |
| S3    | `src/Spiceport.Server/MaxDepthExceededException.cs`                                  | `packages/core/src/max-depth-exceeded-exception.ts`                                  |
| S3    | `tests/Spiceport.Conformance.Tests/ConformanceTests.cs`                              | `packages/conformance/src/conformance-tests.test.ts`                                 |
| S3    | `tests/Spiceport.Conformance.Tests/Loading/RelationshipSchemaValidator.cs`           | `packages/conformance/src/relationship-schema-validator.ts`                          |
| S3    | `tests/Spiceport.Conformance.Tests/Loading/ValidationFileLoader.cs`                  | `packages/conformance/src/validation-file-loader.ts`                                 |
| S3    | `tests/Spiceport.Conformance.Tests/Loading/ValidationFileLoaderTests.cs`             | `packages/conformance/src/validation-file-loader.test.ts`                            |
| S3    | `tests/Spiceport.Conformance.Tests/Loading/ValidationLoaderSuiteTests.cs`            | `packages/conformance/src/validation-loader-suite.test.ts`                           |
| S3    | `tests/Spiceport.Conformance.Tests/Loading/ValidationModel.cs`                       | `packages/conformance/src/validation-model.ts`                                       |
| S3    | `tests/Spiceport.Conformance.Tests/QuarantinedCorpusTests.cs`                        | `packages/conformance/src/quarantined-corpus-tests.test.ts`                          |
| S3    | `tests/Spiceport.Conformance.Tests/ReverseConsistencyCrossCheckTests.cs`             | `packages/conformance/src/reverse-consistency-cross-check-tests.test.ts`             |
| S3    | `tests/Spiceport.Conformance.Tests/ValidationBlockTests.cs`                          | `packages/conformance/src/validation-block-tests.test.ts`                            |
| S3    | `tests/Spiceport.Engine.Tests/CaveatCheckTests.cs`                                   | `packages/engine/src/caveat-check-tests.test.ts`                                     |
| S3    | `tests/Spiceport.Engine.Tests/CaveatCompletenessTests.cs`                            | `packages/engine/src/caveat-completeness-tests.test.ts`                              |
| S3    | `tests/Spiceport.Engine.Tests/CaveatEvaluatorTests.cs`                               | `packages/engine/src/caveat-evaluator-tests.test.ts`                                 |
| S3    | `tests/Spiceport.Engine.Tests/CheckEngineTests.cs`                                   | `packages/engine/src/check-engine-tests.test.ts`                                     |
| S3    | `tests/Spiceport.Engine.Tests/CrossApiAgreementTests.cs`                             | `packages/engine/src/cross-api-agreement-tests.test.ts`                              |
| S3    | `tests/Spiceport.Engine.Tests/DispatcherSeamTests.cs`                                | `packages/engine/src/dispatcher-seam-tests.test.ts`                                  |
| S3    | `tests/Spiceport.Engine.Tests/ExpandEngineTests.cs`                                  | `packages/engine/src/expand-engine-tests.test.ts`                                    |
| S3    | `tests/Spiceport.Engine.Tests/LookupResourcesEngineTests.cs`                         | `packages/engine/src/lookup-resources-engine-tests.test.ts`                          |
| S3    | `tests/Spiceport.Engine.Tests/LookupSubjectsEngineTests.cs`                          | `packages/engine/src/lookup-subjects-engine-tests.test.ts`                           |
| S3    | `tests/Spiceport.Engine.Tests/MembershipCoverageTests.cs`                            | `packages/engine/src/membership-coverage-tests.test.ts`                              |
| S3    | `tests/Spiceport.Engine.Tests/MembershipWalkTests.cs`                                | `packages/engine/src/membership-walk-tests.test.ts`                                  |
| S3    | `tests/Spiceport.Engine.Tests/MetamorphicInvariantTests.cs`                          | `packages/engine/src/metamorphic-invariant-tests.test.ts`                            |
| S3    | `tests/Spiceport.Engine.Tests/RandomAuthzWorlds.cs`                                  | `packages/engine/src/random-authz-worlds.ts`                                         |
| S3    | `tests/Spiceport.Engine.Tests/SchemaTypeValidatorTests.cs`                           | `packages/engine/src/schema-type-validator-tests.test.ts`                            |
| S3    | `tests/Spiceport.Engine.Tests/Stage4MembershipWalkEquivalenceTests.cs`               | `packages/engine/src/stage4-membership-walk-equivalence-tests.test.ts`               |
| S3    | `tests/Spiceport.Engine.Tests/VisitKeyTests.cs`                                      | `packages/engine/src/visit-key-tests.test.ts`                                        |
| S3    | `tests/Spiceport.Engine.Tests/WalkEquivalencePropertyTests.cs`                       | `packages/engine/src/walk-equivalence-property-tests.test.ts`                        |
| S4    | `src/Spiceport.Server/Datastore/DatastoreStateConverters.cs`                         | `packages/grains/src/datastore-state-converters.ts`                                  |
| S4    | `src/Spiceport.Server/Datastore/GrainBackedDatastore.cs`                             | `packages/grains/src/grain-backed-datastore.ts`                                      |
| S4    | `src/Spiceport.Server/Datastore/LogEventFactory.cs`                                  | `packages/grains/src/log-event-factory.ts`                                           |
| S4    | `src/Spiceport.Server/Datastore/LogFold.cs`                                          | `packages/grains/src/log-fold.ts`                                                    |
| S4    | `src/Spiceport.Server/Datastore/LogWatchHub.cs`                                      | `packages/grains/src/log-watch-hub.ts`                                               |
| S4    | `src/Spiceport.Server/Datastore/MetaFold.cs`                                         | `packages/grains/src/meta-fold.ts`                                                   |
| S4    | `src/Spiceport.Server/Datastore/PreconditionMessages.cs`                             | `packages/grains/src/precondition-messages.ts`                                       |
| S4    | `src/Spiceport.Server/Datastore/SequencerStateFetch.cs`                              | `packages/grains/src/sequencer-state-fetch.ts`                                       |
| S4    | `src/Spiceport.Server/Datastore/ShardFold.cs`                                        | `packages/grains/src/shard-fold.ts`                                                  |
| S4    | `src/Spiceport.Server/Datastore/StoredSchemaHash.cs`                                 | `packages/grains/src/stored-schema-hash.ts`                                          |
| S4    | `src/Spiceport.Server/Grains.Abstractions/CommitContract.cs`                         | `packages/grains/src/commit-contract.ts`                                             |
| S4    | `src/Spiceport.Server/Grains.Abstractions/ConsistencyWire.cs`                        | `packages/grains/src/consistency-wire.ts`                                            |
| S4    | `src/Spiceport.Server/Grains.Abstractions/DatastoreDtos.cs`                          | `packages/grains/src/datastore-dtos.ts`                                              |
| S4    | `src/Spiceport.Server/Grains.Abstractions/DatastoreGrainState.cs`                    | `packages/grains/src/datastore-grain-state.ts`                                       |
| S4    | `src/Spiceport.Server/Grains.Abstractions/DatastoreMetaState.cs`                     | `packages/grains/src/datastore-meta-state.ts`                                        |
| S4    | `src/Spiceport.Server/Grains.Abstractions/DispatchContext.cs`                        | `packages/grains/src/dispatch-context.ts`                                            |
| S4    | `src/Spiceport.Server/Grains.Abstractions/DispatchFailedException.cs`                | `packages/grains/src/dispatch-failed-exception.ts`                                   |
| S4    | `src/Spiceport.Server/Grains.Abstractions/GraphShardKey.cs`                          | `packages/grains/src/graph-shard-key.ts`                                             |
| S4    | `src/Spiceport.Server/Grains.Abstractions/GraphShardState.cs`                        | `packages/grains/src/graph-shard-state.ts`                                           |
| S4    | `src/Spiceport.Server/Grains.Abstractions/ICheckGrain.cs`                            | `packages/grains/src/i-check-grain.ts`                                               |
| S4    | `src/Spiceport.Server/Grains.Abstractions/IDatastoreGrain.cs`                        | `packages/grains/src/i-datastore-grain.ts`                                           |
| S4    | `src/Spiceport.Server/Grains.Abstractions/IDatastoreWatcher.cs`                      | `packages/grains/src/i-datastore-watcher.ts`                                         |
| S4    | `src/Spiceport.Server/Grains.Abstractions/IGraphShardGrain.cs`                       | `packages/grains/src/i-graph-shard-grain.ts`                                         |
| S4    | `src/Spiceport.Server/Grains.Abstractions/IMembershipWalkGrain.cs`                   | `packages/grains/src/i-membership-walk-grain.ts`                                     |
| S4    | `src/Spiceport.Server/Grains.Abstractions/IRelationshipsGrain.cs`                    | `packages/grains/src/i-relationships-grain.ts`                                       |
| S4    | `src/Spiceport.Server/Grains.Abstractions/ISubjectFrontierGrain.cs`                  | `packages/grains/src/i-subject-frontier-grain.ts`                                    |
| S4    | `src/Spiceport.Server/Grains.Abstractions/LogEvent.cs`                               | `packages/grains/src/log-event.ts`                                                   |
| S4    | `src/Spiceport.Server/Grains.Abstractions/PreconditionFailedException.cs`            | `packages/grains/src/precondition-failed-exception.ts`                               |
| S4    | `src/Spiceport.Server/Grains.Abstractions/RelationshipsDtos.cs`                      | `packages/grains/src/relationships-dtos.ts`                                          |
| S4    | `src/Spiceport.Server/Grains.Abstractions/ReverseOpsDtos.cs`                         | `packages/grains/src/reverse-ops-dtos.ts`                                            |
| S4    | `src/Spiceport.Server/Grains.Abstractions/SchemaWriteValidationException.cs`         | `packages/grains/src/schema-write-validation-exception.ts`                           |
| S4    | `src/Spiceport.Server/Grains.Abstractions/SequencerOverloadedException.cs`           | `packages/grains/src/sequencer-overloaded-exception.ts`                              |
| S4    | `src/Spiceport.Server/Grains.Abstractions/SerializedCaveat.cs`                       | `packages/grains/src/serialized-caveat.ts`                                           |
| S4    | `src/Spiceport.Server/Grains.Abstractions/SubjectFrontierDtos.cs`                    | `packages/grains/src/subject-frontier-dtos.ts`                                       |
| S4    | `src/Spiceport.Server/Grains.Abstractions/WriteConflictException.cs`                 | `packages/grains/src/write-conflict-exception.ts`                                    |
| S4    | `src/Spiceport.Server/Grains/ActivationMemoOptions.cs`                               | `packages/grains/src/activation-memo-options.ts`                                     |
| S4    | `src/Spiceport.Server/Grains/BulkExportCursor.cs`                                    | `packages/grains/src/bulk-export-cursor.ts`                                          |
| S4    | `src/Spiceport.Server/Grains/CaveatWire.cs`                                          | `packages/grains/src/caveat-wire.ts`                                                 |
| S4    | `src/Spiceport.Server/Grains/CheckDispatchFilters.cs`                                | `packages/grains/src/check-dispatch-filters.ts`                                      |
| S4    | `src/Spiceport.Server/Grains/CheckGrain.cs`                                          | `packages/grains/src/check-grain.ts`                                                 |
| S4    | `src/Spiceport.Server/Grains/DatastoreGcOptions.cs`                                  | `packages/grains/src/datastore-gc-options.ts`                                        |
| S4    | `src/Spiceport.Server/Grains/DatastoreGrain.cs`                                      | `packages/grains/src/datastore-grain.ts`                                             |
| S4    | `src/Spiceport.Server/Grains/DispatchErrorMapper.cs`                                 | `packages/grains/src/dispatch-error-mapper.ts`                                       |
| S4    | `src/Spiceport.Server/Grains/FrontierWire.cs`                                        | `packages/grains/src/frontier-wire.ts`                                               |
| S4    | `src/Spiceport.Server/Grains/GrainKey.cs`                                            | `packages/grains/src/grain-key.ts`                                                   |
| S4    | `src/Spiceport.Server/Grains/GrainKeyCodec.cs`                                       | `packages/grains/src/grain-key-codec.ts`                                             |
| S4    | `src/Spiceport.Server/Grains/GraphLocalityPlacement.cs`                              | `packages/grains/src/graph-locality-placement.ts`                                    |
| S4    | `src/Spiceport.Server/Grains/GraphLocalityPlacementDirector.cs`                      | `packages/grains/src/graph-locality-placement-director.ts`                           |
| S4    | `src/Spiceport.Server/Grains/GraphPlacementOptions.cs`                               | `packages/grains/src/graph-placement-options.ts`                                     |
| S4    | `src/Spiceport.Server/Grains/GraphShardGrain.cs`                                     | `packages/grains/src/graph-shard-grain.ts`                                           |
| S4    | `src/Spiceport.Server/Grains/GraphShardGrainKey.cs`                                  | `packages/grains/src/graph-shard-grain-key.ts`                                       |
| S4    | `src/Spiceport.Server/Grains/IDispatchMetrics.cs`                                    | `packages/grains/src/i-dispatch-metrics.ts`                                          |
| S4    | `src/Spiceport.Server/Grains/IGraphReaderSource.cs`                                  | `packages/grains/src/i-graph-reader-source.ts`                                       |
| S4    | `src/Spiceport.Server/Grains/IPermissionChecker.cs`                                  | `packages/grains/src/i-permission-checker.ts`                                        |
| S4    | `src/Spiceport.Server/Grains/ISchemaProvider.cs`                                     | `packages/grains/src/i-schema-provider.ts`                                           |
| S4    | `src/Spiceport.Server/Grains/ISchemaSource.cs`                                       | `packages/grains/src/i-schema-source.ts`                                             |
| S4    | `src/Spiceport.Server/Grains/ISequencerMetrics.cs`                                   | `packages/grains/src/i-sequencer-metrics.ts`                                         |
| S4    | `src/Spiceport.Server/Grains/ISnapshotScanner.cs`                                    | `packages/grains/src/i-snapshot-scanner.ts`                                          |
| S4    | `src/Spiceport.Server/Grains/JsonElementSurrogate.cs`                                | `packages/grains/src/json-element-surrogate.ts`                                      |
| S4    | `src/Spiceport.Server/Grains/MembershipWalkGrain.cs`                                 | `packages/grains/src/membership-walk-grain.ts`                                       |
| S4    | `src/Spiceport.Server/Grains/MembershipWalkKey.cs`                                   | `packages/grains/src/membership-walk-key.ts`                                         |
| S4    | `src/Spiceport.Server/Grains/MembershipWalkOptions.cs`                               | `packages/grains/src/membership-walk-options.ts`                                     |
| S4    | `src/Spiceport.Server/Grains/MemoGrainOptions.cs`                                    | `packages/grains/src/memo-grain-options.ts`                                          |
| S4    | `src/Spiceport.Server/Grains/OrleansDispatcher.cs`                                   | `packages/grains/src/orleans-dispatcher.ts`                                          |
| S4    | `src/Spiceport.Server/Grains/RelationshipReads.cs`                                   | `packages/grains/src/relationship-reads.ts`                                          |
| S4    | `src/Spiceport.Server/Grains/RelationshipsGrain.cs`                                  | `packages/grains/src/relationships-grain.ts`                                         |
| S4    | `src/Spiceport.Server/Grains/ReverseOps.cs`                                          | `packages/grains/src/reverse-ops.ts`                                                 |
| S4    | `src/Spiceport.Server/Grains/ReverseOpsCursorCodec.cs`                               | `packages/grains/src/reverse-ops-cursor-codec.ts`                                    |
| S4    | `src/Spiceport.Server/Grains/ReverseOpsSupport.cs`                                   | `packages/grains/src/reverse-ops-support.ts`                                         |
| S4    | `src/Spiceport.Server/Grains/RevisionCodec.cs`                                       | `packages/grains/src/revision-codec.ts`                                              |
| S4    | `src/Spiceport.Server/Grains/RevisionNotFoundSurrogate.cs`                           | `packages/grains/src/revision-not-found-surrogate.ts`                                |
| S4    | `src/Spiceport.Server/Grains/SchemaChangeValidator.cs`                               | `packages/grains/src/schema-change-validator.ts`                                     |
| S4    | `src/Spiceport.Server/Grains/SchemaDiff.cs`                                          | `packages/grains/src/schema-diff.ts`                                                 |
| S4    | `src/Spiceport.Server/Grains/SchemaResolver.cs`                                      | `packages/grains/src/schema-resolver.ts`                                             |
| S4    | `src/Spiceport.Server/Grains/SequencerAdmission.cs`                                  | `packages/grains/src/sequencer-admission.ts`                                         |
| S4    | `src/Spiceport.Server/Grains/SequencerAdmissionOptions.cs`                           | `packages/grains/src/sequencer-admission-options.ts`                                 |
| S4    | `src/Spiceport.Server/Grains/ServiceCollectionExtensions.cs`                         | `packages/grains/src/service-collection-extensions.ts`                               |
| S4    | `src/Spiceport.Server/Grains/ShardedGraphReader.cs`                                  | `packages/grains/src/sharded-graph-reader.ts`                                        |
| S4    | `src/Spiceport.Server/Grains/SiloBuilderExtensions.cs`                               | `packages/grains/src/silo-builder-extensions.ts`                                     |
| S4    | `src/Spiceport.Server/Grains/StableHash.cs`                                          | `packages/grains/src/stable-hash.ts`                                                 |
| S4    | `src/Spiceport.Server/Grains/SubjectFrontierGrain.cs`                                | `packages/grains/src/subject-frontier-grain.ts`                                      |
| S4    | `src/Spiceport.Server/Grains/SubjectFrontierKey.cs`                                  | `packages/grains/src/subject-frontier-key.ts`                                        |
| S4    | `src/Spiceport.Server/Grains/SubjectFrontierMemoOptions.cs`                          | `packages/grains/src/subject-frontier-memo-options.ts`                               |
| S4    | `src/Spiceport.Server/Grains/WireConvert.cs`                                         | `packages/grains/src/wire-convert.ts`                                                |
| S4    | `tests/Spiceport.Conformance.Tests/SteelThread/SteelThreadTests.cs`                  | `packages/conformance/src/steel-thread-tests.test.ts`                                |
| S4    | `tests/Spiceport.Grains.Tests/ActivationMemoMeshTests.cs`                            | `packages/grains/src/activation-memo-mesh-tests.test.ts`                             |
| S4    | `tests/Spiceport.Grains.Tests/AuthzedExperimentalV1ServiceTests.cs`                  | `packages/grains/src/authzed-experimental-v1-service-tests.test.ts`                  |
| S4    | `tests/Spiceport.Grains.Tests/AuthzedPermissionsV1ServiceTests.cs`                   | `packages/grains/src/authzed-permissions-v1-service-tests.test.ts`                   |
| S4    | `tests/Spiceport.Grains.Tests/AuthzedSchemaV1ServiceTests.cs`                        | `packages/grains/src/authzed-schema-v1-service-tests.test.ts`                        |
| S4    | `tests/Spiceport.Grains.Tests/AuthzedWatchV1ServiceTests.cs`                         | `packages/grains/src/authzed-watch-v1-service-tests.test.ts`                         |
| S4    | `tests/Spiceport.Grains.Tests/BatchCheckGrpcServiceTests.cs`                         | `packages/grains/src/batch-check-grpc-service-tests.test.ts`                         |
| S4    | `tests/Spiceport.Grains.Tests/BatchCheckMeshTests.cs`                                | `packages/grains/src/batch-check-mesh-tests.test.ts`                                 |
| S4    | `tests/Spiceport.Grains.Tests/BulkGrpcServiceTests.cs`                               | `packages/grains/src/bulk-grpc-service-tests.test.ts`                                |
| S4    | `tests/Spiceport.Grains.Tests/CancellationAndImmutabilityTests.cs`                   | `packages/grains/src/cancellation-and-immutability-tests.test.ts`                    |
| S4    | `tests/Spiceport.Grains.Tests/CheckDispatchFiltersTests.cs`                          | `packages/grains/src/check-dispatch-filters-tests.test.ts`                           |
| S4    | `tests/Spiceport.Grains.Tests/ColdStartTests.cs`                                     | `packages/grains/src/cold-start-tests.test.ts`                                       |
| S4    | `tests/Spiceport.Grains.Tests/CommitContractTests.cs`                                | `packages/grains/src/commit-contract-tests.test.ts`                                  |
| S4    | `tests/Spiceport.Grains.Tests/ConformanceMeshTests.cs`                               | `packages/grains/src/conformance-mesh-tests.test.ts`                                 |
| S4    | `tests/Spiceport.Grains.Tests/ConsistencyMeshTests.cs`                               | `packages/grains/src/consistency-mesh-tests.test.ts`                                 |
| S4    | `tests/Spiceport.Grains.Tests/ConsistencyWireSerializationTests.cs`                  | `packages/grains/src/consistency-wire-serialization-tests.test.ts`                   |
| S4    | `tests/Spiceport.Grains.Tests/DataPlaneGrpcServiceTests.cs`                          | `packages/grains/src/data-plane-grpc-service-tests.test.ts`                          |
| S4    | `tests/Spiceport.Grains.Tests/DataPlaneMeshTests.cs`                                 | `packages/grains/src/data-plane-mesh-tests.test.ts`                                  |
| S4    | `tests/Spiceport.Grains.Tests/DatastoreGcFoldTests.cs`                               | `packages/grains/src/datastore-gc-fold-tests.test.ts`                                |
| S4    | `tests/Spiceport.Grains.Tests/DatastoreGcMeshTests.cs`                               | `packages/grains/src/datastore-gc-mesh-tests.test.ts`                                |
| S4    | `tests/Spiceport.Grains.Tests/DatastoreInterleavedReadTests.cs`                      | `packages/grains/src/datastore-interleaved-read-tests.test.ts`                       |
| S4    | `tests/Spiceport.Grains.Tests/DatastoreStateWireRoundTripTests.cs`                   | `packages/grains/src/datastore-state-wire-round-trip-tests.test.ts`                  |
| S4    | `tests/Spiceport.Grains.Tests/DispatchContextTestHelper.cs`                          | `packages/grains/src/dispatch-context-test-helper.test.ts`                           |
| S4    | `tests/Spiceport.Grains.Tests/DispatchContextTests.cs`                               | `packages/grains/src/dispatch-context-tests.test.ts`                                 |
| S4    | `tests/Spiceport.Grains.Tests/DispatchErrorMapperTests.cs`                           | `packages/grains/src/dispatch-error-mapper-tests.test.ts`                            |
| S4    | `tests/Spiceport.Grains.Tests/DispatchMeshMetricsTests.cs`                           | `packages/grains/src/dispatch-mesh-metrics-tests.test.ts`                            |
| S4    | `tests/Spiceport.Grains.Tests/Durability/AdoNetDatastoreFixture.cs`                  | `packages/grains/src/ado-net-datastore-fixture.test.ts`                              |
| S4    | `tests/Spiceport.Grains.Tests/Durability/DatastoreGrainDurabilityTests.cs`           | `packages/grains/src/datastore-grain-durability-tests.test.ts`                       |
| S4    | `tests/Spiceport.Grains.Tests/Durability/ThinLayoutDurabilityTests.cs`               | `packages/grains/src/thin-layout-durability-tests.test.ts`                           |
| S4    | `tests/Spiceport.Grains.Tests/FakeGrainCallContexts.cs`                              | `packages/grains/src/fake-grain-call-contexts.test.ts`                               |
| S4    | `tests/Spiceport.Grains.Tests/FrontierCorpusEquivalenceTests.cs`                     | `packages/grains/src/frontier-corpus-equivalence-tests.test.ts`                      |
| S4    | `tests/Spiceport.Grains.Tests/FrontierWireRoundTripTests.cs`                         | `packages/grains/src/frontier-wire-round-trip-tests.test.ts`                         |
| S4    | `tests/Spiceport.Grains.Tests/FullCorpusMeshVisitedSetTests.cs`                      | `packages/grains/src/full-corpus-mesh-visited-set-tests.test.ts`                     |
| S4    | `tests/Spiceport.Grains.Tests/GrainBackedDatastoreFidelityTests.cs`                  | `packages/grains/src/grain-backed-datastore-fidelity-tests.test.ts`                  |
| S4    | `tests/Spiceport.Grains.Tests/GrainBackedDatastoreWriteBaseTests.cs`                 | `packages/grains/src/grain-backed-datastore-write-base-tests.test.ts`                |
| S4    | `tests/Spiceport.Grains.Tests/GrainKeyCodecTests.cs`                                 | `packages/grains/src/grain-key-codec-tests.test.ts`                                  |
| S4    | `tests/Spiceport.Grains.Tests/GraphLocalityPlacementTests.cs`                        | `packages/grains/src/graph-locality-placement-tests.test.ts`                         |
| S4    | `tests/Spiceport.Grains.Tests/IsolatedWatchHub.cs`                                   | `packages/grains/src/isolated-watch-hub.test.ts`                                     |
| S4    | `tests/Spiceport.Grains.Tests/LogEventEquivalenceTests.cs`                           | `packages/grains/src/log-event-equivalence-tests.test.ts`                            |
| S4    | `tests/Spiceport.Grains.Tests/MembershipWalkGrainTests.cs`                           | `packages/grains/src/membership-walk-grain-tests.test.ts`                            |
| S4    | `tests/Spiceport.Grains.Tests/MeshClusterCollection.cs`                              | `packages/grains/src/mesh-cluster-collection.test.ts`                                |
| S4    | `tests/Spiceport.Grains.Tests/MeshTestCluster.cs`                                    | `packages/grains/src/mesh-test-cluster.test.ts`                                      |
| S4    | `tests/Spiceport.Grains.Tests/NativeCancellationProbeTests.cs`                       | `packages/grains/src/native-cancellation-probe-tests.test.ts`                        |
| S4    | `tests/Spiceport.Grains.Tests/ReverseOpsCorpusMeshTests.cs`                          | `packages/grains/src/reverse-ops-corpus-mesh-tests.test.ts`                          |
| S4    | `tests/Spiceport.Grains.Tests/ReverseOpsGrpcServiceTests.cs`                         | `packages/grains/src/reverse-ops-grpc-service-tests.test.ts`                         |
| S4    | `tests/Spiceport.Grains.Tests/ReverseOpsMeshTests.cs`                                | `packages/grains/src/reverse-ops-mesh-tests.test.ts`                                 |
| S4    | `tests/Spiceport.Grains.Tests/SameKeyCycleMeshTests.cs`                              | `packages/grains/src/same-key-cycle-mesh-tests.test.ts`                              |
| S4    | `tests/Spiceport.Grains.Tests/SchemaAtRevisionMeshTests.cs`                          | `packages/grains/src/schema-at-revision-mesh-tests.test.ts`                          |
| S4    | `tests/Spiceport.Grains.Tests/SchemaPropagationMeshTests.cs`                         | `packages/grains/src/schema-propagation-mesh-tests.test.ts`                          |
| S4    | `tests/Spiceport.Grains.Tests/SeedDataTests.cs`                                      | `packages/grains/src/seed-data-tests.test.ts`                                        |
| S4    | `tests/Spiceport.Grains.Tests/SeededFixtureMeshTests.cs`                             | `packages/grains/src/seeded-fixture-mesh-tests.test.ts`                              |
| S4    | `tests/Spiceport.Grains.Tests/SequencerAdmissionTests.cs`                            | `packages/grains/src/sequencer-admission-tests.test.ts`                              |
| S4    | `tests/Spiceport.Grains.Tests/SequencerMetricsTests.cs`                              | `packages/grains/src/sequencer-metrics-tests.test.ts`                                |
| S4    | `tests/Spiceport.Grains.Tests/ShardFoldLemmaTests.cs`                                | `packages/grains/src/shard-fold-lemma-tests.test.ts`                                 |
| S4    | `tests/Spiceport.Grains.Tests/ShardedReaderCorpusMeshTests.cs`                       | `packages/grains/src/sharded-reader-corpus-mesh-tests.test.ts`                       |
| S4    | `tests/Spiceport.Grains.Tests/ShardedReaderEquivalenceTests.cs`                      | `packages/grains/src/sharded-reader-equivalence-tests.test.ts`                       |
| S4    | `tests/Spiceport.Grains.Tests/SnapshotScannerTests.cs`                               | `packages/grains/src/snapshot-scanner-tests.test.ts`                                 |
| S4    | `tests/Spiceport.Grains.Tests/Stage1JournaledWritePathTests.cs`                      | `packages/grains/src/stage1-journaled-write-path-tests.test.ts`                      |
| S4    | `tests/Spiceport.Grains.Tests/Stage3WatchOverLogTests.cs`                            | `packages/grains/src/stage3-watch-over-log-tests.test.ts`                            |
| S4    | `tests/Spiceport.Grains.Tests/Stage3WatchPushMeshTests.cs`                           | `packages/grains/src/stage3-watch-push-mesh-tests.test.ts`                           |
| S4    | `tests/Spiceport.Grains.Tests/Stage4CorpusEquivalenceTests.cs`                       | `packages/grains/src/stage4-corpus-equivalence-tests.test.ts`                        |
| S4    | `tests/Spiceport.Grains.Tests/Stage4LeopardMeshTests.cs`                             | `packages/grains/src/stage4-leopard-mesh-tests.test.ts`                              |
| S4    | `tests/Spiceport.Grains.Tests/SubjectFrontierKeyTests.cs`                            | `packages/grains/src/subject-frontier-key-tests.test.ts`                             |
| S4    | `tests/Spiceport.Grains.Tests/SubjectFrontierMemoMeshTests.cs`                       | `packages/grains/src/subject-frontier-memo-mesh-tests.test.ts`                       |
| S4    | `tests/Spiceport.Grains.Tests/ThinSequencerTests.cs`                                 | `packages/grains/src/thin-sequencer-tests.test.ts`                                   |
| S4    | `tests/Spiceport.Grains.Tests/WatchGrpcServiceTests.cs`                              | `packages/grains/src/watch-grpc-service-tests.test.ts`                               |
| S4    | `tests/Spiceport.Grains.Tests/WriteSafetyGrpcServiceTests.cs`                        | `packages/grains/src/write-safety-grpc-service-tests.test.ts`                        |
| S5    | `src/Spiceport.Api/AuthzedExperimentalV1Service.cs`                                  | `packages/api/src/authzed-experimental-v1-service.ts`                                |
| S5    | `src/Spiceport.Api/AuthzedPermissionsV1Service.cs`                                   | `packages/api/src/authzed-permissions-v1-service.ts`                                 |
| S5    | `src/Spiceport.Api/AuthzedSchemaV1Service.cs`                                        | `packages/api/src/authzed-schema-v1-service.ts`                                      |
| S5    | `src/Spiceport.Api/AuthzedWatchV1Service.cs`                                         | `packages/api/src/authzed-watch-v1-service.ts`                                       |
| S5    | `src/Spiceport.Api/BulkGrpcService.cs`                                               | `packages/api/src/bulk-grpc-service.ts`                                              |
| S5    | `src/Spiceport.Api/PermissionsGrpcService.cs`                                        | `packages/api/src/permissions-grpc-service.ts`                                       |
| S5    | `src/Spiceport.Api/Program.cs`                                                       | `packages/api/src/program.ts`                                                        |
| S5    | `src/Spiceport.Api/ReflectionMapper.cs`                                              | `packages/api/src/reflection-mapper.ts`                                              |
| S5    | `src/Spiceport.Api/RequestLimits.cs`                                                 | `packages/api/src/request-limits.ts`                                                 |
| S5    | `src/Spiceport.Api/SchemaFilters.cs`                                                 | `packages/api/src/schema-filters.ts`                                                 |
| S5    | `src/Spiceport.Api/SchemaValidation.cs`                                              | `packages/api/src/schema-validation.ts`                                              |
| S5    | `src/Spiceport.Api/SeedData.cs`                                                      | `packages/api/src/seed-data.ts`                                                      |
| S5    | `src/Spiceport.Api/WatchGrpcService.cs`                                              | `packages/api/src/watch-grpc-service.ts`                                             |
| S5    | `src/Spiceport.Server/Hosting/DatastoreStorageConfig.cs`                             | `packages/silo/src/datastore-storage-config.ts`                                      |
| S5    | `src/Spiceport.Silo/Program.cs`                                                      | `packages/silo/src/program.ts`                                                       |
| S5    | `src/Spiceport.Silo/SiloSchema.cs`                                                   | `packages/silo/src/silo-schema.ts`                                                   |
| S5    | `tests/Spiceport.Differential.Tests/CorpusDifferentialTests.cs`                      | `packages/differential/src/corpus-differential-tests.test.ts`                        |
| S5    | `tests/Spiceport.Differential.Tests/DifferentialConformanceTests.cs`                 | `packages/differential/src/differential-conformance-tests.test.ts`                   |
| S5    | `tests/Spiceport.Differential.Tests/DuplicateWriteRelationshipsDifferentialTests.cs` | `packages/differential/src/duplicate-write-relationships-differential-tests.test.ts` |
| S5    | `tests/Spiceport.Differential.Tests/ImportBulkRelationshipsDifferentialTests.cs`     | `packages/differential/src/import-bulk-relationships-differential-tests.test.ts`     |
| S5    | `tests/Spiceport.Differential.Tests/SpiceDbContainerFixture.cs`                      | `packages/differential/src/spice-db-container-fixture.test.ts`                       |
| S5    | `tests/Spiceport.Differential.Tests/SpiceDbGrpcClient.cs`                            | `packages/differential/src/spice-db-grpc-client.test.ts`                             |
| S5    | `tests/Spiceport.Differential.Tests/SpiceDbReset.cs`                                 | `packages/differential/src/spice-db-reset.test.ts`                                   |
| S5    | `tests/Spiceport.Differential.Tests/WriteSchemaWildcardTransitivityTests.cs`         | `packages/differential/src/write-schema-wildcard-transitivity-tests.test.ts`         |

## Spiceport files with no SpaceDB target

C# constructs that carry no code across. Listed so the ledger still accounts for every source
file, rather than leaving them to look overlooked.

| Spiceport                                           | Why                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/Spiceport.Datastore/InternalsVisibleTo.cs`     | An assembly-level `[InternalsVisibleTo]` directive. C# `internal` has no TypeScript counterpart: a module either exports a name or it does not, and there is no friend-assembly grant to reproduce. What it encodes — that the grain layer and the gate tests reach into the MVCC internals deliberately — is preserved by exporting those names normally and saying so at the site. |
| `src/Spiceport.Server/Grains/InternalsVisibleTo.cs` | As above, for the grain layer.                                                                                                                                                                                                                                                                                                                                                       |

## Files with no Spiceport source

Types the port introduced because .NET supplies them and TypeScript does not. They have no C#
counterpart, so they have no row above.

| SpaceDB                                       | Stands in for                                 |
| --------------------------------------------- | --------------------------------------------- |
| `packages/core/src/invalid-argument-error.ts` | `ArgumentException` / `ArgumentNullException` |
| `packages/core/src/format-error.ts`           | `FormatException`                             |
| `packages/engine/src/cel-context-value.ts`    | Cel.NET's absent-map-key semantics            |
| `packages/engine/src/seeded-random.ts`        | `System.Random(int seed)`                     |
| `packages/grains/src/convert-base64.ts`       | `Convert.ToBase64String` / `FromBase64String` |
