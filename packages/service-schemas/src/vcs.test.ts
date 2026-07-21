import { describe, expect, it } from "vitest";

import {
  VCS_IMPORT_MAX_DESCRIPTOR_BYTES,
  assertVcsSemanticReferenceContract,
  createVcsError,
  createVcsMethodError,
  extractVcsSemanticReferences,
  parseVcsSemanticRequest,
  vcsBlameInputSchema,
  vcsBlameResultSchema,
  vcsAppliedChangeSchema,
  vcsChangeKindSchema,
  vcsChangeSchema,
  vcsCommitInputSchema,
  vcsCompareInputSchema,
  vcsCompareResultSchema,
  vcsCopyInputSchema,
  vcsDiscardInputSchema,
  vcsEditInputSchema,
  vcsErrorSchema,
  vcsHistoryInputSchema,
  vcsHistoryResultSchema,
  vcsImportSnapshotInputSchema,
  vcsInspectInputSchema,
  vcsInspectResultSchema,
  vcsInspectedNodeSchema,
  vcsIntegrateInputSchema,
  vcsListFilesInputSchema,
  vcsMethods,
  vcsMoveInputSchema,
  vcsNeighborsInputSchema,
  vcsOperationContextId,
  vcsOperationRegistry,
  vcsProvenanceRootSchema,
  vcsProvenanceEdgeSchema,
  vcsProvenanceRelationRegistry,
  vcsPushInputSchema,
  vcsReadFileInputSchema,
  vcsResolveRepositoryInputSchema,
  vcsRevertInputSchema,
  vcsSemanticReferenceInventory,
  vcsSemanticReferenceKinds,
  vcsStateNodeRefSchema,
  vcsStatusResultSchema,
  vcsWorkApplicationSchema,
  vcsWorkingMutationResultSchema,
  vcsWorkUnitSchema,
} from "./vcs.js";

const event = { kind: "event", eventId: "event:1" } as const;
const application = { kind: "application", applicationId: "application:1" } as const;
const commonMutation = {
  commandId: "command:1",
  contextId: "context:1",
  expectedWorkingHead: event,
};

const workingMutationResult = {
  commandId: "command:1",
  contextId: "context:1",
  workUnitId: "work:1",
  applicationId: "application:1",
  changeCount: 1,
  changeIds: ["change:1"],
  incorporatedChangeCount: 0,
  incorporatedChangeIds: [],
  decisionIds: [],
  workingHead: application,
};

describe("working mutation results", () => {
  it("accepts the decision accounting returned by the semantic workspace", () => {
    expect(vcsWorkingMutationResultSchema.parse(workingMutationResult)).toEqual(
      workingMutationResult
    );
  });
});

const expectedMethods = [
  "blame",
  "commit",
  "compare",
  "copy",
  "discard",
  "edit",
  "history",
  "importSnapshot",
  "inspect",
  "integrate",
  "listFiles",
  "move",
  "neighbors",
  "push",
  "readFile",
  "resolveRepository",
  "revert",
  "status",
] as const;

describe("minimal semantic VCS surface", () => {
  it("has exactly the eighteen plan methods", () => {
    expect(Object.keys(vcsMethods).sort()).toEqual([...expectedMethods].sort());

    for (const removed of [
      "resolveRevision",
      "compareContent",
      "moveFiles",
      "copyFiles",
      "planCommit",
      "previewBuild",
      "inspectFrontier",
      "inspectAtom",
      "inspectOutcome",
      "inspectRealization",
      "inspectCertificate",
      "inspectProtectedAncestry",
      "walkProvenance",
      "provenanceForFile",
      "provenanceForSession",
      "publicationLog",
      "recall",
    ]) {
      expect(vcsMethods).not.toHaveProperty(removed);
    }
  });

  it("documents and validates every method from one registry", () => {
    for (const [name, method] of Object.entries(vcsMethods)) {
      expect(method.description, name).toBeTruthy();
      expect(method.args, name).toBeTruthy();
      expect(method.returns, name).toBeTruthy();
      expect(method.access, name).toBeTruthy();
      expect(method.operationClass, name).toMatch(/^(read|context-write|workspace-write)$/);
      expect(method.errors?.length, name).toBeGreaterThan(0);
      expect(method.references, name).toBeDefined();
    }
    expect(Object.keys(vcsOperationRegistry).sort()).toEqual(Object.keys(vcsMethods).sort());
    expect(Object.keys(vcsSemanticReferenceInventory).sort()).toEqual(
      Object.keys(vcsMethods).sort()
    );
  });

  it("names state only by committed event or local application", () => {
    expect(vcsStateNodeRefSchema.parse(event)).toEqual(event);
    expect(vcsStateNodeRefSchema.parse(application)).toEqual(application);
    for (const legacy of [
      { kind: "frontier", frontierId: "frontier:1" },
      { kind: "source-basis", sourceBasisId: "basis:1" },
      { kind: "workspace-state", stateHash: "hash:1" },
    ]) {
      expect(vcsStateNodeRefSchema.safeParse(legacy).success).toBe(false);
    }
  });

  it("reports context state without frontiers or repository vectors", () => {
    const status = {
      contextId: "context:1",
      committed: event,
      workingHead: application,
      clean: false,
      mainEventId: "event:main",
      mainRelation: "ahead",
      workingCounts: { applications: 1, workUnits: 1, changes: 2 },
    };
    expect(vcsStatusResultSchema.parse(status)).toEqual(status);
    expect(vcsStatusResultSchema.safeParse({ ...status, frontierId: "frontier:1" }).success).toBe(
      false
    );
    expect(vcsStatusResultSchema.safeParse({ ...status, repositoryStateVector: [] }).success).toBe(
      false
    );
  });
});

