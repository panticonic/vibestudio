import { describe, expect, it, vi } from "vitest";
import { createCopyFileTool, createMoveFileTool } from "../file-transfer.js";
import type { ToolFileTransferVcs } from "../tool-vcs.js";

const working = { kind: "event" as const, eventId: "event:working" };
const next = { kind: "application" as const, applicationId: "application:next" };

function fixture(options: { missing?: boolean; failure?: Error } = {}) {
  const status = vi.fn(async () => ({
    contextId: "context:1",
    committed: working,
    workingHead: working,
    clean: false,
    mainEventId: "event:main",
    mainRelation: "ahead" as const,
    workingCounts: { applications: 1, workUnits: 1, changes: 1 },
  }));
  const resolveRepository = vi.fn(
    async (input: Parameters<ToolFileTransferVcs["resolveRepository"]>[0]) => ({
      state: input.state,
      repositoryId: `repository:${input.repoPath}`,
      repoPath: input.repoPath,
    })
  );
  const readFile = vi.fn(async (input: Parameters<ToolFileTransferVcs["readFile"]>[0]) => {
    if (options.failure) throw options.failure;
    if (input.file.kind !== "path") return null;
    if (options.missing && input.file.path === "src/a.ts") return null;
    const repoPath = input.repositoryId.slice("repository:".length);
    return {
      repositoryId: input.repositoryId,
      fileId: input.file.path === "src/a.ts" ? "file:stable" : "file:copy",
      repoPath,
      path: input.file.path,
      contentHash: "blob:1",
      mode: 0o644,
      content: { kind: "text" as const, text: "content" },
    };
  });
  const mutationResult = {
    contextId: "context:1",
    workUnitId: "work:1",
    applicationId: "application:next",
    changeCount: 1,
    changeIds: ["change:1"],
    incorporatedChangeCount: 0,
    incorporatedChangeIds: [],
    workingHead: next,
  };
  const move = vi.fn(async () => mutationResult);
  const copy = vi.fn(async () => mutationResult);
  const vcs = { status, resolveRepository, readFile, move, copy } satisfies ToolFileTransferVcs;
  return { vcs, move, copy, readFile };
}

describe("stable-identity file transfer tools", () => {
  it("moves one exact file identity", async () => {
    const { vcs, move } = fixture();
    const tool = createMoveFileTool("/", vcs, {
      contextId: "context:1",
      commandId: "command:move",
    });
    const result = await tool.execute("call:1", {
      source: "packages/source/src/a.ts",
      destination: "panels/target/src/moved.ts",
    });

    expect(move).toHaveBeenCalledWith({
      contextId: "context:1",
      expectedWorkingHead: working,
      commandId: "command:move",
      intentSummary: "Move packages/source/src/a.ts to panels/target/src/moved.ts",
      moves: [
        {
          kind: "file",
          repositoryId: "repository:packages/source",
          fileId: "file:stable",
          destinationRepositoryId: "repository:panels/target",
          destinationPath: "src/moved.ts",
        },
      ],
    });
    expect(result.details).toMatchObject({ operation: "moved", changeId: "change:1" });
  });

  it("copies from an exact source state", async () => {
    const { vcs, copy } = fixture();
    const tool = createCopyFileTool("/", vcs, {
      contextId: "context:1",
      commandId: "command:copy",
    });
    const result = await tool.execute("call:2", {
      source: "packages/source/src/a.ts",
      destination: "panels/target/src/copied.ts",
    });

    expect(copy).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedWorkingHead: working,
        copies: [
          {
            source: {
              state: working,
              repositoryId: "repository:packages/source",
              fileId: "file:stable",
            },
            destination: {
              repositoryId: "repository:panels/target",
              path: "src/copied.ts",
            },
          },
        ],
      })
    );
    expect(result.details.operation).toBe("copied");
  });

  it("reports a missing source without mutating", async () => {
    const { vcs, move } = fixture({ missing: true });
    const tool = createMoveFileTool("/", vcs, {
      contextId: "context:1",
      commandId: "command:missing",
    });
    await expect(
      tool.execute("call:3", {
        source: "packages/source/src/a.ts",
        destination: "panels/target/src/moved.ts",
      })
    ).rejects.toMatchObject({ code: "ENOENT", syscall: "move_file" });
    expect(move).not.toHaveBeenCalled();
  });

  it("propagates graph/read failures", async () => {
    const failure = new Error("semantic authority unavailable");
    const { vcs, copy } = fixture({ failure });
    const tool = createCopyFileTool("/", vcs, {
      contextId: "context:1",
      commandId: "command:failure",
    });
    await expect(
      tool.execute("call:4", {
        source: "packages/source/src/a.ts",
        destination: "panels/target/src/copied.ts",
      })
    ).rejects.toBe(failure);
    expect(copy).not.toHaveBeenCalled();
  });
});
