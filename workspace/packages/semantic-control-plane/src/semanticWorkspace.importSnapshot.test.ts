import { describe, expect, it } from "vitest";
import { sha256Hex } from "@vibestudio/content-addressing";
import {
  VCS_IMPORT_MAX_DESCRIPTOR_BYTES,
  vcsInspectResultSchema,
  vcsNeighborsResultSchema,
  type VcsProvenanceEdge,
  type VcsSemanticNodeRef,
} from "@vibestudio/service-schemas/vcs";
import { createInMemorySql } from "@workspace/runtime/worker/test-utils";
import { compactId } from "@workspace/vcs-engine";
import { createSemanticVcsSchema } from "./semanticVcsSchema.js";
import {
  SemanticWorkspace,
  type SemanticDispatchRequest,
  type SemanticDispatchResult,
} from "./semanticWorkspace.js";
import { SemanticVcsStore } from "./semanticVcsStore.js";

const timestamp = "2026-07-15T00:00:00.000Z";

async function authorityFixture() {
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
  const createSemantic = (querySql = sql) =>
    new SemanticWorkspace({
      workspaceId: "workspace:test",
      sql: querySql,
      store,
      now: () => timestamp,
      transaction: <T>(fn: () => T): T => {
        const savepoint = `import_snapshot_test_${transactionOrdinal++}`;
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
  const initial = store.initializeWorkspace("context:test", "command:genesis");
  return { semantic, restart: createSemantic, sql, store, initial };
}

const textFile = (path: string, text: string, mode = 0o644) => {
  const bytes = new TextEncoder().encode(text);
  return {
    bytes,
    descriptor: {
      path,
      contentHash: sha256Hex(bytes),
      mode,
    },
  };
};

const intrinsicDescriptor = (bytes: Uint8Array) => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return {
      contentKind: "text" as const,
      byteLength: bytes.length,
      coordinateExtent: text.length,
    };
  } catch {
    return {
      contentKind: "bytes" as const,
      byteLength: bytes.length,
      coordinateExtent: bytes.length,
    };
  }
};

function acknowledgeImportObservation(
  semantic: SemanticWorkspace,
  dispatch: SemanticDispatchResult,
  bytesByHash: ReadonlyMap<string, Uint8Array>
): SemanticDispatchResult {
  if (dispatch.kind !== "effects-pending") throw new Error("import did not request observation");
  const effect = dispatch.effects[0]!;
  expect(effect.kind).toBe("observe-content");
  const files = effect.payload["files"] as Array<{ contentHash: string }>;
  expect(new Set(files.map((file) => file.contentHash)).size).toBe(files.length);
  return semantic.acknowledgeEffect({
    effectId: effect.effectId,
    payloadDigest: effect.payloadDigest,
    receipt: {
      files: files.map((file) => {
        const bytes = bytesByHash.get(file.contentHash);
        if (!bytes) throw new Error(`fixture lacks ${file.contentHash}`);
        return { contentHash: file.contentHash, ...intrinsicDescriptor(bytes) };
      }),
    },
  });
}

function acknowledgeMaterialization(
  semantic: SemanticWorkspace,
  dispatch: SemanticDispatchResult,
  contentRoot = `state:${"0".repeat(64)}`
): void {
  if (dispatch.kind !== "effects-pending") throw new Error("mutation did not request projection");
  const effect = dispatch.effects[0]!;
  expect(effect.kind).toBe("materialize-context");
  const repositories = effect.payload["repositories"] as Array<{
    repositoryId: string;
    repoPath: string;
    presence: "present" | "deleted";
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
          contentRoot,
        })),
      payloadDigest: effect.payload["payloadDigest"],
    },
  });
}

async function completeImport(
  semantic: SemanticWorkspace,
  request: SemanticDispatchRequest,
  bytesByHash: ReadonlyMap<string, Uint8Array>
): Promise<{
  contextId: string;
  eventId: string;
  workUnitId: string;
  importedRepositoryIds: string[];
}> {
  const observation = await semantic.dispatch("importSnapshot", request);
  const projection = acknowledgeImportObservation(semantic, observation, bytesByHash);
  if (projection.kind !== "effects-pending") throw new Error("import did not complete");
  const result = projection.result as {
    contextId: string;
    eventId: string;
    workUnitId: string;
    importedRepositoryIds: string[];
  };
  acknowledgeMaterialization(semantic, projection);
  return result;
}

async function inspectAuthoredChanges(
  semantic: SemanticWorkspace,
  ingress: SemanticDispatchRequest["ingress"],
  workUnitId: string
) {
  const workInspection = await semantic.dispatch("inspect", {
    ingress,
    input: { node: { kind: "work-unit", workUnitId }, edgeLimit: 20 },
  });
  if (workInspection.kind !== "complete") throw new Error("work inspection did not complete");
  const changeIds = (workInspection.result as { node: { value: { authoredChangeIds: string[] } } })
    .node.value.authoredChangeIds;
  return Promise.all(
    changeIds.map(async (changeId) => {
      const inspected = await semantic.dispatch("inspect", {
        ingress,
        input: { node: { kind: "change", changeId }, edgeLimit: 20 },
      });
      if (inspected.kind !== "complete") throw new Error("change inspection did not complete");
      return inspected.result as {
        node: {
          value: {
            changeId: string;
            kind: string;
            effects: Array<Record<string, unknown>>;
          };
        };
        edges: Array<Record<string, unknown>>;
      };
    })
  );
}