describe("one authored-change model", () => {
  it("keeps authored changes on work units and basis realization on applications", () => {
    const work = {
      workUnitId: "work:1",
      commandId: "command:1",
      kind: "edit",
      authoredChangeCount: 1,
      authoredChangeIds: ["change:1"],
      incorporatedChangeCount: 0,
      incorporatedChangeIds: [],
      decisionCount: 0,
      decisionIds: [],
      intentSummary: "Rename the greeting",
      externalSnapshot: null,
      normalizationProtocol: "normalization:v1",
      createdAt: "2026-07-15T08:00:00.000Z",
    };
    expect(vcsWorkUnitSchema.parse(work)).toEqual(work);
    expect(vcsWorkUnitSchema.safeParse({ ...work, actor: { id: "agent:1" } }).success).toBe(false);

    const change = {
      changeId: "change:1",
      authoredByWorkUnitId: "work:1",
      operation: 0,
      kind: "file-move",
      effects: [
        {
          kind: "placement",
          fileId: "file:1",
          before: { repositoryId: "repository:1", path: "old.ts" },
          after: { repositoryId: "repository:1", path: "new.ts" },
        },
      ],
      counteractsChangeIds: [],
      effectDigest: "effect:1",
      normalizationProtocol: "normalization:v1",
    };
    expect(vcsChangeSchema.parse(change)).toEqual(change);
    expect(vcsChangeSchema.safeParse({ ...change, outcomeId: "outcome:1" }).success).toBe(false);

    const applied = {
      applicationId: "application:1",
      workUnitId: "work:1",
      basis: event,
      appliedChangeCount: 1,
      appliedChanges: [
        {
          appliedChangeId: "applied:1",
          applicationId: "application:1",
          changeId: "change:1",
          ordinal: 0,
          appliedEffects: change.effects,
          resultPredicate: {
            kind: "file-placement",
            fileId: "file:1",
            repositoryId: "repository:1",
            path: "new.ts",
          },
        },
      ],
      resultWorkspaceFactRootId: "facts:2",
      semanticProtocol: "semantic:v1",
    };
    expect(vcsWorkApplicationSchema.parse(applied)).toEqual(applied);
    const appliedChange = applied.appliedChanges[0]!;
    expect(vcsAppliedChangeSchema.parse(appliedChange)).toEqual(appliedChange);
    expect(
      vcsProvenanceRootSchema.parse({
        kind: "applied-change",
        appliedChangeId: appliedChange.appliedChangeId,
      })
    ).toEqual({ kind: "applied-change", appliedChangeId: appliedChange.appliedChangeId });
    expect(vcsInspectedNodeSchema.parse({ kind: "applied-change", value: appliedChange })).toEqual({
      kind: "applied-change",
      value: appliedChange,
    });
    expect(
      vcsProvenanceEdgeSchema.parse({
        kind: "realizes-change",
        from: { kind: "applied-change", appliedChangeId: appliedChange.appliedChangeId },
        to: { kind: "change", changeId: change.changeId },
      })
    ).toBeTruthy();
    expect(
      vcsWorkApplicationSchema.safeParse({ ...applied, applicationSequenceId: "sequence:1" })
        .success
    ).toBe(false);
  });
});

