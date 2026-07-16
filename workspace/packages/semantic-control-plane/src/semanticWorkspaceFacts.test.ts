import { describe, expect, it, vi } from "vitest";
import { createInMemorySql } from "@workspace/runtime/worker/test-utils";
import {
  composeFileManifest,
  emptyFileManifest,
  planWorkspaceFactChangeSet,
  workspaceFileStateIdentity,
  workspaceRepositoryStateIdentity,
  type PersistentRadixNode,
} from "@workspace/vcs-engine";
import { createSemanticVcsSchema } from "./semanticVcsSchema.js";
import { SemanticWorkspaceFacts } from "./semanticWorkspaceFacts.js";

describe("SemanticWorkspaceFacts", () => {
  it("persists and reads one normalized workspace fact root", async () => {
    const sql = await createInMemorySql();
    createSemanticVcsSchema(sql);
    const facts = new SemanticWorkspaceFacts(sql);
    const basis = facts.empty();
    const emptyManifest = emptyFileManifest("repo-1");
    const nodes = new Map<string, PersistentRadixNode>([
      [emptyManifest.node.nodeId, emptyManifest.node],
    ]);
    const manifestProof = composeFileManifest({
      basis: emptyManifest.manifest,
      updates: [{ fileId: "file-1", expectedPath: null, resultPath: "src/index.ts" }],
      readNode: (_kind, _route, nodeId) => nodes.get(nodeId) ?? null,
    });
    const repository = workspaceRepositoryStateIdentity({
      repositoryId: "repo-1",
      presence: "present",
      repoPath: "packages/core",
      fileManifestId: manifestProof.resultManifest.fileManifestId,
    });
    const file = workspaceFileStateIdentity({
      fileId: "file-1",
      presence: "placed",
      repositoryId: "repo-1",
      path: "src/index.ts",
      contentHash: "blob-1",
      mode: 0o100644,
      contentKind: "text",
      byteLength: 4,
      coordinateExtent: 4,
    });
    if (repository.presence !== "present" || file.presence !== "placed") {
      throw new Error("fixture identities lost their discriminants");
    }
    sql.exec(
      `INSERT INTO vcs_repository_states
       (repository_state_id, repository_id, repo_path, presence, file_manifest_id,
        prior_repository_state_id, tombstone_change_id)
       VALUES (?, ?, ?, 'present', ?, NULL, NULL)`,
      repository.repositoryStateId,
      repository.repositoryId,
      repository.repoPath,
      repository.fileManifestId
    );
    sql.exec(
      `INSERT INTO vcs_file_states
       (file_state_id, file_id, presence, repository_id, path, content_hash, mode,
        content_kind, byte_length, coordinate_extent, prior_file_state_id, tombstone_change_id)
       VALUES (?, ?, 'placed', ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      file.fileStateId,
      file.fileId,
      file.repositoryId,
      file.path,
      file.contentHash,
      file.mode,
      file.contentKind,
      file.byteLength,
      file.coordinateExtent
    );
    const planned = planWorkspaceFactChangeSet({
      basisWorkspaceFactRootId: basis.workspaceFactRootId,
      repositoryUpdates: [{ repositoryId: "repo-1", expected: null, result: repository }],
      manifestUpdates: [
        {
          repositoryId: "repo-1",
          expectedFileManifestId: null,
          resultManifest: manifestProof.resultManifest,
          pathUpdates: manifestProof.updates,
        },
      ],
      fileUpdates: [{ fileId: "file-1", expected: null, result: file }],
    });
    expect(planned.kind).toBe("planned");
    if (planned.kind !== "planned") return;
    const proof = facts.apply(planned.changeSet);

    expect(proof.resultRoot.entryCount).toBe(3);
    expect(facts.member(proof.resultRoot.workspaceFactRootId, "repo-1")).toEqual(repository);
    expect(facts.file(proof.resultRoot.workspaceFactRootId, "file-1")?.state).toEqual(file);
    expect(
      facts.fileAtPath(proof.resultRoot.workspaceFactRootId, "repo-1", "src/index.ts")?.state
    ).toEqual(file);
    expect(() => facts.assertIndexParity(proof.resultRoot.workspaceFactRootId)).not.toThrow();
  });

  it("seeks and pages one lexical fact kind without hydrating the aggregate root", async () => {
    const sql = await createInMemorySql();
    createSemanticVcsSchema(sql);
    const facts = new SemanticWorkspaceFacts(sql);
    const basis = facts.empty();
    const repositoryUpdates = [];
    const fileUpdates = [];
    const repositoryCount = 104;

    for (let index = 0; index < repositoryCount; index += 1) {
      const suffix = index.toString().padStart(3, "0");
      const repository = workspaceRepositoryStateIdentity({
        repositoryId: `repo-${suffix}`,
        presence: "deleted",
        priorRepositoryStateId: `prior-repository-state-${suffix}`,
        tombstoneChangeId: `repository-tombstone-${suffix}`,
      });
      const file = workspaceFileStateIdentity({
        fileId: `file-${suffix}`,
        presence: "deleted",
        priorFileStateId: `prior-file-state-${suffix}`,
        tombstoneChangeId: `file-tombstone-${suffix}`,
      });
      if (repository.presence !== "deleted" || file.presence !== "deleted") {
        throw new Error("fixture identities lost their deleted discriminants");
      }
      sql.exec(
        `INSERT INTO vcs_repository_states
         (repository_state_id, repository_id, repo_path, presence, file_manifest_id,
          prior_repository_state_id, tombstone_change_id)
         VALUES (?, ?, NULL, 'deleted', NULL, ?, ?)`,
        repository.repositoryStateId,
        repository.repositoryId,
        repository.priorRepositoryStateId,
        repository.tombstoneChangeId
      );
      sql.exec(
        `INSERT INTO vcs_file_states
         (file_state_id, file_id, presence, repository_id, path, content_hash, mode,
          content_kind, byte_length, coordinate_extent, prior_file_state_id, tombstone_change_id)
         VALUES (?, ?, 'deleted', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
        file.fileStateId,
        file.fileId,
        file.priorFileStateId,
        file.tombstoneChangeId
      );
      repositoryUpdates.push({
        repositoryId: repository.repositoryId,
        expected: null,
        result: repository,
      });
      fileUpdates.push({ fileId: file.fileId, expected: null, result: file });
    }

    const planned = planWorkspaceFactChangeSet({
      basisWorkspaceFactRootId: basis.workspaceFactRootId,
      repositoryUpdates,
      manifestUpdates: [],
      fileUpdates,
    });
    expect(planned.kind).toBe("planned");
    if (planned.kind !== "planned") return;
    const proof = facts.apply(planned.changeSet);
    expect(proof.resultRoot).toMatchObject({
      entryCount: repositoryCount * 2,
      repositoryCount,
      livePathCount: 0,
      fileCount: repositoryCount,
    });

    const nodeReads = vi.spyOn(facts, "node");
    const first = facts.page(proof.resultRoot.workspaceFactRootId, "repository", { limit: 2 });

    expect(first).toEqual({
      values: [
        { key: "repo-000", value: repositoryUpdates[0]!.result.repositoryStateId },
        { key: "repo-001", value: repositoryUpdates[1]!.result.repositoryStateId },
      ],
      total: repositoryCount,
      next: "repo-001",
    });
    expect(nodeReads.mock.calls.length).toBeGreaterThan(0);
    expect(nodeReads.mock.calls.length).toBeLessThan(24);

    nodeReads.mockClear();
    expect(
      facts
        .page(proof.resultRoot.workspaceFactRootId, "repository", {
          afterKey: first.next!,
          limit: 2,
        })
        .values.map((entry) => entry.key)
    ).toEqual(["repo-002", "repo-003"]);
    expect(nodeReads.mock.calls.length).toBeLessThan(24);

    expect(
      facts
        .page(proof.resultRoot.workspaceFactRootId, "repository", {
          afterKey: "repo-099",
          limit: 10,
        })
        .values.map((entry) => entry.key)
    ).toEqual(["repo-100", "repo-101", "repo-102", "repo-103"]);
  });
});
