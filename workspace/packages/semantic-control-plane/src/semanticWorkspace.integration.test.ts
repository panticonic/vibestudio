import { describe, expect, it } from "vitest";
import { sha256Hex } from "@vibestudio/content-addressing";
import { createInMemorySql } from "@workspace/runtime/worker/test-utils";
import {
  vcsInspectResultSchema,
  vcsNeighborsResultSchema,
  type VcsProvenanceEdge,
  type VcsStateNodeRef,
} from "@vibestudio/service-schemas/vcs";
import { createSemanticVcsSchema } from "./semanticVcsSchema.js";
import {
  SemanticWorkspace,
  type SemanticDispatchRequest,
  type SemanticDispatchResult,
} from "./semanticWorkspace.js";
import { SemanticVcsStore } from "./semanticVcsStore.js";

const timestamp = "2026-07-15T00:00:00.000Z";
const ingress: SemanticDispatchRequest["ingress"] = {
  causalParent: {
    kind: "trajectory-invocation",
    logId: "trajectory:test",
    head: "main",
    invocationId: "invocation:test",
  },
  contextIntegrity: { class: "internal", externalKeys: [] },
};

function pending<T>(dispatch: SemanticDispatchResult): T {
  if (dispatch.kind !== "effects-pending") throw new Error(`expected pending effects`);
  return dispatch.result as T;
}

async function expectListReadLineageParity(
  semantic: SemanticWorkspace,
  state: VcsStateNodeRef,
  repositoryId: string
): Promise<void> {
  const listed = await semantic.dispatch("listFiles", {
    ingress,
    input: { state, repositoryId, limit: 500 },
  });
  if (listed.kind !== "complete") throw new Error("listFiles did not complete");
  const files = (
    listed.result as {
      files: Array<{
        fileId: string;
        authoredChangeId: string;
        authoredByWorkUnitId: string;
        contentClass: "internal" | "external";
        externalKeys: string[];
      }>;
    }
  ).files;
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const read = await semantic.dispatch("readFile", {
      ingress,
      input: {
        state,
        repositoryId,
        file: { kind: "id", fileId: file.fileId },
      },
    });
    if (read.kind !== "host-read") throw new Error("readFile did not request an exact host read");
    expect(read.request).toMatchObject({
      fileId: file.fileId,
      authoredChangeId: file.authoredChangeId,
      authoredByWorkUnitId: file.authoredByWorkUnitId,
      contentClass: file.contentClass,
      externalKeys: file.externalKeys,
    });
  }
}