describe("simple local mutations", () => {
  it("authors strict expressive edits on an exact working head", () => {
    const input = {
      ...commonMutation,
      intentSummary: "Update and create files",
      changes: [
        {
          kind: "text-edit",
          repositoryId: "repository:1",
          fileId: "file:1",
          edits: [{ start: 0, end: 5, text: "hello" }],
        },
        {
          kind: "file-create",
          repositoryId: "repository:1",
          path: "src/new.ts",
          content: { kind: "text", text: "export {};\n" },
        },
      ],
    };
    const parsed = vcsEditInputSchema.parse(input);
    expect(parsed.changes[1]).toMatchObject({ mode: 0o644 });
    for (const legacyKey of [
      "target",
      "expectedTargetFrontierId",
      "actor",
      "authorship",
    ] as const) {
      expect(vcsEditInputSchema.safeParse({ ...input, [legacyKey]: "legacy" }).success).toBe(false);
    }
  });

  it("creates a repository and its initial files as one bounded edit change", () => {
    const input = {
      ...commonMutation,
      changes: [
        {
          kind: "repository-create",
          repoPath: "projects/notes",
          files: [
            {
              path: "README.md",
              content: { kind: "text", text: "# Notes\n" },
            },
          ],
        },
      ],
    };
    const parsed = vcsEditInputSchema.parse(input);
    expect(parsed.changes[0]).toMatchObject({
      kind: "repository-create",
      repoPath: "projects/notes",
      files: [{ path: "README.md", mode: 0o644 }],
    });
    expect(
      vcsEditInputSchema.safeParse({
        ...input,
        changes: [
          {
            ...input.changes[0],
            files: [input.changes[0]!.files[0], input.changes[0]!.files[0]],
          },
        ],
      }).success
    ).toBe(false);
  });

  it("makes move preserve identity and copy select an exact source state", () => {
    const move = {
      ...commonMutation,
      moves: [
        {
          kind: "file",
          repositoryId: "repository:a",
          fileId: "file:1",
          destinationRepositoryId: "repository:b",
          destinationPath: "moved.ts",
        },
      ],
    };
    expect(vcsMoveInputSchema.parse(move)).toEqual(move);

    const copy = {
      ...commonMutation,
      copies: [
        {
          source: { state: event, repositoryId: "repository:a", fileId: "file:1" },
          destination: { repositoryId: "repository:b", path: "copied.ts" },
        },
      ],
    };
    expect(vcsCopyInputSchema.parse(copy)).toEqual(copy);
    expect(
      vcsCopyInputSchema.safeParse({
        ...copy,
        copies: [{ ...copy.copies[0], destinationFileId: "file:caller-minted" }],
      }).success
    ).toBe(false);
    expect(
      vcsCopyInputSchema.safeParse({
        ...copy,
        copies: [{ ...copy.copies[0], source: { repositoryId: "repository:a", fileId: "file:1" } }],
      }).success
    ).toBe(false);
  });

  it("integrates one bounded decision as an ordinary local application", () => {
    const adopted = {
      ...commonMutation,
      sourceEventId: "event:source",
      decision: { kind: "adopted", sourceChangeIds: ["change:source"] },
    };
    expect(vcsIntegrateInputSchema.parse(adopted)).toEqual(adopted);
    expect(
      vcsIntegrateInputSchema.safeParse({
        ...adopted,
        decision: {
          kind: "reconciled",
          sourceChangeIds: ["change:source"],
          evidence: [{ kind: "file-content", fileId: "file:1", contentHash: "blob:1" }],
          rationale: "The target already contains the intended result.",
        },
      }).success
    ).toBe(true);
    expect(
      vcsIntegrateInputSchema.safeParse({ ...adopted, mergeSessionId: "session:1" }).success
    ).toBe(false);
  });

  it("reverts changes and commits or discards only the whole chain", () => {
    expect(
      vcsRevertInputSchema.parse({ ...commonMutation, changeIds: ["change:1", "change:2"] })
    ).toBeTruthy();
    expect(
      vcsCommitInputSchema.parse({
        ...commonMutation,
        message: "Complete local work",
        integratesEventId: "event:source",
      })
    ).toBeTruthy();
    expect(vcsDiscardInputSchema.parse(commonMutation)).toEqual(commonMutation);

    for (const selection of [
      { workUnitIds: ["work:1"] },
      { applicationIds: ["application:1"] },
      { paths: ["src/a.ts"] },
      { repositories: ["repository:1"] },
    ]) {
      expect(vcsCommitInputSchema.safeParse({ ...commonMutation, selection }).success).toBe(false);
      expect(vcsDiscardInputSchema.safeParse({ ...commonMutation, selection }).success).toBe(false);
    }
  });

  it("pushes an exact clean committed event without a certificate or proof", () => {
    const push = {
      commandId: "command:push",
      contextId: "context:1",
      expectedCommittedEventId: "event:2",
      expectedMainEventId: "event:1",
    };
    expect(vcsPushInputSchema.parse(push)).toEqual(push);
    expect(vcsPushInputSchema.safeParse({ ...push, certificateId: "certificate:1" }).success).toBe(
      false
    );
    expect(
      vcsPushInputSchema.safeParse({ ...push, protectedAncestryProof: { digest: "proof" } }).success
    ).toBe(false);
  });
});