describe("SemanticWorkspace snapshot import", () => {
  it("does not initialize a forked context again when a runtime attaches to it", async () => {
    const { semantic, store, initial } = await authorityFixture();
    const forked = semantic.forkContext(
      {
        sourceContextId: "context:test",
        targetContextId: "context:subagent",
        commandId: "command:fork-subagent",
      },
      { causalParent: null }
    );
    expect(forked).toMatchObject({ kind: "effects-pending" });
    acknowledgeMaterialization(semantic, forked);

    const attached = semantic.ensureContext(
      {
        contextId: "context:subagent",
        commandId: "command:attach-subagent-runtime",
      },
      { causalParent: null }
    );

    expect(attached).toEqual({
      kind: "complete",
      result: {
        ...store.context("context:subagent"),
      },
    });
    expect(store.pendingEffects("command:attach-subagent-runtime")).toEqual([]);
    expect(store.context("context:subagent")?.working.ref).toEqual(initial.working.ref);
  });

  it("stops honestly at the exact import boundary without a parallel external graph", async () => {
    const { semantic, restart, store, initial } = await authorityFixture();
    const sourceFile = textFile("src/index.ts", "hello");
    const ingress: SemanticDispatchRequest["ingress"] = {
      causalParent: {
        kind: "trajectory-invocation",
        logId: "trajectory:test",
        head: "main",
        invocationId: "invocation:test",
      },
    };
    const observationDispatch = await semantic.dispatch("importSnapshot", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:git-import",
        expectedWorkingHead: initial.working.ref,
        intentSummary: "Bring in the upstream project",
        source: {
          kind: "git",
          uri: "https://example.test/project.git",
          snapshotRevision: "commit:head",
        },
        repositories: [
          {
            repoPath: "projects/imported",
            files: [sourceFile.descriptor],
          },
        ],
      },
    });
    const importedDispatch = acknowledgeImportObservation(
      semantic,
      observationDispatch,
      new Map([[sourceFile.descriptor.contentHash, sourceFile.bytes]])
    );
    if (importedDispatch.kind !== "effects-pending") throw new Error("import did not complete");
    const imported = importedDispatch.result as {
      eventId: string;
      workUnitId: string;
      importedRepositoryIds: string[];
    };
    const state = { kind: "event" as const, eventId: imported.eventId };
    const root = store.stateRoot(state);
    const repositoryId = imported.importedRepositoryIds[0]!;
    const file = store.facts.fileAtPath(root, repositoryId, "src/index.ts")?.state;
    if (!file || file.presence !== "placed") throw new Error("imported file is absent");

    const restarted = restart();
    await expect(
      restarted.dispatch("resolveRepository", {
        ingress,
        input: { state, repoPath: "projects/imported" },
      })
    ).resolves.toEqual({
      kind: "complete",
      result: { state, repositoryId, repoPath: "projects/imported" },
    });
    await expect(
      restarted.dispatch("resolveRepository", {
        ingress,
        input: { state, repoPath: "projects/missing" },
      })
    ).resolves.toEqual({ kind: "complete", result: null });
    const workInspection = await restarted.dispatch("inspect", {
      ingress,
      input: {
        node: { kind: "work-unit", workUnitId: imported.workUnitId },
        edgeLimit: 20,
      },
    });
    if (workInspection.kind !== "complete") throw new Error("work inspection did not complete");
    const inspectedWork = (
      workInspection.result as {
        node: {
          value: {
            authoredChangeCount: number;
            authoredChangeIds: string[];
            externalSnapshot: Record<string, unknown>;
          };
        };
      }
    ).node.value;
    expect(inspectedWork).toMatchObject({
      authoredChangeCount: 2,
      externalSnapshot: {
        sourceKind: "git",
        sourceUri: "https://example.test/project.git",
        snapshotRevision: "commit:head",
        snapshotDigest: compactId("snapshot", [
          {
            repoPath: "projects/imported",
            files: [
              {
                ...sourceFile.descriptor,
                ...intrinsicDescriptor(sourceFile.bytes),
              },
            ],
          },
        ]),
        targetRepositoryIds: [repositoryId],
      },
    });
    const authoredChangeIds = inspectedWork.authoredChangeIds;
    const inspectedChanges = await Promise.all(
      authoredChangeIds.map(async (changeId) => {
        const inspected = await restarted.dispatch("inspect", {
          ingress,
          input: { node: { kind: "change", changeId }, edgeLimit: 20 },
        });
        if (inspected.kind !== "complete") throw new Error("change inspection did not complete");
        return inspected.result as {
          node: {
            value: {
              changeId: string;
              kind: string;
              effects: Array<Record<string, unknown>>;
            };
          };
          edges: Array<Record<string, unknown>>;
        };
      })
    );
    expect(inspectedChanges.map((entry) => entry.node.value.kind)).toEqual([
      "repository-create",
      "file-create",
    ]);
    const fileCreate = inspectedChanges[1]!;
    expect(fileCreate.node.value.effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "content",
          fileId: file.fileId,
          beforeContentHash: null,
          afterContentHash: sourceFile.descriptor.contentHash,
        }),
      ])
    );
    expect(fileCreate.edges).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "imports-snapshot" })])
    );

    const blame = await restarted.dispatch("blame", {
      ingress,
      input: {
        state,
        repositoryId,
        fileId: file.fileId,
        range: { start: 0, end: 5 },
        limit: 20,
      },
    });
    expect(blame).toMatchObject({
      kind: "complete",
      result: {
        coordinateKind: "utf16",
        spans: [
          {
            start: 0,
            end: 5,
            change: { kind: "change", changeId: fileCreate.node.value.changeId },
            workUnit: { kind: "work-unit", workUnitId: imported.workUnitId },
            stop: "import-boundary",
            path: [],
          },
        ],
      },
    });
  });

  it("rejects invalid host-observed intrinsic descriptors atomically", async () => {
    const source = textFile("src/index.ts", "a😀éz");
    const cases = [
      {
        name: "coordinate extent",
        receipt: { contentKind: "text", byteLength: source.bytes.length, coordinateExtent: 99 },
      },
      {
        name: "binary extent",
        receipt: { contentKind: "bytes", byteLength: source.bytes.length, coordinateExtent: 1 },
      },
    ] as const;

    for (const testCase of cases) {
      const { semantic, store, initial } = await authorityFixture();
      const commandId = `command:invalid-import-${testCase.name.replace(" ", "-")}`;
      const observation = await semantic.dispatch("importSnapshot", {
        ingress: {
          causalParent: {
            kind: "trajectory-invocation",
            logId: "trajectory:test",
            head: "main",
            invocationId: "invocation:test",
          },
        },
        input: {
          contextId: "context:test",
          commandId,
          expectedWorkingHead: initial.working.ref,
          source: {
            kind: "generated",
            uri: `fixture://invalid-${testCase.name.replace(" ", "-")}`,
            snapshotRevision: "fixture:invalid",
          },
          repositories: [{ repoPath: "projects/invalid", files: [source.descriptor] }],
        },
      });
      if (observation.kind !== "effects-pending") {
        throw new Error("invalid import did not request observation");
      }
      const effect = observation.effects[0]!;
      expect(effect.kind).toBe("observe-content");
      const requested = effect.payload["files"] as Array<{ contentHash: string }>;
      let failure: unknown;
      try {
        semantic.acknowledgeEffect({
          effectId: effect.effectId,
          payloadDigest: effect.payloadDigest,
          receipt: {
            files: requested.map((file) => ({
              contentHash: file.contentHash,
              ...testCase.receipt,
            })),
          },
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        code: "IntegrityFailure",
        detail: { internalDiagnostic: "EffectMismatch" },
      });
      expect(store.contextRequired("context:test").working.ref).toEqual(initial.working.ref);
      expect(store.facts.entries(store.stateRoot(initial.working.ref), "repository")).toEqual([]);
      expect(store.pendingEffects(commandId)).toEqual([
        expect.objectContaining({ effectId: effect.effectId, kind: "observe-content" }),
      ]);
    }
  });

  it("preserves unchanged provenance and gives changed external bytes a new boundary", async () => {
    const { semantic, store, initial } = await authorityFixture();
    const ingress: SemanticDispatchRequest["ingress"] = {
      causalParent: {
        kind: "trajectory-invocation",
        logId: "trajectory:test",
        head: "main",
        invocationId: "invocation:test",
      },
    };
    const unchanged = textFile("src/unchanged.ts", "same");
    const beforeChange = textFile("src/changed.ts", "old");
    const afterChange = textFile("src/changed.ts", "new");
    const v1 = await completeImport(
      semantic,
      {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:import-v1",
          expectedWorkingHead: initial.working.ref,
          source: {
            kind: "generated",
            uri: "fixture://repeated-import",
            snapshotRevision: "fixture:v1",
          },
          repositories: [
            {
              repoPath: "projects/repeated",
              files: [beforeChange.descriptor, unchanged.descriptor],
            },
          ],
        },
      },
      new Map([
        [unchanged.descriptor.contentHash, unchanged.bytes],
        [beforeChange.descriptor.contentHash, beforeChange.bytes],
      ])
    );
    const repositoryId = v1.importedRepositoryIds[0]!;
    const v1State = { kind: "event" as const, eventId: v1.eventId };
    const v1Root = store.stateRoot(v1State);
    const unchangedV1 = store.facts.fileAtPath(
      v1Root,
      repositoryId,
      unchanged.descriptor.path
    )?.state;
    const changedV1 = store.facts.fileAtPath(
      v1Root,
      repositoryId,
      beforeChange.descriptor.path
    )?.state;
    if (unchangedV1?.presence !== "placed" || changedV1?.presence !== "placed") {
      throw new Error("initial files are absent");
    }

    const v2 = await completeImport(
      semantic,
      {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:import-v2",
          expectedWorkingHead: v1State,
          source: {
            kind: "generated",
            uri: "fixture://repeated-import",
            snapshotRevision: "fixture:v2",
          },
          repositories: [
            {
              repositoryId,
              repoPath: "projects/repeated",
              files: [afterChange.descriptor, unchanged.descriptor],
            },
          ],
        },
      },
      new Map([
        [unchanged.descriptor.contentHash, unchanged.bytes],
        [afterChange.descriptor.contentHash, afterChange.bytes],
      ])
    );
    const v2State = { kind: "event" as const, eventId: v2.eventId };
    const v2Root = store.stateRoot(v2State);
    const unchangedV2 = store.facts.fileAtPath(
      v2Root,
      repositoryId,
      unchanged.descriptor.path
    )?.state;
    const changedV2 = store.facts.fileAtPath(
      v2Root,
      repositoryId,
      afterChange.descriptor.path
    )?.state;
    if (unchangedV2?.presence !== "placed" || changedV2?.presence !== "placed") {
      throw new Error("replacement files are absent");
    }
    expect(unchangedV2.fileStateId).toBe(unchangedV1.fileStateId);
    expect(changedV2.fileId).toBe(changedV1.fileId);
    expect(changedV2.fileStateId).not.toBe(changedV1.fileStateId);

    const v1Changes = await inspectAuthoredChanges(semantic, ingress, v1.workUnitId);
    const v2Changes = await inspectAuthoredChanges(semantic, ingress, v2.workUnitId);
    expect(v1Changes.map((change) => change.node.value.kind)).toEqual([
      "repository-create",
      "file-create",
      "file-create",
    ]);
    expect(v2Changes.map((change) => change.node.value.kind)).toEqual(["content-replace"]);
    const v1UnchangedCreateId = v1Changes[2]!.node.value.changeId;
    const v2ReplacementId = v2Changes[0]!.node.value.changeId;

    const unchangedBlame = await semantic.dispatch("blame", {
      ingress,
      input: {
        state: v2State,
        repositoryId,
        fileId: unchangedV2.fileId,
        range: { start: 0, end: unchangedV2.coordinateExtent },
        limit: 20,
      },
    });
    expect(unchangedBlame).toMatchObject({
      kind: "complete",
      result: {
        spans: [
          {
            change: { kind: "change", changeId: v1UnchangedCreateId },
            command: { kind: "command", commandId: "command:import-v1" },
            stop: "import-boundary",
            path: [],
          },
        ],
      },
    });
    const changedBlame = await semantic.dispatch("blame", {
      ingress,
      input: {
        state: v2State,
        repositoryId,
        fileId: changedV2.fileId,
        range: { start: 0, end: changedV2.coordinateExtent },
        limit: 20,
      },
    });
    expect(changedBlame).toMatchObject({
      kind: "complete",
      result: {
        spans: [
          {
            change: { kind: "change", changeId: v2ReplacementId },
            command: { kind: "command", commandId: "command:import-v2" },
            stop: "import-boundary",
            path: [],
          },
        ],
      },
    });

    const v3 = await completeImport(
      semantic,
      {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:import-v3-identical",
          expectedWorkingHead: v2State,
          source: {
            kind: "generated",
            uri: "fixture://repeated-import",
            snapshotRevision: "fixture:v3-identical",
          },
          repositories: [
            {
              repositoryId,
              repoPath: "projects/repeated",
              files: [afterChange.descriptor, unchanged.descriptor],
            },
          ],
        },
      },
      new Map([
        [unchanged.descriptor.contentHash, unchanged.bytes],
        [afterChange.descriptor.contentHash, afterChange.bytes],
      ])
    );
    const v3State = { kind: "event" as const, eventId: v3.eventId };
    expect(store.stateRoot(v3State)).toBe(v2Root);
    expect(
      (await inspectAuthoredChanges(semantic, ingress, v3.workUnitId)).map(
        (change) => change.node.value.kind
      )
    ).toEqual([]);
    const v3Work = await semantic.dispatch("inspect", {
      ingress,
      input: { node: { kind: "work-unit", workUnitId: v3.workUnitId }, edgeLimit: 20 },
    });
    expect(v3Work).toMatchObject({
      kind: "complete",
      result: {
        node: {
          value: {
            authoredChangeCount: 0,
            externalSnapshot: {
              snapshotRevision: "fixture:v3-identical",
              targetRepositoryIds: [repositoryId],
            },
          },
        },
        edges: expect.arrayContaining([
          {
            kind: "imports-repository",
            from: { kind: "work-unit", workUnitId: v3.workUnitId },
            to: {
              kind: "repository",
              state: expect.objectContaining({ kind: "application" }),
              repositoryId,
            },
          },
        ]),
      },
    });
    const changedAfterIdentical = await semantic.dispatch("blame", {
      ingress,
      input: {
        state: v3State,
        repositoryId,
        fileId: changedV2.fileId,
        range: { start: 0, end: changedV2.coordinateExtent },
        limit: 20,
      },
    });
    expect(changedAfterIdentical).toMatchObject({
      kind: "complete",
      result: {
        spans: [
          {
            change: { kind: "change", changeId: v2ReplacementId },
            command: { kind: "command", commandId: "command:import-v2" },
            stop: "import-boundary",
            path: [],
          },
        ],
      },
    });
  });

  it("represents a mode-only reimport as an explicit preserving step", async () => {
    const { semantic, store, initial } = await authorityFixture();
    const ingress: SemanticDispatchRequest["ingress"] = {
      causalParent: {
        kind: "trajectory-invocation",
        logId: "trajectory:test",
        head: "main",
        invocationId: "invocation:test",
      },
    };
    const before = textFile("src/script.ts", "echo", 0o644);
    const after = textFile("src/script.ts", "echo", 0o755);
    const bytes = new Map([[before.descriptor.contentHash, before.bytes]]);
    const v1 = await completeImport(
      semantic,
      {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:mode-v1",
          expectedWorkingHead: initial.working.ref,
          source: {
            kind: "generated",
            uri: "fixture://mode-import",
            snapshotRevision: "fixture:mode-v1",
          },
          repositories: [{ repoPath: "projects/mode", files: [before.descriptor] }],
        },
      },
      bytes
    );
    const repositoryId = v1.importedRepositoryIds[0]!;
    const v1State = { kind: "event" as const, eventId: v1.eventId };
    const v1File = store.facts.fileAtPath(
      store.stateRoot(v1State),
      repositoryId,
      before.descriptor.path
    )?.state;
    if (v1File?.presence !== "placed") throw new Error("initial mode file is absent");
    const v2 = await completeImport(
      semantic,
      {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:mode-v2",
          expectedWorkingHead: v1State,
          source: {
            kind: "generated",
            uri: "fixture://mode-import",
            snapshotRevision: "fixture:mode-v2",
          },
          repositories: [
            {
              repositoryId,
              repoPath: "projects/mode",
              files: [after.descriptor],
            },
          ],
        },
      },
      bytes
    );
    const v2State = { kind: "event" as const, eventId: v2.eventId };
    const v2File = store.facts.fileAtPath(
      store.stateRoot(v2State),
      repositoryId,
      after.descriptor.path
    )?.state;
    if (v2File?.presence !== "placed") throw new Error("updated mode file is absent");
    expect(v2File).toMatchObject({
      fileId: v1File.fileId,
      contentHash: v1File.contentHash,
      coordinateExtent: v1File.coordinateExtent,
      mode: 0o755,
    });
    expect(v2File.fileStateId).not.toBe(v1File.fileStateId);

    const v1Changes = await inspectAuthoredChanges(semantic, ingress, v1.workUnitId);
    const v2Changes = await inspectAuthoredChanges(semantic, ingress, v2.workUnitId);
    expect(v1Changes.map((change) => change.node.value.kind)).toEqual([
      "repository-create",
      "file-create",
    ]);
    expect(v2Changes.map((change) => change.node.value.kind)).toEqual(["file-mode"]);
    const v1CreateId = v1Changes[1]!.node.value.changeId;
    const modeChange = v2Changes[0]!;
    expect(modeChange.node.value.effects).toEqual([
      {
        kind: "mode",
        fileId: v1File.fileId,
        beforeMode: 0o644,
        afterMode: 0o755,
      },
    ]);
    const blame = await semantic.dispatch("blame", {
      ingress,
      input: {
        state: v2State,
        repositoryId,
        fileId: v2File.fileId,
        range: { start: 0, end: v2File.coordinateExtent },
        limit: 20,
      },
    });
    expect(blame).toMatchObject({
      kind: "complete",
      result: {
        spans: [
          {
            change: { kind: "change", changeId: v1CreateId },
            command: { kind: "command", commandId: "command:mode-v1" },
            stop: "import-boundary",
            path: [
              {
                kind: "preserves-content",
                from: {
                  kind: "applied-change",
                  appliedChangeId: expect.stringMatching(/^applied-change:/),
                },
                to: {
                  kind: "applied-change",
                  appliedChangeId: expect.stringMatching(/^applied-change:/),
                },
              },
            ],
          },
        ],
      },
    });
  });

  it("imports an empty repository as an exact snapshot", async () => {
    const { semantic, store, initial } = await authorityFixture();
    const request = {
      ingress: {
        causalParent: {
          kind: "trajectory-invocation",
          logId: "trajectory:test",
          head: "main",
          invocationId: "invocation:test",
        },
      },
      input: {
        contextId: "context:test",
        commandId: "command:import-empty",
        expectedWorkingHead: initial.working.ref,
        source: {
          kind: "filesystem",
          uri: "fixture://workspace",
          snapshotRevision: "fixture:empty",
        },
        repositories: [
          {
            repoPath: "projects/empty",
            files: [],
          },
        ],
      },
    } satisfies SemanticDispatchRequest;

    const observation = await semantic.dispatch("importSnapshot", request);
    const result = acknowledgeImportObservation(semantic, observation, new Map());

    expect(result.kind).toBe("effects-pending");
    if (result.kind !== "effects-pending") throw new Error("snapshot import did not complete");
    const imported = result.result as { eventId: string; importedRepositoryIds: string[] };
    const repositoryId = imported.importedRepositoryIds[0]!;
    const root = store.stateRoot({ kind: "event", eventId: imported.eventId });
    const repository = store.facts.member(root, repositoryId);
    expect(repository).toMatchObject({
      repositoryId,
      presence: "present",
      repoPath: "projects/empty",
    });
    if (repository?.presence !== "present") throw new Error("empty repository is absent");
    expect(store.facts.manifest(repository.fileManifestId)).toMatchObject({
      repositoryId,
      entryCount: 0,
    });
    expect(store.facts.pageManifest(repository.fileManifestId, { limit: 1 }).values).toEqual([]);
  });

  it("admits a workspace with more than the former repository-count bound", async () => {
    const { semantic, initial } = await authorityFixture();
    const ingress: SemanticDispatchRequest["ingress"] = {
      causalParent: {
        kind: "trajectory-invocation",
        logId: "trajectory:test",
        head: "main",
        invocationId: "invocation:test",
      },
    };
    const repositoryCount = 104;
    const imported = await completeImport(
      semantic,
      {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:many-repositories",
          expectedWorkingHead: initial.working.ref,
          source: {
            kind: "filesystem",
            uri: "fixture://many-repositories",
            snapshotRevision: "fixture:many-v1",
          },
          repositories: Array.from({ length: repositoryCount }, (_, index) => ({
            repoPath: `projects/many-${String(index).padStart(3, "0")}`,
            files: [],
          })),
        },
      },
      new Map()
    );

    expect(imported.importedRepositoryIds).toHaveLength(repositoryCount);
    const edited = await semantic.dispatch("edit", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:edit-one-of-many",
        expectedWorkingHead: { kind: "event", eventId: imported.eventId },
        changes: [
          {
            kind: "file-create",
            repositoryId: imported.importedRepositoryIds[57]!,
            path: "only-this-repository.txt",
            content: { kind: "text", text: "local\n" },
          },
        ],
      },
    });
    if (edited.kind !== "effects-pending") throw new Error("edit did not materialize");
    expect(edited.effects[0]?.payload).toMatchObject({
      mode: "patch",
      repositories: [
        {
          repositoryId: imported.importedRepositoryIds[57],
          presence: "present",
          source: { kind: "delta" },
        },
      ],
    });
  });

  it("admits paths through the shared predicate before queuing observation", async () => {
    const { semantic, store, initial } = await authorityFixture();
    const file = textFile("dist/index.js", "built\n");
    const requestFor = (commandId: string, filePath: string): SemanticDispatchRequest => ({
      ingress: { causalParent: null },
      input: {
        contextId: "context:test",
        commandId,
        expectedWorkingHead: initial.working.ref,
        source: {
          kind: "generated",
          uri: "fixture://path-admission",
          snapshotRevision: "fixture:path-admission-v1",
        },
        repositories: [
          {
            repoPath: "projects/path-admission",
            files: [{ ...file.descriptor, path: filePath }],
          },
        ],
      },
    });

    await expect(
      semantic.dispatch("importSnapshot", requestFor("command:reserved-path", ".git/config"))
    ).rejects.toThrow(/admissible canonical repository-relative file path/u);
    expect(store.pendingEffects()).toEqual([]);

    const admitted = await semantic.dispatch(
      "importSnapshot",
      requestFor("command:ordinary-output", "dist/index.js")
    );
    expect(admitted).toMatchObject({
      kind: "effects-pending",
      effects: [{ kind: "observe-content" }],
    });
  });

  it("does not hide repository moves or resurrection inside an import operation", async () => {
    const { semantic, initial } = await authorityFixture();
    const ingress: SemanticDispatchRequest["ingress"] = {
      causalParent: {
        kind: "trajectory-invocation",
        logId: "trajectory:test",
        head: "main",
        invocationId: "invocation:test",
      },
    };
    const observationDispatch = await semantic.dispatch("importSnapshot", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:import-stable-repository",
        expectedWorkingHead: initial.working.ref,
        source: {
          kind: "generated",
          uri: "fixture://stable-repository",
          snapshotRevision: "fixture:stable-v1",
        },
        repositories: [{ repoPath: "projects/stable", files: [] }],
      },
    });
    const importedDispatch = acknowledgeImportObservation(semantic, observationDispatch, new Map());
    if (importedDispatch.kind !== "effects-pending") throw new Error("import did not complete");
    const imported = importedDispatch.result as {
      eventId: string;
      importedRepositoryIds: string[];
    };
    const repositoryId = imported.importedRepositoryIds[0]!;
    const state = { kind: "event" as const, eventId: imported.eventId };
    acknowledgeMaterialization(semantic, importedDispatch);

    await expect(
      semantic.dispatch("importSnapshot", {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:import-hidden-move",
          expectedWorkingHead: state,
          source: {
            kind: "generated",
            uri: "fixture://stable-repository",
            snapshotRevision: "fixture:stable-v2",
          },
          repositories: [{ repositoryId, repoPath: "projects/moved", files: [] }],
        },
      })
    ).rejects.toMatchObject({ code: "InvalidReference" });

    await expect(
      semantic.dispatch("importSnapshot", {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:import-unknown-repository",
          expectedWorkingHead: state,
          source: {
            kind: "generated",
            uri: "fixture://stable-repository",
            snapshotRevision: "fixture:stable-v2",
          },
          repositories: [
            { repositoryId: "repository:unknown", repoPath: "projects/unknown", files: [] },
          ],
        },
      })
    ).rejects.toMatchObject({ code: "InvalidReference" });
  });

  it("integrates an imported snapshot as ordinary local incremental changes", async () => {
    const { semantic, store, initial } = await authorityFixture();
    const ingress: SemanticDispatchRequest["ingress"] = {
      causalParent: {
        kind: "trajectory-invocation",
        logId: "trajectory:test",
        head: "main",
        invocationId: "invocation:test",
      },
    };
    const sourceFile = textFile("src/index.ts", "hello");
    const source = await completeImport(
      semantic,
      {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:integration-source-import",
          expectedWorkingHead: initial.working.ref,
          source: {
            kind: "git",
            uri: "https://example.test/incremental.git",
            snapshotRevision: "commit:incremental",
          },
          repositories: [{ repoPath: "projects/incremental", files: [sourceFile.descriptor] }],
        },
      },
      new Map([[sourceFile.descriptor.contentHash, sourceFile.bytes]])
    );
    const target = store.initializeWorkspace(
      "context:integration-target",
      "command:integration-target-genesis"
    );
    const compare = async (
      targetState:
        | { kind: "event"; eventId: string }
        | {
            kind: "application";
            applicationId: string;
          }
    ) => {
      const dispatch = await semantic.dispatch("compare", {
        ingress,
        input: {
          target: targetState,
          sourceEventId: source.eventId,
          view: "changes",
          limit: 20,
        },
      });
      if (dispatch.kind !== "complete") throw new Error("comparison did not complete");
      return (
        dispatch.result as {
          changes: Array<{
            changeId: string;
            kind: string;
            disposition: { status: string; applicability?: string };
          }>;
        }
      ).changes;
    };

    const initialComparison = await compare(target.working.ref);
    const repositoryCreate = initialComparison.find(
      (change) => change.kind === "repository-create"
    );
    const blockedFileCreate = initialComparison.find((change) => change.kind === "file-create");
    expect(repositoryCreate?.disposition).toMatchObject({
      status: "actionable",
      applicability: "applicable",
    });
    expect(blockedFileCreate?.disposition).toMatchObject({
      status: "actionable",
      applicability: "blocked",
    });
    if (!repositoryCreate) throw new Error("repository creation is absent");

    const repositoryStep = await semantic.dispatch("integrate", {
      ingress,
      input: {
        contextId: "context:integration-target",
        commandId: "command:integrate-repository",
        expectedWorkingHead: target.working.ref,
        sourceEventId: source.eventId,
        decision: { kind: "adopted", sourceChangeIds: [repositoryCreate.changeId] },
      },
    });
    if (repositoryStep.kind !== "effects-pending") {
      throw new Error("repository integration did not materialize");
    }
    acknowledgeMaterialization(semantic, repositoryStep);
    let repositoryHead = (
      repositoryStep.result as {
        workingHead: { kind: "application"; applicationId: string };
      }
    ).workingHead;

    const discardedRepository = await semantic.dispatch("discard", {
      ingress,
      input: {
        contextId: "context:integration-target",
        commandId: "command:discard-integrated-repository",
        expectedWorkingHead: repositoryHead,
      },
    });
    if (discardedRepository.kind !== "effects-pending") {
      throw new Error("repository discard did not materialize");
    }
    expect(discardedRepository.effects[0]?.payload).toMatchObject({
      mode: "patch",
      repositories: [
        {
          repositoryId: source.importedRepositoryIds[0],
          repoPath: "projects/incremental",
          presence: "deleted",
        },
      ],
    });
    acknowledgeMaterialization(semantic, discardedRepository);

    const repeatedRepositoryStep = await semantic.dispatch("integrate", {
      ingress,
      input: {
        contextId: "context:integration-target",
        commandId: "command:integrate-repository-again",
        expectedWorkingHead: target.working.ref,
        sourceEventId: source.eventId,
        decision: { kind: "adopted", sourceChangeIds: [repositoryCreate.changeId] },
      },
    });
    if (repeatedRepositoryStep.kind !== "effects-pending") {
      throw new Error("repeated repository integration did not materialize");
    }
    acknowledgeMaterialization(semantic, repeatedRepositoryStep);
    repositoryHead = (
      repeatedRepositoryStep.result as {
        workingHead: { kind: "application"; applicationId: string };
      }
    ).workingHead;

    const afterRepository = await compare(repositoryHead);
    const fileCreate = afterRepository.find((change) => change.kind === "file-create");
    expect(fileCreate?.disposition).toMatchObject({
      status: "actionable",
      applicability: "applicable",
    });
    if (!fileCreate) throw new Error("file creation is absent");

    const fileStep = await semantic.dispatch("integrate", {
      ingress,
      input: {
        contextId: "context:integration-target",
        commandId: "command:integrate-file",
        expectedWorkingHead: repositoryHead,
        sourceEventId: source.eventId,
        decision: { kind: "adopted", sourceChangeIds: [fileCreate.changeId] },
      },
    });
    if (fileStep.kind !== "effects-pending")
      throw new Error("file integration did not materialize");
    acknowledgeMaterialization(semantic, fileStep);
    const fileHead = (
      fileStep.result as {
        workingHead: { kind: "application"; applicationId: string };
      }
    ).workingHead;
    expect(
      (await compare(fileHead)).every((change) => change.disposition.status !== "actionable")
    ).toBe(true);

    const committed = await semantic.dispatch("commit", {
      ingress,
      input: {
        contextId: "context:integration-target",
        commandId: "command:commit-incremental-import",
        expectedWorkingHead: fileHead,
        integratesEventId: source.eventId,
        message: "Integrate imported project incrementally",
      },
    });
    if (committed.kind !== "effects-pending")
      throw new Error("integration commit did not complete");
    acknowledgeMaterialization(semantic, committed);
    const committedEventId = (committed.result as { event: { eventId: string } }).event.eventId;
    expect(store.event(committedEventId)?.parentEventIds).toEqual([
      target.committed.ref.eventId,
      source.eventId,
    ]);
  });

  it("projects a shipped-workspace-sized import atomically and one later mutation by changed paths", async () => {
    const { semantic, sql, store, initial } = await authorityFixture();
    const repeatedContent = textFile("unused", "a");
    const ingress: SemanticDispatchRequest["ingress"] = {
      causalParent: {
        kind: "trajectory-invocation",
        logId: "trajectory:test",
        head: "main",
        invocationId: "invocation:test",
      },
    };
    const files = Array.from({ length: 1_658 }, (_, index) => ({
      path: `src/file-${String(index).padStart(4, "0")}.ts`,
      contentHash: repeatedContent.descriptor.contentHash,
      mode: 0o644,
    }));
    const observationDispatch = await semantic.dispatch("importSnapshot", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:large-import",
        expectedWorkingHead: initial.working.ref,
        source: {
          kind: "filesystem",
          uri: "fixture://large-workspace",
          snapshotRevision: "fixture:large-v1",
        },
        repositories: [
          {
            repoPath: "packages/large",
            files,
          },
        ],
      },
    });
    if (observationDispatch.kind !== "effects-pending") {
      throw new Error("large import did not request observation");
    }
    expect(observationDispatch.effects[0]?.kind).toBe("observe-content");
    expect(observationDispatch.effects[0]?.payload["files"]).toHaveLength(1);
    const importedDispatch = acknowledgeImportObservation(
      semantic,
      observationDispatch,
      new Map([[repeatedContent.descriptor.contentHash, repeatedContent.bytes]])
    );
    if (importedDispatch.kind !== "effects-pending") {
      throw new Error("large import did not queue materialization");
    }
    expect(
      sql
        .exec(
          `SELECT payload_json, receipt_json, receipt_digest, status
             FROM gad_effect_intents WHERE effect_id = ?`,
          observationDispatch.effects[0]!.effectId
        )
        .toArray()[0]
    ).toMatchObject({
      payload_json: "{}",
      receipt_json: null,
      receipt_digest: expect.any(String),
      status: "applied",
    });
    const imported = importedDispatch.result as {
      eventId: string;
      workUnitId: string;
      importedRepositoryIds: string[];
    };
    const repositoryId = imported.importedRepositoryIds[0]!;
    const inspectedWork = await semantic.dispatch("inspect", {
      ingress,
      input: {
        node: { kind: "work-unit", workUnitId: imported.workUnitId },
        edgeLimit: 20,
      },
    });
    expect(inspectedWork).toMatchObject({
      kind: "complete",
      result: {
        node: {
          kind: "work-unit",
          value: {
            authoredChangeCount: 1_659,
            authoredChangeIds: expect.any(Array),
          },
        },
      },
    });
    if (inspectedWork.kind !== "complete") throw new Error("work inspection did not complete");
    expect(
      (inspectedWork.result as { node: { value: { authoredChangeIds: string[] } } }).node.value
        .authoredChangeIds
    ).toHaveLength(200);
    const authoredNeighbors = await semantic.dispatch("neighbors", {
      ingress,
      input: {
        root: { kind: "work-unit", workUnitId: imported.workUnitId },
        limit: 20,
      },
    });
    expect(authoredNeighbors).toMatchObject({
      kind: "complete",
      result: {
        edges: expect.arrayContaining([expect.objectContaining({ kind: "authored-change" })]),
        nextCursor: expect.any(String),
      },
    });
    const importEffect = importedDispatch.effects[0]!;
    const importCommand = importEffect.payload as {
      effectId: string;
      contextId: string;
      targetState: { kind: "event"; eventId: string };
      payloadDigest: string;
      repositories: Array<{ repoPath: string; source: { kind: string } }>;
    };
    expect(importCommand.repositories[0]?.source.kind).toBe("snapshot");
    const contentRoot = `state:${"b".repeat(64)}`;
    semantic.acknowledgeEffect({
      effectId: importEffect.effectId,
      payloadDigest: importEffect.payloadDigest,
      receipt: {
        materializationId: importEffect.effectId,
        contextId: importCommand.contextId,
        targetState: importCommand.targetState,
        repositories: [{ repositoryId, repoPath: "packages/large", contentRoot }],
        payloadDigest: importCommand.payloadDigest,
      },
    });

    const pushDispatch = await semantic.dispatch("push", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:large-push",
        expectedCommittedEventId: imported.eventId,
        expectedMainEventId: initial.committed.ref.eventId,
      },
    });
    if (pushDispatch.kind !== "effects-pending") throw new Error("push did not queue an effect");
    expect(
      (
        pushDispatch.effects[0]!.payload["repositories"] as Array<{
          source: { kind: string };
        }>
      )[0]?.source.kind
    ).toBe("content-root");
    expect(() =>
      semantic.acknowledgeEffect({
        effectId: pushDispatch.effects[0]!.effectId,
        payloadDigest: pushDispatch.effects[0]!.payloadDigest,
        receipt: {
          applied: true,
          appliedAt: timestamp,
          approvalId: null,
          buildReceiptId: null,
        },
      })
    ).toThrowError(
      expect.objectContaining({
        code: "IntegrityFailure",
        detail: expect.objectContaining({ internalDiagnostic: "EffectMismatch" }),
      })
    );
    semantic.acknowledgeEffect({
      effectId: pushDispatch.effects[0]!.effectId,
      payloadDigest: pushDispatch.effects[0]!.payloadDigest,
      receipt: {
        applied: true,
        appliedAt: timestamp,
      },
    });

    const ensured = semantic.ensureContext(
      { contextId: "context:fresh", commandId: "command:ensure-fresh" },
      ingress
    );
    if (ensured.kind !== "effects-pending") throw new Error("ensure did not queue an effect");
    const ensureEffect = ensured.effects[0]!;
    const ensurePayload = ensureEffect.payload as {
      contextId: string;
      targetState: { kind: "event"; eventId: string };
      payloadDigest: string;
      repositories: Array<{ source: { kind: string; contentRoot?: string } }>;
    };
    expect(ensurePayload.repositories[0]?.source).toEqual({
      kind: "content-root",
      contentRoot,
    });
    expect(JSON.stringify(ensurePayload).length).toBeLessThan(2_000);
    semantic.acknowledgeEffect({
      effectId: ensureEffect.effectId,
      payloadDigest: ensureEffect.payloadDigest,
      receipt: {
        materializationId: ensureEffect.effectId,
        contextId: ensurePayload.contextId,
        targetState: ensurePayload.targetState,
        repositories: [{ repositoryId, repoPath: "packages/large", contentRoot }],
        payloadDigest: ensurePayload.payloadDigest,
      },
    });
    const replayedEnsure = semantic.ensureContext(
      { contextId: "context:fresh", commandId: "command:ensure-fresh" },
      ingress
    );
    expect(replayedEnsure).toMatchObject({ kind: "complete" });
    expect(
      semantic.contextMaterializationCommand("context:fresh", ensurePayload.targetState)
    ).toMatchObject({
      mode: "replace",
      previousState: ensurePayload.targetState,
      targetState: ensurePayload.targetState,
      repositories: ensurePayload.repositories,
    });

    const importedRoot = store.stateRoot({ kind: "event", eventId: imported.eventId });
    const repository = store.facts.member(importedRoot, repositoryId);
    if (repository?.presence !== "present") throw new Error("large repository is absent");
    const firstFileId = store.facts.pageManifest(repository.fileManifestId, { limit: 1 }).values[0]!
      .fileId;
    const moved = await semantic.dispatch("move", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:move-one",
        expectedWorkingHead: { kind: "event", eventId: imported.eventId },
        moves: [
          {
            kind: "file",
            repositoryId,
            fileId: firstFileId,
            destinationRepositoryId: repositoryId,
            destinationPath: "src/moved.ts",
          },
        ],
      },
    });
    if (moved.kind !== "effects-pending") throw new Error("move did not queue an effect");
    const movedPayload = moved.effects[0]!.payload as {
      repositories: Array<{
        source: { kind: string; changes?: unknown[] };
      }>;
    };
    expect(movedPayload.repositories[0]?.source.kind).toBe("delta");
    expect(movedPayload.repositories[0]?.source.changes).toHaveLength(2);
    expect(JSON.stringify(movedPayload).length).toBeLessThan(4_000);
    acknowledgeMaterialization(semantic, moved, `state:${"c".repeat(64)}`);

    const movedHead = (
      moved.result as { workingHead: { kind: "application"; applicationId: string } }
    ).workingHead;
    const expanded = await semantic.dispatch("edit", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:add-over-import-bound",
        expectedWorkingHead: movedHead,
        changes: [
          {
            kind: "file-create",
            repositoryId,
            path: "src/extra.ts",
            content: { kind: "text", text: "extra\n" },
          },
        ],
      },
    });
    if (expanded.kind !== "effects-pending") throw new Error("edit did not queue an effect");
    acknowledgeMaterialization(semantic, expanded);
    const expandedHead = (
      expanded.result as { workingHead: { kind: "application"; applicationId: string } }
    ).workingHead;
    const committed = await semantic.dispatch("commit", {
      ingress,
      input: {
        contextId: "context:test",
        commandId: "command:commit-over-import-bound",
        expectedWorkingHead: expandedHead,
      },
    });
    if (committed.kind !== "effects-pending") throw new Error("commit did not queue an effect");
    acknowledgeMaterialization(semantic, committed);
    const expandedEvent = (committed.result as { event: { eventId: string } }).event.eventId;

    await expect(
      semantic.dispatch("importSnapshot", {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:replace-over-import-bound",
          expectedWorkingHead: { kind: "event", eventId: expandedEvent },
          source: {
            kind: "filesystem",
            uri: "fixture://large-workspace",
            snapshotRevision: "fixture:large-v2",
          },
          repositories: [
            {
              repositoryId,
              repoPath: "packages/large",
              files: [],
            },
          ],
        },
      })
    ).rejects.toMatchObject({
      code: "ScopeTooLarge",
      detail: {
        scope: "import descriptor and replacement basis",
        maximum: VCS_IMPORT_MAX_DESCRIPTOR_BYTES,
      },
    });
    expect(store.pendingEffects()).toEqual([]);
  }, 30_000);

  it("walks imports larger than SQLite's compound-select ceiling through bounded pages", async () => {
    const { semantic, initial } = await authorityFixture();
    const ingress: SemanticDispatchRequest["ingress"] = {
      causalParent: {
        kind: "trajectory-invocation",
        logId: "trajectory:test",
        head: "main",
        invocationId: "invocation:test",
      },
    };
    const repositoryCount = 520;
    const imported = await completeImport(
      semantic,
      {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:wide-import",
          expectedWorkingHead: initial.working.ref,
          intentSummary: "Import a workspace whose provenance must remain walkable",
          source: {
            kind: "generated",
            uri: "fixture://wide-workspace",
            snapshotRevision: "fixture:wide-v1",
          },
          repositories: Array.from({ length: repositoryCount }, (_, index) => ({
            repoPath: `projects/wide-${index.toString().padStart(4, "0")}`,
            files: [],
          })),
        },
      },
      new Map()
    );

    const work = { kind: "work-unit" as const, workUnitId: imported.workUnitId };
    const inspected = await semantic.dispatch("inspect", {
      ingress,
      input: { node: work, edgeLimit: 500 },
    });
    if (inspected.kind !== "complete") throw new Error("work inspection did not complete");
    const inspection = vcsInspectResultSchema.parse(inspected.result);
    expect(inspection).toMatchObject({
      node: {
        kind: "work-unit",
        value: {
          authoredChangeCount: repositoryCount,
        },
      },
      hasMoreEdges: true,
    });
    expect(inspection.edges).toHaveLength(500);
    if (inspection.node.kind !== "work-unit" || !inspection.node.value.externalSnapshot) {
      throw new Error("wide import inspection lost its external snapshot");
    }
    expect(inspection.node.value.externalSnapshot.targetRepositoryIds).toHaveLength(
      repositoryCount
    );

    const collectEdges = async (root: VcsSemanticNodeRef): Promise<VcsProvenanceEdge[]> => {
      const edges: VcsProvenanceEdge[] = [];
      let cursor: string | undefined;
      do {
        const dispatch = await semantic.dispatch("neighbors", {
          ingress,
          input: { root, limit: 137, ...(cursor ? { cursor } : {}) },
        });
        if (dispatch.kind !== "complete") throw new Error("neighbor walk did not complete");
        const page = vcsNeighborsResultSchema.parse(dispatch.result);
        edges.push(...page.edges);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return edges;
    };

    const workEdges = await collectEdges(work);
    expect(workEdges.filter((edge) => edge.kind === "authored-change")).toHaveLength(
      repositoryCount
    );
    expect(workEdges.filter((edge) => edge.kind === "imports-repository")).toHaveLength(
      repositoryCount
    );
    expect(workEdges).toHaveLength(repositoryCount * 2 + 2);

    const applicationEdge = workEdges.find((edge) => edge.kind === "applies-work");
    if (!applicationEdge || applicationEdge.from.kind !== "application") {
      throw new Error("wide import has no application edge");
    }
    const stateEdges = await collectEdges(applicationEdge.from);
    const repositoryIds = stateEdges.flatMap((edge) =>
      edge.kind === "contains-repository" && edge.to.kind === "repository"
        ? [edge.to.repositoryId]
        : []
    );
    expect(repositoryIds).toHaveLength(repositoryCount);
    expect(new Set(repositoryIds).size).toBe(repositoryCount);
  }, 30_000);

  it("inspects and exactly pages every change adjacency phase within the deployment SQL limit", async () => {
    const { initial, restart, sql, store } = await authorityFixture();
    const ingress: SemanticDispatchRequest["ingress"] = {
      causalParent: {
        kind: "trajectory-invocation",
        logId: "trajectory:test",
        head: "main",
        invocationId: "invocation:test",
      },
    };
    const source = textFile("src/source.ts", "export const source = true;\n");
    const imported = await completeImport(
      restart(),
      {
        ingress,
        input: {
          contextId: "context:test",
          commandId: "command:change-adjacency-import",
          expectedWorkingHead: initial.working.ref,
          source: {
            kind: "generated",
            uri: "fixture://change-adjacency",
            snapshotRevision: "fixture:v1",
          },
          repositories: [
            {
              repoPath: "packages/source",
              files: [source.descriptor],
            },
          ],
        },
      },
      new Map([[source.descriptor.contentHash, source.bytes]])
    );
    const change = sql
      .exec(
        `SELECT * FROM gad_changes
          WHERE work_unit_id = ? AND kind = 'file-create'`,
        imported.workUnitId
      )
      .toArray()[0] as Record<string, unknown> | undefined;
    if (!change) throw new Error("fixture import did not author a file change");
    const changeId = String(change["change_id"]);

    const relatedChangeIds = [
      "change:counteracted-a",
      "change:counteracted-b",
      "change:counteracting-a",
      "change:counteracting-b",
    ];
    relatedChangeIds.forEach((relatedChangeId, index) => {
      sql.exec(
        `INSERT INTO gad_changes
         (change_id, work_unit_id, operation, ordinal, kind, base_json, result_json,
          payload_json, effect_digest)
         SELECT ?, work_unit_id, ?, 0, kind, base_json, result_json,
                payload_json, effect_digest
           FROM gad_changes WHERE change_id = ?`,
        relatedChangeId,
        100 + index,
        changeId
      );
    });
    sql.exec(
      `INSERT INTO gad_change_counteractions
       (change_id, ordinal, counteracted_change_id)
       VALUES (?, 0, ?), (?, 1, ?), (?, 0, ?), (?, 0, ?)`,
      changeId,
      relatedChangeIds[0],
      changeId,
      relatedChangeIds[1],
      relatedChangeIds[2],
      changeId,
      relatedChangeIds[3],
      changeId
    );
    sql.exec(
      `INSERT INTO gad_integration_decisions
       (decision_id, kind, target_state_kind, target_state_id, source_event_id,
        work_unit_id, rationale, evidence_predicates_json, created_at)
       VALUES ('decision:change-adjacency', 'adopted', 'event', ?, ?, ?, NULL, NULL, ?)`,
      imported.eventId,
      imported.eventId,
      imported.workUnitId,
      timestamp
    );
    sql.exec(
      `INSERT INTO gad_decision_source_changes (decision_id, change_id)
       VALUES ('decision:change-adjacency', ?)`,
      changeId
    );
    // Workerd rejects compound SELECTs with more than five terms. Keep this
    // boundary in the regression so a future adjacency UNION cannot pass only
    // because the host SQLite build has a higher compile-time limit.
    const deploymentSql = new Proxy(sql, {
      get(target, property, receiver) {
        if (property !== "exec") return Reflect.get(target, property, receiver);
        return (statement: string, ...bindings: unknown[]) => {
          const terms = 1 + (statement.match(/\bUNION(?:\s+ALL)?\b/giu)?.length ?? 0);
          if (terms > 5) throw new Error("too many terms in compound SELECT");
          return target.exec(statement, ...bindings);
        };
      },
    });
    const semantic = restart(deploymentSql);
    const node = { kind: "change" as const, changeId };
    const inspected = await semantic.dispatch("inspect", {
      ingress,
      input: { node, edgeLimit: 20 },
    });
    if (inspected.kind !== "complete") throw new Error("change inspection did not complete");
    expect(vcsInspectResultSchema.parse(inspected.result)).toMatchObject({
      root: node,
      hasMoreEdges: false,
      edges: expect.any(Array),
    });

    const collect = async (limit: number): Promise<VcsProvenanceEdge[]> => {
      const edges: VcsProvenanceEdge[] = [];
      let cursor: string | undefined;
      do {
        const dispatched = await semantic.dispatch("neighbors", {
          ingress,
          input: { root: node, limit, ...(cursor ? { cursor } : {}) },
        });
        if (dispatched.kind !== "complete") throw new Error("change walk did not complete");
        const page = vcsNeighborsResultSchema.parse(dispatched.result);
        edges.push(...page.edges);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return edges;
    };
    const completePage = await collect(20);
    const singleEdgePages = await collect(1);
    expect(singleEdgePages).toEqual(completePage);
    expect(singleEdgePages.map((edge) => edge.kind)).toEqual([
      "authored-change",
      "realizes-change",
      "decides-change",
      "incorporates-change",
      "counteracts",
      "counteracts",
      "counteracts",
      "counteracts",
    ]);
    expect(new Set(singleEdgePages.map((edge) => JSON.stringify(edge))).size).toBe(
      singleEdgePages.length
    );
  });
});