describe("SemanticWorkspace derived integration prerequisites", () => {
  it("derives ordered blockers once and enforces them through compare, integrate, commit, and push", async () => {
    const sql = await createInMemorySql();
    createSemanticVcsSchema(sql);
    sql.exec(`
      CREATE TABLE trajectory_invocations (
        log_id TEXT NOT NULL,
        head TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (log_id, head, invocation_id)
      )
    `);
    sql.exec(
      `INSERT INTO trajectory_invocations
       (log_id, head, invocation_id, status, updated_at)
       VALUES ('trajectory:test', 'main', 'invocation:test', 'active', ?)`,
      timestamp
    );
    const store = new SemanticVcsStore(sql, () => timestamp);
    let transactionOrdinal = 0;
    const createSemantic = () =>
      new SemanticWorkspace({
        workspaceId: "workspace:test",
        sql,
        store,
        now: () => timestamp,
        transaction: <T>(fn: () => T): T => {
          const savepoint = `integration_test_${transactionOrdinal++}`;
          sql.exec(`SAVEPOINT ${savepoint}`);
          try {
            const result = fn();
            sql.exec(`RELEASE ${savepoint}`);
            return result;
          } catch (error) {
            sql.exec(`ROLLBACK TO ${savepoint}`);
            sql.exec(`RELEASE ${savepoint}`);
            throw error;
          }
        },
      });
    const semantic = createSemantic();
    const acknowledge = (dispatch: SemanticDispatchResult): void => {
      if (dispatch.kind !== "effects-pending") throw new Error("mutation has no effect");
      for (const effect of dispatch.effects) {
        if (effect.kind === "publish-main") {
          semantic.acknowledgeEffect({
            effectId: effect.effectId,
            payloadDigest: effect.payloadDigest,
            receipt: {
              applied: true,
              appliedAt: timestamp,
            },
          });
          continue;
        }
        const repositories = effect.payload["repositories"] as Array<{
          repositoryId: string;
          repoPath: string;
          presence: "present" | "deleted";
          fileManifestId: string;
          source: { kind: "content-root"; contentRoot: string } | { kind: "delta" | "snapshot" };
        }>;
        semantic.acknowledgeEffect({
          effectId: effect.effectId,
          payloadDigest: effect.payloadDigest,
          receipt: {
            materializationId: effect.effectId,
            contextId: effect.payload["contextId"],
            targetState: effect.payload["targetState"],
            repositories: repositories
              .filter((repository) => repository.presence === "present")
              .map((repository) => ({
                repositoryId: repository.repositoryId,
                repoPath: repository.repoPath,
                contentRoot:
                  repository.source.kind === "content-root"
                    ? repository.source.contentRoot
                    : `state:${sha256Hex(
                        new TextEncoder().encode(
                          JSON.stringify({
                            targetState: effect.payload["targetState"],
                            repository,
                          })
                        )
                      )}`,
              })),
            payloadDigest: effect.payloadDigest,
          },
        });
      }
    };

    const initial = store.initializeWorkspace("context:source", "command:genesis");
    const importedBytes = new TextEncoder().encode("a");
    const importedContentHash = sha256Hex(importedBytes);
    const observationDispatch = await semantic.dispatch("importSnapshot", {
      ingress,
      input: {
        contextId: "context:source",
        commandId: "command:import",
        expectedWorkingHead: initial.working.ref,
        source: {
          kind: "generated",
          uri: "fixture://integration",
          snapshotRevision: "fixture:v1",
        },
        repositories: [
          {
            repoPath: "packages/fixture",
            files: [
              {
                path: "src/index.ts",
                contentHash: importedContentHash,
                mode: 0o644,
              },
            ],
          },
          ...Array.from({ length: 64 }, (_, ordinal) => ({
            repoPath: `projects/unchanged-${String(ordinal).padStart(3, "0")}`,
            files: [],
          })),
        ],
      },
    });
    if (observationDispatch.kind !== "effects-pending") {
      throw new Error("import did not request content observation");
    }
    const observation = observationDispatch.effects[0]!;
    expect(observation.kind).toBe("observe-content");
    const importedDispatch = semantic.acknowledgeEffect({
      effectId: observation.effectId,
      payloadDigest: observation.payloadDigest,
      receipt: {
        files: [
          {
            contentHash: importedContentHash,
            contentKind: "text",
            byteLength: 1,
            coordinateExtent: 1,
          },
        ],
      },
    });
    const imported = pending<{ eventId: string; importedRepositoryIds: string[] }>(
      importedDispatch
    );
    acknowledge(importedDispatch);
    store.initializeWorkspace("context:target", "command:target-genesis");
    sql.exec(
      `UPDATE vcs_contexts
          SET committed_event_id = ?, working_head_application_id = NULL
        WHERE context_id = 'context:target'`,
      imported.eventId
    );
    const repositoryId = imported.importedRepositoryIds[0]!;
    const unchangedRepositoryIds = imported.importedRepositoryIds.slice(1);
    expect(unchangedRepositoryIds).toHaveLength(64);
    const importedRoot = store.stateRoot({ kind: "event", eventId: imported.eventId });
    const repository = store.facts.member(importedRoot, repositoryId);
    if (repository?.presence !== "present") throw new Error("fixture repository is absent");
    const fileId = store.facts.pageManifest(repository.fileManifestId, { limit: 1 }).values[0]!
      .fileId;
    await expectListReadLineageParity(
      semantic,
      { kind: "event", eventId: imported.eventId },
      repositoryId
    );

    const firstDispatch = await semantic.dispatch("edit", {
      ingress,
      input: {
        contextId: "context:source",
        commandId: "command:first",
        expectedWorkingHead: { kind: "event", eventId: imported.eventId },
        changes: [{ kind: "file-mode", repositoryId, fileId, mode: 0o755 }],
      },
    });
    const first = pending<{
      workingHead: { kind: "application"; applicationId: string };
      changeIds: string[];
    }>(firstDispatch);
    if (firstDispatch.kind !== "effects-pending") throw new Error("first edit has no effect");
    const firstMaterialization = firstDispatch.effects.find(
      (effect) => effect.kind === "materialize-context"
    );
    const firstRepository = (
      firstMaterialization?.payload["repositories"] as
        | Array<{
            repositoryId: string;
            fileManifestId: string;
            source: { kind: string };
          }>
        | undefined
    )?.find((candidate) => candidate.repositoryId === repositoryId);
    expect(firstRepository).toMatchObject({
      repositoryId,
      // Placement identity stays stable across an in-place content edit. It
      // must therefore never be used as the host content-root cache key.
      fileManifestId: repository.fileManifestId,
      source: { kind: "delta" },
    });
    acknowledge(firstDispatch);
    const importedContentRoot = store.materializedRepositoryContentRoot(importedRoot, repositoryId);
    const firstWorkspaceRoot = store.stateRoot(first.workingHead);
    const firstContentRoot = store.materializedRepositoryContentRoot(
      firstWorkspaceRoot,
      repositoryId
    );
    expect(importedContentRoot).toMatch(/^state:[0-9a-f]{64}$/);
    expect(firstContentRoot).toMatch(/^state:[0-9a-f]{64}$/);
    expect(firstContentRoot).not.toBe(importedContentRoot);
    expect(
      sql
        .exec(
          `SELECT repository_id
             FROM gad_materialized_repository_states
            WHERE workspace_fact_root_id = ?
            ORDER BY repository_id`,
          firstWorkspaceRoot
        )
        .toArray()
    ).toEqual([{ repository_id: repositoryId }]);
    for (const unchangedRepositoryId of unchangedRepositoryIds) {
      expect(
        store.materializedRepositoryContentRoot(firstWorkspaceRoot, unchangedRepositoryId)
      ).toBeNull();
    }
    const secondDispatch = await semantic.dispatch("edit", {
      ingress,
      input: {
        contextId: "context:source",
        commandId: "command:second",
        expectedWorkingHead: first.workingHead,
        changes: [{ kind: "file-mode", repositoryId, fileId, mode: 0o600 }],
      },
    });
    const second = pending<{
      workingHead: { kind: "application"; applicationId: string };
      changeIds: string[];
    }>(secondDispatch);
    acknowledge(secondDispatch);
    const sourceMoveDispatch = await semantic.dispatch("move", {
      ingress,
      input: {
        contextId: "context:source",
        commandId: "command:source-repository-move",
        expectedWorkingHead: second.workingHead,
        moves: [
          {
            kind: "repository",
            repositoryId,
            destinationPath: "packages/fixture-renamed",
          },
        ],
      },
    });
    const sourceMove = pending<{
      workingHead: { kind: "application"; applicationId: string };
      changeIds: string[];
    }>(sourceMoveDispatch);
    acknowledge(sourceMoveDispatch);
    await expectListReadLineageParity(semantic, sourceMove.workingHead, repositoryId);
    const sourceCommitDispatch = await semantic.dispatch("commit", {
      ingress,
      input: {
        contextId: "context:source",
        commandId: "command:source-commit",
        expectedWorkingHead: sourceMove.workingHead,
        message: "Ordered file changes and a repository move",
      },
    });
    const sourceCommit = pending<{ event: { kind: "event"; eventId: string } }>(
      sourceCommitDispatch
    );
    acknowledge(sourceCommitDispatch);

    const compare = await semantic.dispatch("compare", {
      ingress,
      input: {
        target: { kind: "event", eventId: imported.eventId },
        sourceEventId: sourceCommit.event.eventId,
        view: "changes",
        limit: 100,
      },
    });
    if (compare.kind !== "complete") throw new Error("compare did not complete");
    const comparison = compare.result as {
      counts: { actionable: number; blocked: number; conflicting: number };
      changes: unknown[];
    };
    expect(comparison.counts).toMatchObject({ actionable: 3, blocked: 1, conflicting: 0 });
    expect(comparison.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          changeId: first.changeIds[0],
          disposition: { status: "actionable", applicability: "applicable" },
        }),
        expect.objectContaining({
          changeId: second.changeIds[0],
          disposition: {
            status: "actionable",
            applicability: "blocked",
            prerequisiteChangeIds: [first.changeIds[0]],
          },
        }),
      ])
    );

    await expect(
      semantic.dispatch("integrate", {
        ingress,
        input: {
          contextId: "context:target",
          commandId: "command:blocked",
          expectedWorkingHead: { kind: "event", eventId: imported.eventId },
          sourceEventId: sourceCommit.event.eventId,
          decision: { kind: "adopted", sourceChangeIds: second.changeIds },
        },
      })
    ).rejects.toMatchObject({
      code: "DependencyBlocked",
      detail: { blockingChangeIds: first.changeIds },
    });
    expect(store.command("command:blocked")).toBeNull();

    const adoptFirstDispatch = await semantic.dispatch("integrate", {
      ingress,
      input: {
        contextId: "context:target",
        commandId: "command:adopt-first",
        expectedWorkingHead: { kind: "event", eventId: imported.eventId },
        sourceEventId: sourceCommit.event.eventId,
        decision: { kind: "adopted", sourceChangeIds: first.changeIds },
      },
    });
    const adoptFirst = pending<{
      workingHead: { kind: "application"; applicationId: string };
      workUnitId: string;
      changeIds: string[];
      incorporatedChangeIds: string[];
    }>(adoptFirstDispatch);
    acknowledge(adoptFirstDispatch);
    expect(adoptFirst.changeIds).toEqual([]);
    expect(adoptFirst.incorporatedChangeIds).toEqual(first.changeIds);
    expect(
      sql
        .exec(
          `SELECT change_id FROM gad_applied_changes
            WHERE application_id = ? ORDER BY ordinal`,
          adoptFirst.workingHead.applicationId
        )
        .toArray()
    ).toEqual([{ change_id: first.changeIds[0] }]);
    expect(
      sql
        .exec(
          `SELECT COUNT(*) AS count FROM gad_changes WHERE work_unit_id = ?`,
          adoptFirst.workUnitId
        )
        .toArray()[0]
    ).toMatchObject({ count: 0 });
    const decisionId = String(
      (
        sql
          .exec(
            `SELECT decision_id FROM gad_integration_decisions WHERE work_unit_id = ?`,
            adoptFirst.workUnitId
          )
          .toArray()[0] as { decision_id: string }
      ).decision_id
    );
    const decisionRoot = { kind: "decision" as const, decisionId };
    const inspectWork = await semantic.dispatch("inspect", {
      ingress,
      input: {
        node: { kind: "work-unit", workUnitId: adoptFirst.workUnitId },
        edgeLimit: 20,
      },
    });
    if (inspectWork.kind !== "complete") throw new Error("work-unit inspection did not complete");
    expect(inspectWork.result).toMatchObject({
      node: {
        value: {
          incorporatedChangeCount: first.changeIds.length,
          incorporatedChangeIds: first.changeIds,
          decisionIds: [decisionId],
        },
      },
    });
    expect((inspectWork.result as { edges: VcsProvenanceEdge[] }).edges).toEqual(
      expect.arrayContaining([
        {
          kind: "incorporates-change",
          from: { kind: "work-unit", workUnitId: adoptFirst.workUnitId },
          to: { kind: "change", changeId: first.changeIds[0] },
        },
      ])
    );
    const inspectDecision = await semantic.dispatch("inspect", {
      ingress,
      input: { node: decisionRoot, edgeLimit: 20 },
    });
    if (inspectDecision.kind !== "complete")
      throw new Error("decision inspection did not complete");
    expect(inspectDecision.result).toMatchObject({
      node: {
        value: {
          kind: "adopted",
          sourceChangeIds: first.changeIds,
          resultAppliedChangeIds: [expect.stringMatching(/^applied-change:/)],
        },
      },
    });
    const allDecisionNeighbors = await semantic.dispatch("neighbors", {
      ingress,
      input: { root: decisionRoot, limit: 100 },
    });
    if (allDecisionNeighbors.kind !== "complete") throw new Error("neighbors did not complete");
    const expectedDecisionEdges = vcsNeighborsResultSchema.parse(allDecisionNeighbors.result).edges;
    expect(expectedDecisionEdges).toHaveLength(2);
    const pagedDecisionEdges: VcsProvenanceEdge[] = [];
    let decisionCursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const dispatch = await semantic.dispatch("neighbors", {
        ingress,
        input: {
          root: decisionRoot,
          limit: 1,
          ...(decisionCursor ? { cursor: decisionCursor } : {}),
        },
      });
      if (dispatch.kind !== "complete") throw new Error("neighbors did not complete");
      const page = vcsNeighborsResultSchema.parse(dispatch.result);
      pagedDecisionEdges.push(...page.edges);
      if (!page.nextCursor) break;
      expect(page.nextCursor).toMatch(/^semantic-page-v1\./u);
      decisionCursor = page.nextCursor;
    }
    expect(pagedDecisionEdges).toEqual(expectedDecisionEdges);

    await expect(
      semantic.dispatch("commit", {
        ingress,
        input: {
          contextId: "context:target",
          commandId: "command:premature-integration",
          expectedWorkingHead: adoptFirst.workingHead,
        },
      })
    ).rejects.toMatchObject({ code: "IntegrationIncomplete" });

    await expect(
      semantic.dispatch("commit", {
        ingress,
        input: {
          contextId: "context:target",
          commandId: "command:mismatched-integration-parent",
          expectedWorkingHead: adoptFirst.workingHead,
          integratesEventId: initial.committed.ref.eventId,
        },
      })
    ).rejects.toMatchObject({ code: "InvalidReference" });

    await expect(
      semantic.dispatch("integrate", {
        ingress,
        input: {
          contextId: "context:target",
          commandId: "command:mix-integration-source",
          expectedWorkingHead: adoptFirst.workingHead,
          sourceEventId: initial.committed.ref.eventId,
          decision: { kind: "adopted", sourceChangeIds: first.changeIds },
        },
      })
    ).rejects.toMatchObject({ code: "ConflictPresent" });

    const compareAfterFirst = await semantic.dispatch("compare", {
      ingress,
      input: {
        target: adoptFirst.workingHead,
        sourceEventId: sourceCommit.event.eventId,
        view: "changes",
        limit: 100,
      },
    });
    if (compareAfterFirst.kind !== "complete") throw new Error("compare did not complete");
    const comparisonAfterFirst = compareAfterFirst.result as {
      resolution: { complete: boolean; remainingChangeCount: number };
      counts: { blocked: number; conflicting: number };
      changes: Array<{ changeId: string; disposition: { status: string; applicability?: string } }>;
    };
    expect(comparisonAfterFirst.resolution).toEqual({
      complete: false,
      remainingChangeCount: 2,
    });
    expect(comparisonAfterFirst.counts).toMatchObject({ blocked: 0, conflicting: 0 });
    expect(comparisonAfterFirst.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          changeId: first.changeIds[0],
          disposition: { status: "shared" },
        }),
        expect.objectContaining({
          changeId: second.changeIds[0],
          disposition: { status: "actionable", applicability: "applicable" },
        }),
      ])
    );

    const adoptSecondDispatch = await semantic.dispatch("integrate", {
      ingress,
      input: {
        contextId: "context:target",
        commandId: "command:adopt-second",
        expectedWorkingHead: adoptFirst.workingHead,
        sourceEventId: sourceCommit.event.eventId,
        decision: { kind: "adopted", sourceChangeIds: second.changeIds },
      },
    });
    const adoptSecond = pending<{
      workingHead: { kind: "application"; applicationId: string };
    }>(adoptSecondDispatch);
    acknowledge(adoptSecondDispatch);

    const appliedChangeId = (applicationId: string, changeId: string): string => {
      const row = sql
        .exec(
          `SELECT applied_change_id FROM gad_applied_changes
            WHERE application_id = ? AND change_id = ?`,
          applicationId,
          changeId
        )
        .toArray()[0] as { applied_change_id: string } | undefined;
      if (!row) throw new Error(`missing applied change for ${applicationId}/${changeId}`);
      return row.applied_change_id;
    };
    const sourceFirstAppliedId = appliedChangeId(
      first.workingHead.applicationId,
      first.changeIds[0]!
    );
    const sourceSecondAppliedId = appliedChangeId(
      second.workingHead.applicationId,
      second.changeIds[0]!
    );
    const targetFirstAppliedId = appliedChangeId(
      adoptFirst.workingHead.applicationId,
      first.changeIds[0]!
    );
    const targetSecondAppliedId = appliedChangeId(
      adoptSecond.workingHead.applicationId,
      second.changeIds[0]!
    );

    const inspectApplied = await semantic.dispatch("inspect", {
      ingress,
      input: {
        node: { kind: "applied-change", appliedChangeId: targetSecondAppliedId },
        edgeLimit: 20,
      },
    });
    if (inspectApplied.kind !== "complete") throw new Error("applied-change inspection failed");
    expect(vcsInspectResultSchema.parse(inspectApplied.result)).toMatchObject({
      root: { kind: "applied-change", appliedChangeId: targetSecondAppliedId },
      node: {
        kind: "applied-change",
        value: {
          appliedChangeId: targetSecondAppliedId,
          applicationId: adoptSecond.workingHead.applicationId,
          changeId: second.changeIds[0],
        },
      },
      edges: expect.arrayContaining([
        {
          kind: "applies-change",
          from: {
            kind: "application",
            applicationId: adoptSecond.workingHead.applicationId,
          },
          to: { kind: "applied-change", appliedChangeId: targetSecondAppliedId },
        },
        {
          kind: "realizes-change",
          from: { kind: "applied-change", appliedChangeId: targetSecondAppliedId },
          to: { kind: "change", changeId: second.changeIds[0] },
        },
        {
          kind: "preserves-content",
          from: { kind: "applied-change", appliedChangeId: targetSecondAppliedId },
          to: { kind: "applied-change", appliedChangeId: targetFirstAppliedId },
        },
      ]),
    });

    const sourceAppliedNeighbors = await semantic.dispatch("neighbors", {
      ingress,
      input: {
        root: { kind: "applied-change", appliedChangeId: sourceSecondAppliedId },
        limit: 20,
      },
    });
    if (sourceAppliedNeighbors.kind !== "complete") {
      throw new Error("source applied-change neighbors failed");
    }
    expect(vcsNeighborsResultSchema.parse(sourceAppliedNeighbors.result).edges).toContainEqual({
      kind: "preserves-content",
      from: { kind: "applied-change", appliedChangeId: sourceSecondAppliedId },
      to: { kind: "applied-change", appliedChangeId: sourceFirstAppliedId },
    });

    const authoredChangeNeighbors = await semantic.dispatch("neighbors", {
      ingress,
      input: { root: { kind: "change", changeId: second.changeIds[0]! }, limit: 20 },
    });
    if (authoredChangeNeighbors.kind !== "complete") {
      throw new Error("authored-change neighbors failed");
    }
    const authoredEdges = vcsNeighborsResultSchema.parse(authoredChangeNeighbors.result).edges;
    expect(authoredEdges).toEqual(
      expect.arrayContaining([
        {
          kind: "realizes-change",
          from: { kind: "applied-change", appliedChangeId: sourceSecondAppliedId },
          to: { kind: "change", changeId: second.changeIds[0] },
        },
        {
          kind: "realizes-change",
          from: { kind: "applied-change", appliedChangeId: targetSecondAppliedId },
          to: { kind: "change", changeId: second.changeIds[0] },
        },
      ])
    );
    expect(authoredEdges.some((edge) => edge.kind.endsWith("-content"))).toBe(false);

    const adoptRepositoryMoveDispatch = await semantic.dispatch("integrate", {
      ingress,
      input: {
        contextId: "context:target",
        commandId: "command:adopt-repository-move",
        expectedWorkingHead: adoptSecond.workingHead,
        sourceEventId: sourceCommit.event.eventId,
        decision: { kind: "adopted", sourceChangeIds: sourceMove.changeIds },
      },
    });
    const adoptRepositoryMove = pending<{
      workingHead: { kind: "application"; applicationId: string };
    }>(adoptRepositoryMoveDispatch);
    acknowledge(adoptRepositoryMoveDispatch);
    const targetRoot = store.stateRoot(adoptRepositoryMove.workingHead);
    expect(store.facts.member(targetRoot, repositoryId)).toMatchObject({
      presence: "present",
      repoPath: "packages/fixture-renamed",
    });
    await expectListReadLineageParity(semantic, adoptRepositoryMove.workingHead, repositoryId);
    const resolvedCompare = await semantic.dispatch("compare", {
      ingress,
      input: {
        target: adoptRepositoryMove.workingHead,
        sourceEventId: sourceCommit.event.eventId,
        view: "changes",
        limit: 100,
      },
    });
    if (resolvedCompare.kind !== "complete") throw new Error("compare did not complete");
    expect(resolvedCompare.result).toMatchObject({
      resolution: { complete: true, remainingChangeCount: 0 },
      counts: { shared: 3, actionable: 0, alreadySatisfied: 0, accounted: 0 },
    });
    const integrationCommitDispatch = await semantic.dispatch("commit", {
      ingress,
      input: {
        contextId: "context:target",
        commandId: "command:integration-commit",
        expectedWorkingHead: adoptRepositoryMove.workingHead,
        message: "Accounted source in two local steps",
      },
    });
    const integrationCommit = pending<{ event: { kind: "event"; eventId: string } }>(
      integrationCommitDispatch
    );
    acknowledge(integrationCommitDispatch);
    expect(store.event(integrationCommit.event.eventId)?.parentEventIds).toContain(
      sourceCommit.event.eventId
    );
    const pushDispatch = await semantic.dispatch("push", {
      ingress,
      input: {
        contextId: "context:target",
        commandId: "command:push-integration",
        expectedCommittedEventId: integrationCommit.event.eventId,
        expectedMainEventId: initial.committed.ref.eventId,
      },
    });
    expect(pushDispatch.kind).toBe("effects-pending");
    if (pushDispatch.kind !== "effects-pending") throw new Error("push has no effect");
    const publicationRepository = (
      pushDispatch.effects[0]!.payload["repositories"] as Array<{
        repositoryId: string;
        source: { kind: string; contentRoot?: string };
      }>
    ).find((candidate) => candidate.repositoryId === repositoryId);
    const integrationRoot = store.stateRoot(integrationCommit.event);
    expect(publicationRepository).toEqual(
      expect.objectContaining({
        repositoryId,
        source: {
          kind: "content-root",
          contentRoot: store.materializedRepositoryContentRoot(integrationRoot, repositoryId),
        },
      })
    );
    expect(publicationRepository?.source.contentRoot).not.toBe(importedContentRoot);
    const publicationRepositories = pushDispatch.effects[0]!.payload["repositories"] as Array<{
      repositoryId: string;
      source: { kind: string };
    }>;
    expect(
      publicationRepositories.filter((candidate) =>
        unchangedRepositoryIds.includes(candidate.repositoryId)
      )
    ).toHaveLength(64);
    expect(
      publicationRepositories
        .filter((candidate) => unchangedRepositoryIds.includes(candidate.repositoryId))
        .every((candidate) => candidate.source.kind === "snapshot")
    ).toBe(true);
    const restarted = createSemantic();
    await expectListReadLineageParity(restarted, integrationCommit.event, repositoryId);
  });
});