describe("honest external snapshot imports", () => {
  const snapshot = {
    ...commonMutation,
    source: {
      kind: "git",
      uri: "https://example.invalid/repository.git",
      snapshotRevision: "abc123",
    },
    repositories: [
      {
        repoPath: "projects/app",
        files: [
          {
            path: "src/index.ts",
            contentHash: "a".repeat(64),
            mode: 0o644,
          },
        ],
      },
    ],
  } as const;

  it("accepts only source-level file facts, not caller-authored roots or intrinsic descriptors", () => {
    expect(vcsImportSnapshotInputSchema.parse(snapshot)).toEqual(snapshot);
    expect(
      vcsImportSnapshotInputSchema.safeParse({
        ...snapshot,
        source: { ...snapshot.source, parents: ["parent"] },
      }).success
    ).toBe(false);
    expect(
      vcsImportSnapshotInputSchema.safeParse({
        ...snapshot,
        contentRootId: "caller-assertion",
      }).success
    ).toBe(false);
    expect(
      vcsImportSnapshotInputSchema.safeParse({
        ...snapshot,
        repositories: [{ ...snapshot.repositories[0], treeHash: "caller-assertion" }],
      }).success
    ).toBe(false);
    expect(
      vcsImportSnapshotInputSchema.safeParse({
        ...snapshot,
        repositories: [
          {
            ...snapshot.repositories[0],
            files: [
              {
                ...snapshot.repositories[0].files[0],
                contentKind: "text",
                byteLength: 1,
                coordinateExtent: 1,
              },
            ],
          },
        ],
      }).success
    ).toBe(false);
  });

  it("rejects transport secrets and machine-local source names", () => {
    for (const uri of [
      "/home/user/private/checkout",
      "file:///home/user/private/checkout",
      "https://token@example.invalid/repository.git",
      "https://example.invalid/repository.git?signature=secret",
      "https://example.invalid/repository.git#temporary",
      "git@example.invalid:owner/repository.git",
      "https://EXAMPLE.invalid/repository.git",
    ]) {
      expect(
        vcsImportSnapshotInputSchema.safeParse({
          ...snapshot,
          source: { ...snapshot.source, uri },
        }).success,
        uri
      ).toBe(false);
    }
  });

  it("rejects ambiguous, non-canonical, or impossibly large snapshot descriptors", () => {
    const file = snapshot.repositories[0].files[0];
    expect(
      vcsImportSnapshotInputSchema.safeParse({
        ...snapshot,
        repositories: [
          { ...snapshot.repositories[0], files: [file, file] },
          { ...snapshot.repositories[0], files: [] },
        ],
      }).success
    ).toBe(false);
    expect(
      vcsImportSnapshotInputSchema.safeParse({
        ...snapshot,
        repositories: [
          {
            ...snapshot.repositories[0],
            files: [
              { ...file, path: "src/z.ts" },
              { ...file, path: "src/a.ts" },
            ],
          },
        ],
      }).success
    ).toBe(false);
    expect(
      vcsImportSnapshotInputSchema.safeParse({
        ...snapshot,
        intentSummary: "x".repeat(VCS_IMPORT_MAX_DESCRIPTOR_BYTES),
      }).success
    ).toBe(false);
  });

  it("bounds atomic imports by their canonical descriptor, not arbitrary item counts", () => {
    const file = snapshot.repositories[0].files[0];
    const repositories = Array.from({ length: 102 }, (_, repositoryIndex) => ({
      repoPath: `packages/r${String(repositoryIndex).padStart(3, "0")}`,
      files: Array.from({ length: 17 }, (_, fileIndex) => ({
        ...file,
        path: `f${String(fileIndex).padStart(3, "0")}.ts`,
      })),
    }));
    const input = {
      ...snapshot,
      source: { ...snapshot.source, kind: "filesystem" as const },
      repositories,
    };
    expect(new TextEncoder().encode(JSON.stringify(input)).byteLength).toBeLessThan(
      VCS_IMPORT_MAX_DESCRIPTOR_BYTES
    );
    expect(vcsImportSnapshotInputSchema.safeParse(input).success).toBe(true);
  });

  it("uses the shared semantic path policy for imports and direct mutations", () => {
    const file = snapshot.repositories[0].files[0];
    for (const path of [".git/config", ".gad/CHECKOUT.json", ".env"]) {
      expect(
        vcsImportSnapshotInputSchema.safeParse({
          ...snapshot,
          repositories: [{ ...snapshot.repositories[0], files: [{ ...file, path }] }],
        }).success,
        path
      ).toBe(false);
      expect(
        vcsEditInputSchema.safeParse({
          ...commonMutation,
          changes: [
            {
              kind: "file-create",
              repositoryId: "repository:1",
              path,
              content: { kind: "text", text: "value" },
            },
          ],
        }).success,
        path
      ).toBe(false);
    }
    for (const path of [
      "dist/index.js",
      "out/report.json",
      "release/checksums.txt",
      ".env.example",
    ]) {
      expect(
        vcsImportSnapshotInputSchema.safeParse({
          ...snapshot,
          repositories: [{ ...snapshot.repositories[0], files: [{ ...file, path }] }],
        }).success,
        path
      ).toBe(true);
    }
    for (const repoPath of ["packages/.git", "projects/.gad"] as const) {
      expect(
        vcsImportSnapshotInputSchema.safeParse({
          ...snapshot,
          repositories: [{ ...snapshot.repositories[0], repoPath }],
        }).success,
        repoPath
      ).toBe(false);
      expect(
        vcsResolveRepositoryInputSchema.safeParse({ state: event, repoPath }).success,
        repoPath
      ).toBe(false);
    }
  });

  it("projects the exact external snapshot tuple on the import work unit", () => {
    const work = {
      workUnitId: "work:import",
      commandId: "command:import",
      kind: "import",
      authoredChangeCount: 1,
      authoredChangeIds: ["change:create"],
      incorporatedChangeCount: 0,
      incorporatedChangeIds: [],
      decisionCount: 0,
      decisionIds: [],
      intentSummary: "Import the requested external snapshot",
      externalSnapshot: {
        sourceKind: "git",
        sourceUri: snapshot.source.uri,
        snapshotRevision: snapshot.source.snapshotRevision,
        snapshotDigest: `snapshot:${"d".repeat(64)}`,
        targetRepositoryIds: ["repository:imported"],
      },
      normalizationProtocol: "normalization:v1",
      createdAt: "2026-07-15T08:00:00.000Z",
    };
    expect(vcsWorkUnitSchema.parse(work)).toEqual(work);
    expect(
      vcsWorkUnitSchema.safeParse({
        ...work,
        externalSnapshot: {
          ...work.externalSnapshot,
          targetRepositoryIds: ["repository:z", "repository:a"],
        },
      }).success
    ).toBe(false);
    expect(
      vcsWorkUnitSchema.safeParse({
        ...work,
        externalSnapshot: {
          ...work.externalSnapshot,
          targetRepositoryIds: ["repository:a", "repository:a"],
        },
      }).success
    ).toBe(false);
    expect(vcsWorkUnitSchema.safeParse({ ...work, externalSnapshot: null }).success).toBe(false);
    expect(
      vcsWorkUnitSchema.safeParse({
        ...work,
        kind: "edit",
        externalSnapshot: work.externalSnapshot,
      }).success
    ).toBe(false);
    expect(vcsChangeKindSchema.parse("content-replace")).toBe("content-replace");
  });

  it("rejects unwalkable external authorship claims", () => {
    expect(
      vcsImportSnapshotInputSchema.safeParse({
        ...snapshot,
        repositories: [
          {
            ...snapshot.repositories[0],
            revisionEvidence: [{ path: "src/index.ts", revision: "abc123" }],
          },
        ],
      }).success
    ).toBe(false);
    expect(
      vcsErrorSchema.safeParse({ code: "ExternalAuthorshipIncomplete", message: "missing" }).success
    ).toBe(false);
  });
});

