import { describe, expect, it } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { GadWorkspaceDO } from "./index.js";

describe("GadWorkspaceDO", () => {
  it("records sessions, turns, reads, mutations, and status", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);

    await call("ensureBlob", "a".repeat(64), 4, "text/plain");
    await call("ensureBlob", "b".repeat(64), 5, "text/plain");
    await expect(call("recordSession", {
      id: "session-1",
      source: "test",
      branchId: "branch-1",
      channelId: "channel-1",
      contextId: "context-1",
    })).resolves.toEqual({ id: "session-1" });
    await expect(call("recordTurn", {
      sessionId: "session-1",
      role: "user",
      content: "make the change",
    })).resolves.toEqual({ id: 1, turnIndex: 0 });
    const tool = await call<{ id: number }>("beginToolCall", {
      sessionId: "session-1",
      turnId: 1,
      toolName: "edit",
      isMutation: true,
      branchId: "branch-1",
    });

    await expect(call("recordRead", {
      toolCallId: tool.id,
      filePath: "/src/file.ts",
      contentHash: "a".repeat(64),
      contentSize: 4,
    })).resolves.toEqual({ id: 1 });
    await expect(call("recordMutation", {
      toolCallId: tool.id,
      filePath: "/src/file.ts",
      beforeHash: "a".repeat(64),
      beforeSize: 4,
      afterHash: "b".repeat(64),
      afterSize: 5,
      mutationType: "modify",
      branchId: "branch-1",
    })).resolves.toEqual({ id: 1 });

    const versions = await call<{ rows: Array<{ path: string; content_hash: string }> }>(
      "rawSql",
      "SELECT path, content_hash FROM file_versions",
    );
    expect(versions.rows).toEqual([{ path: "/src/file.ts", content_hash: "b".repeat(64) }]);

    const status = await call<Array<{ metric: string; value: number }>>("getStatus");
    expect(status.find((row) => row.metric === "Sessions")?.value).toBe(1);
    expect(status.find((row) => row.metric === "Tool calls")?.value).toBe(1);
    expect(status.find((row) => row.metric === "File versions")?.value).toBe(1);
  });

  it("supports branches, plans, chunks, parsing, embeddings, and blob policies", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const hash = "c".repeat(64);

    await call("ensureBlob", hash, 80, "text/typescript");
    await expect(call("ensureBranch", { id: "main", name: "Main" })).resolves.toEqual({ id: "main" });
    await expect(call("forkBranch", { id: "feature", name: "Feature", parentBranchId: "main" })).resolves.toEqual({ id: "feature" });
    const branches = await call<Array<{ id: string }>>("listBranches");
    expect(branches.map((branch) => branch.id)).toContain("feature");

    const plan = await call<{ id: number; content_hash: string }>("recordPlan", {
      content: "Implement the feature",
      title: "Plan",
      branchId: "feature",
    });
    expect(plan.id).toBe(1);
    await expect(call("listPlans", { activeOnly: true })).resolves.toHaveLength(1);
    await call("recordSession", { id: "session-plan", source: "test" });
    const turn = await call<{ id: number }>("recordTurn", {
      sessionId: "session-plan",
      role: "assistant",
      content: "Plan:\n- Add the branch UI browser\n- Implement indexing for edits\n- Test workerd dispatch",
    });
    await call("indexTurn", turn.id);
    await expect(call("listPlans", { activeOnly: true })).resolves.toHaveLength(2);

    const chunk = await call<{ content_hash: string }>("createChunk", {
      content: "Feature branch changes src/file.ts",
      topicLabel: "Feature branch",
      attribution: "test",
      relations: [{ targetType: "blob", targetHash: hash }],
    });
    expect(chunk.content_hash).toMatch(/^[0-9a-f]{64}$/);
    await expect(call("getChunksFor", "blob", hash)).resolves.toHaveLength(1);
    const graph = await call<{ nodes: unknown[]; edges: unknown[] }>("walkDependencies", chunk.content_hash, { maxDepth: 2 });
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);

    const structures = await call<Array<{ node_name: string }>>("parseFileVersion", {
      filePath: "src/file.ts",
      contentHash: hash,
      content: "export function run() { return 1; }\nclass Box {}",
    });
    expect(structures.map((row) => row.node_name)).toContain("run");
    await expect(call("findParsedByName", "run", {})).resolves.toHaveLength(1);

    await call("upsertChunkEmbedding", { chunkHash: chunk.content_hash, model: "test", vector: [1, 0, 0] });
    await expect(call("findSimilarChunks", { model: "test", vector: [1, 0, 0], k: 1 }))
      .resolves.toEqual([{ chunkHash: chunk.content_hash, score: 1 }]);

    await expect(call("setBlobPolicy", {
      hash,
      retentionClass: "ephemeral",
      privacyLevel: "sensitive",
    })).resolves.toMatchObject({ hash, retention_class: "ephemeral", privacy_level: "sensitive" });
    await expect(call("listBlobReferences", { includeUnreferenced: true }))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ hash })]));
  });
});