describe("walkable bounded reads", () => {
  it("derives exact provenance edge endpoint contracts from one relation registry", () => {
    const node = (kind: string) => {
      switch (kind) {
        case "event":
          return { kind, eventId: "event:1" };
        case "application":
          return { kind, applicationId: "application:1" };
        case "applied-change":
          return { kind, appliedChangeId: "applied-change:1" };
        case "work-unit":
          return { kind, workUnitId: "work-unit:1" };
        case "change":
          return { kind, changeId: "change:1" };
        case "decision":
          return { kind, decisionId: "decision:1" };
        case "command":
          return { kind, commandId: "command:1" };
        case "file":
          return { kind, state: event, repositoryId: "repository:1", fileId: "file:1" };
        case "repository":
          return { kind, state: application, repositoryId: "repository:1" };
        case "trajectory":
          return { kind, logId: "trajectory:1", head: "main" };
        case "trajectory-invocation":
          return { kind, logId: "trajectory:1", head: "main", invocationId: "invocation:1" };
        case "trajectory-turn":
          return { kind, logId: "trajectory:1", head: "main", turnId: "turn:1" };
        case "trajectory-message":
          return { kind, logId: "trajectory:1", head: "main", messageId: "message:1" };
        default:
          throw new Error(`missing fixture for ${kind}`);
      }
    };

    for (const [kind, variants] of Object.entries(vcsProvenanceRelationRegistry)) {
      for (const variant of variants) {
        expect(
          vcsProvenanceEdgeSchema.safeParse({
            kind,
            from: node(variant.from),
            to: node(variant.to),
          }).success,
          `${kind}: ${variant.from} -> ${variant.to}`
        ).toBe(true);
      }
    }

    expect(
      vcsProvenanceEdgeSchema.safeParse({
        kind: "copies-content",
        from: { kind: "change", changeId: "change:copy" },
        to: {
          kind: "file",
          state: event,
          repositoryId: "repository:1",
          fileId: "file:source",
        },
      }).success
    ).toBe(false);
    expect(
      vcsProvenanceEdgeSchema.safeParse({
        kind: "authored-copy-source",
        from: { kind: "applied-change", appliedChangeId: "applied-change:copy" },
        to: { kind: "applied-change", appliedChangeId: "applied-change:source" },
      }).success
    ).toBe(false);
  });

  it("compares changes between exact state nodes", () => {
    const input = {
      target: application,
      sourceEventId: "event:source",
      view: "changes",
      disposition: "actionable",
      limit: 50,
    };
    expect(vcsCompareInputSchema.parse(input)).toEqual(input);
    expect(
      vcsCompareInputSchema.safeParse({ ...input, sourceFrontierId: "frontier:1" }).success
    ).toBe(false);
  });

  it("exposes one unambiguous integration-resolution gate", () => {
    const result = {
      target: application,
      sourceEventId: "event:source",
      resolution: { complete: true, remainingChangeCount: 0 },
      counts: {
        shared: 1,
        alreadySatisfied: 0,
        actionable: 0,
        conflicting: 0,
        blocked: 0,
        accounted: 0,
        historical: 0,
      },
      changes: [],
      nextCursor: null,
    };
    expect(vcsCompareResultSchema.parse(result)).toEqual(result);
    expect(
      vcsCompareResultSchema.safeParse({
        ...result,
        resolution: { complete: true, remainingChangeCount: 1 },
      }).success
    ).toBe(false);
  });

  it("keeps inspect and neighbors broad while history accepts only meaningful roots", () => {
    const roots = [
      { kind: "event", eventId: "event:1" },
      { kind: "application", applicationId: "application:1" },
      { kind: "work-unit", workUnitId: "work:1" },
      { kind: "change", changeId: "change:1" },
      { kind: "decision", decisionId: "decision:1" },
      { kind: "command", commandId: "command:1" },
      { kind: "file", state: event, repositoryId: "repository:1", fileId: "file:1" },
      { kind: "repository", state: event, repositoryId: "repository:1" },
      { kind: "trajectory", logId: "trajectory:1", head: "head:1" },
    ] as const;
    for (const root of roots) {
      expect(vcsProvenanceRootSchema.safeParse(root).success, root.kind).toBe(true);
      expect(vcsInspectInputSchema.safeParse({ node: root, edgeLimit: 25 }).success).toBe(true);
      expect(vcsNeighborsInputSchema.safeParse({ root, limit: 25 }).success).toBe(true);
    }
    const file = {
      kind: "file",
      state: application,
      repositoryId: "repository:1",
      fileId: "file:1",
    } as const;
    expect(vcsHistoryInputSchema.parse({ root: event, limit: 25 })).toMatchObject({
      root: event,
      direction: "past",
    });
    expect(
      vcsHistoryInputSchema.parse({ root: event, direction: "future", limit: 25 })
    ).toMatchObject({ root: event, direction: "future" });
    expect(vcsHistoryInputSchema.parse({ root: file, limit: 25 })).toMatchObject({
      root: file,
      direction: "past",
    });
    expect(
      vcsHistoryInputSchema.safeParse({ root: file, direction: "future", limit: 25 }).success
    ).toBe(false);
    for (const unsupported of roots.filter(
      (root) => root.kind !== "event" && root.kind !== "file"
    )) {
      expect(
        vcsHistoryInputSchema.safeParse({ root: unsupported, limit: 25 }).success,
        unsupported.kind
      ).toBe(false);
      expect(
        vcsHistoryResultSchema.safeParse({
          root: unsupported,
          entries: [],
          nextCursor: null,
        }).success,
        unsupported.kind
      ).toBe(false);
    }
    for (const removed of [
      { kind: "frontier", frontierId: "frontier:1" },
      { kind: "atom", atomId: "atom:1" },
      { kind: "outcome", outcomeId: "outcome:1" },
      { kind: "realization", realizationId: "realization:1" },
      { kind: "certificate", certificateId: "certificate:1" },
    ]) {
      expect(vcsProvenanceRootSchema.safeParse(removed).success).toBe(false);
    }
  });

  it("inspects trajectory invocation identity and a bounded request reference without payload copies", () => {
    const invocation = {
      kind: "trajectory-invocation",
      value: {
        logId: "trajectory:1",
        head: "main",
        invocationId: "invocation:1",
        turnId: "turn:1",
        name: "vcs.edit",
        status: "completed",
        terminalOutcome: "success",
        requestRef: {
          protocol: "vibestudio.blob-ref.v1",
          digest: "a".repeat(64),
          size: 128,
          encoding: "json",
          originalBytes: 2_000_000,
        },
        startedEventId: "event:started",
        completedEventId: "event:completed",
      },
    } as const;
    expect(vcsInspectedNodeSchema.parse(invocation)).toEqual(invocation);
    expect(
      vcsInspectedNodeSchema.safeParse({
        ...invocation,
        value: {
          ...invocation.value,
          request: { changes: ["private"] },
          result: { content: "private" },
          authorship: { actor: "agent" },
        },
      }).success
    ).toBe(false);
    expect(
      vcsInspectedNodeSchema.safeParse({
        ...invocation,
        value: {
          ...invocation.value,
          requestRef: { ...invocation.value.requestRef, secret: "not a public projection" },
        },
      }).success
    ).toBe(false);
    expect(
      vcsInspectedNodeSchema.safeParse({
        ...invocation,
        value: { ...invocation.value, status: " " },
      }).success
    ).toBe(false);
    expect(
      vcsInspectedNodeSchema.parse({
        ...invocation,
        value: {
          ...invocation.value,
          turnId: null,
          name: null,
          terminalOutcome: null,
          requestRef: null,
          completedEventId: null,
        },
      }).value
    ).toMatchObject({ terminalOutcome: null, completedEventId: null });
  });

  it("returns the exact reusable root separately from its inspected value", () => {
    const root = { kind: "command" as const, commandId: "command:1" };
    expect(
      vcsInspectResultSchema.parse({
        root,
        node: {
          kind: "command",
          value: {
            commandId: "command:1",
            workspaceId: "workspace:1",
            contextId: "context:1",
            method: "vcs.edit",
            status: "complete",
            result: null,
            createdAt: "2026-07-15T00:00:00.000Z",
            completedAt: "2026-07-15T00:00:01.000Z",
          },
        },
        edges: [],
        hasMoreEdges: false,
      }).root
    ).toEqual(root);
  });

  it("walks private intent metadata only through an explicitly scoped turn and trigger message", () => {
    const turn = {
      kind: "trajectory-turn",
      value: {
        logId: "trajectory:1",
        head: "main",
        turnId: "turn:1",
        triggerMessageId: "message:prompt",
        openedAt: "2026-07-15T00:00:00.000Z",
        closedAt: null,
        summary: "Move the parser",
        ordinal: 0,
      },
    } as const;
    const message = {
      kind: "trajectory-message",
      value: {
        logId: "trajectory:1",
        head: "main",
        messageId: "message:prompt",
        turnId: null,
        role: "user",
        status: "completed",
        startedEventId: null,
        completedEventId: "event:prompt",
        sourceMessageId: "channel-message:prompt",
        senderRef: { kind: "user", id: "user:alice", participantId: "user:alice" },
        textBlocks: [{ blockId: "block:prompt", content: "Move the parser" }],
      },
    } as const;
    expect(vcsInspectedNodeSchema.parse(turn)).toEqual(turn);
    expect(vcsInspectedNodeSchema.parse(message)).toEqual(message);
    expect(
      vcsInspectedNodeSchema.safeParse({
        ...message,
        value: { ...message.value, content: "private prompt bytes" },
      }).success
    ).toBe(false);

    const invocation = {
      kind: "trajectory-invocation" as const,
      logId: "trajectory:1",
      head: "main",
      invocationId: "invocation:1",
    };
    expect(vcsInspectInputSchema.safeParse({ node: invocation, edgeLimit: 20 }).success).toBe(true);
    expect(
      vcsNeighborsInputSchema.safeParse({
        root: {
          kind: "trajectory-turn",
          logId: "trajectory:1",
          head: "main",
          turnId: "turn:1",
        },
        limit: 20,
      }).success
    ).toBe(true);
  });

  it("binds blame and semantic file reads to exact state", () => {
    const blame = {
      state: event,
      repositoryId: "repository:1",
      fileId: "file:1",
      range: { start: 0, end: 5 },
      limit: 100,
    };
    expect(vcsBlameInputSchema.parse(blame)).toEqual(blame);
    expect(
      vcsBlameInputSchema.safeParse({
        ...blame,
        range: { ...blame.range, coordinateKind: "utf16" },
      }).success
    ).toBe(false);
    const result = {
      state: event,
      fileId: "file:1",
      coordinateKind: "utf16" as const,
      spans: [
        {
          start: 0,
          end: 5,
          change: { kind: "change" as const, changeId: "change:1" },
          appliedChange: {
            kind: "applied-change" as const,
            appliedChangeId: "applied-change:1",
          },
          workUnit: { kind: "work-unit" as const, workUnitId: "work-unit:1" },
          command: { kind: "command" as const, commandId: "command:1" },
          path: [],
          stop: "authored" as const,
        },
      ],
      nextCursor: null,
    };
    const parsed = vcsBlameResultSchema.parse(result);
    expect(parsed.coordinateKind).toBe("utf16");
    expect(parsed.spans[0]).toMatchObject({
      change: result.spans[0]!.change,
      appliedChange: result.spans[0]!.appliedChange,
      workUnit: result.spans[0]!.workUnit,
      command: result.spans[0]!.command,
    });
    expect(
      vcsBlameResultSchema.safeParse({
        ...result,
        spans: [
          {
            start: 0,
            end: 5,
            changeId: "change:1",
            appliedChangeId: "applied-change:1",
            workUnitId: "work-unit:1",
            commandId: "command:1",
            path: [],
            stop: "authored",
          },
        ],
      }).success
    ).toBe(false);
    expect(
      vcsReadFileInputSchema.parse({
        state: event,
        repositoryId: "repository:1",
        file: { kind: "id", fileId: "file:1" },
      })
    ).toBeTruthy();
    expect(
      vcsReadFileInputSchema.safeParse({
        kind: "semantic",
        state: event,
        repositoryId: "repository:1",
        file: { kind: "id", fileId: "file:1" },
      }).success
    ).toBe(false);
    expect(
      vcsReadFileInputSchema.safeParse({
        kind: "raw",
        repoPath: "projects/app",
        path: "src/index.ts",
      }).success
    ).toBe(false);
    expect(
      vcsListFilesInputSchema.parse({ state: event, repositoryId: "repository:1", limit: 100 })
    ).toBeTruthy();
  });
});

describe("explicit reference metadata", () => {
  it("extracts request references declaratively without Zod reflection", () => {
    assertVcsSemanticReferenceContract();
    expect(new Set(vcsSemanticReferenceKinds)).toEqual(
      new Set([
        "context",
        "state-node",
        "event",
        "application",
        "work-unit",
        "change",
        "decision",
        "command",
        "repository",
        "file",
        "node",
      ])
    );

    const request = {
      ...commonMutation,
      copies: [
        {
          source: { state: application, repositoryId: "repository:a", fileId: "file:a" },
          destination: { repositoryId: "repository:b", path: "copy.ts" },
        },
      ],
    };
    const parsed = parseVcsSemanticRequest("copy", request);
    expect(parsed.input).toEqual(request);
    expect(parsed.references.map(({ kind, role, value }) => ({ kind, role, value }))).toEqual([
      { kind: "command", role: "resource", value: "command:1" },
      { kind: "context", role: "context", value: "context:1" },
      { kind: "state-node", role: "basis", value: event },
      { kind: "state-node", role: "source", value: application },
      { kind: "repository", role: "source", value: "repository:a" },
      { kind: "file", role: "source", value: "file:a" },
      { kind: "repository", role: "target", value: "repository:b" },
    ]);
    expect(extractVcsSemanticReferences("status", [{ contextId: "context:1" }])).toHaveLength(1);
    expect(vcsOperationContextId("copy", parsed.input)).toBe("context:1");
    expect(
      vcsOperationContextId("compare", { target: event, sourceEventId: "event:2" })
    ).toBeNull();
  });

  it("keeps operation classes small and schema-owned", () => {
    expect(vcsOperationRegistry.edit.accessClass).toBe("context-write");
    expect(vcsOperationRegistry.status.accessClass).toBe("read");
    expect(vcsOperationRegistry.push.accessClass).toBe("workspace-write");
  });
});

describe("small typed error vocabulary", () => {
  it("is closed and declares only recovery-relevant evidence", () => {
    const changed = {
      code: "RevisionChanged",
      message: "The working head advanced",
      expected: event,
      actual: application,
    } as const;
    expect(createVcsError(changed)).toEqual(changed);
    expect(createVcsMethodError("edit", changed)).toEqual(changed);
    expect(vcsErrorSchema.safeParse({ code: "EUNKNOWN", message: "opaque" }).success).toBe(false);
    expect(
      vcsErrorSchema.safeParse({
        code: "IntegrationIncomplete",
        message: "One source change remains",
        sourceEventId: "event:source",
        unaccountedChangeIds: ["change:1"],
      }).success
    ).toBe(true);
    expect(() => createVcsMethodError("status", changed)).toThrow(
      "VCS status does not declare error RevisionChanged"
    );
  });
});
