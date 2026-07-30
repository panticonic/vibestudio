// Builtin semantic-authority tests.
import { describe, expect, it } from "vitest";
import { canonicalSnapshotDigest, sha256Hex } from "@vibestudio/content-addressing";
import { createTestDO } from "@vibestudio/durable/test-utils";
import type {
  InitializeExactWorkspaceSnapshotInput,
  WorkspaceSourceInitializationInspection,
} from "@vibestudio/workspace-contracts/workspaceSource";
import { GadWorkspaceDO } from "./index.js";

function effectReceipt(
  inspection: Extract<WorkspaceSourceInitializationInspection, { state: "initializing" }>,
  bytes: Uint8Array
): Record<string, unknown> {
  const effect = inspection.pendingEffect;
  if (!effect) throw new Error("fixture expected a pending effect");
  if (effect.kind === "observe-content") {
    return {
      files: (effect.payload["files"] as Array<{ contentHash: string }>).map((file) => ({
        contentHash: file.contentHash,
        contentKind: "text",
        byteLength: bytes.byteLength,
        coordinateExtent: new TextDecoder().decode(bytes).length,
      })),
    };
  }
  if (effect.kind === "materialize-context") {
    const repositories = effect.payload["repositories"] as Array<{
      repositoryId: string;
      repoPath: string;
      presence: "present" | "deleted";
    }>;
    return {
      materializationId: effect.effectId,
      contextId: effect.payload["contextId"],
      targetState: effect.payload["targetState"],
      repositories: repositories
        .filter((repository) => repository.presence === "present")
        .map((repository) => ({
          repositoryId: repository.repositoryId,
          repoPath: repository.repoPath,
          contentRoot: `state:${"0".repeat(64)}`,
        })),
      payloadDigest: effect.payload["payloadDigest"],
    };
  }
  return { applied: true, appliedAt: "2026-07-29T00:00:00.000Z" };
}

describe("WorkspaceSourceProviderV1", () => {
  it("initializes one exact snapshot idempotently through the finite effect protocol", async () => {
    const { instance } = await createTestDO(GadWorkspaceDO, {
      __objectKey: "workspace-one",
      WORKSPACE_ID: "workspace-one",
    });
    const bytes = new TextEncoder().encode("systemEpoch: 57\n");
    const contentHash = sha256Hex(bytes);
    const repositorySnapshot = canonicalSnapshotDigest([
      {
        path: "vibestudio.yml",
        contentHash,
        size: bytes.byteLength,
        mode: 0o100644,
      },
    ]);
    const input: InitializeExactWorkspaceSnapshotInput = {
      commandId: "initialize:one",
      pin: {
        url: "git+https://example.test/base.git",
        ref: "refs/tags/v1",
        commit: "1".repeat(40),
        snapshot: `v1-sha256:${"2".repeat(64)}`,
      },
      repositories: [
        {
          repoPath: "meta",
          subdir: "meta",
          snapshot: repositorySnapshot,
          files: [{ path: "vibestudio.yml", contentHash, mode: 0o644 }],
        },
      ],
    };

    let inspection = await instance.workspaceSourceInitializeExactSnapshot(input);
    for (let step = 0; inspection.state === "initializing" && step < 10; step += 1) {
      if (!inspection.pendingEffect) {
        inspection = await instance.workspaceSourceInitializeExactSnapshot(input);
        continue;
      }
      const effect = inspection.pendingEffect;
      inspection = await instance.workspaceSourceInitializeExactSnapshot({
        ...input,
        acknowledgement: {
          effectId: effect.effectId,
          payloadDigest: effect.payloadDigest,
          receipt: effectReceipt(
            { state: "initializing", commandId: input.commandId, pendingEffect: effect },
            bytes
          ),
        },
      });
    }

    expect(inspection).toMatchObject({
      state: "ready",
      commandId: input.commandId,
      receipt: {
        commandId: input.commandId,
        pin: input.pin,
        initializedEventId: expect.any(String),
        initializedStateHash: expect.stringMatching(/^state:[0-9a-f]{64}$/u),
      },
    });
    await expect(instance.workspaceSourceInitializeExactSnapshot(input)).resolves.toEqual(
      inspection
    );
    expect(instance.workspaceSourceInspectInitialization()).toEqual(inspection);
    expect(instance.workspaceSourceCurrent()).toEqual({
      stateHash:
        inspection.state === "ready" ? inspection.receipt.initializedStateHash : "unreachable",
    });
    expect(instance.workspaceSourceHealth()).toEqual({
      ok: true,
      protocol: "vibestudio.workspace-source.v1",
    });
  });

  it("rejects divergent command reuse before changing semantic state", async () => {
    const { instance } = await createTestDO(GadWorkspaceDO, {
      __objectKey: "workspace-two",
      WORKSPACE_ID: "workspace-two",
    });
    const base: InitializeExactWorkspaceSnapshotInput = {
      commandId: "initialize:two",
      pin: {
        url: "git+https://example.test/base.git",
        ref: "refs/tags/v1",
        commit: "4".repeat(40),
        snapshot: `v1-sha256:${"5".repeat(64)}`,
      },
      repositories: [
        {
          repoPath: "meta",
          subdir: "meta",
          snapshot: `v1-sha256:${"6".repeat(64)}`,
          files: [],
        },
      ],
    };
    await instance.workspaceSourceInitializeExactSnapshot(base);
    await expect(
      instance.workspaceSourceInitializeExactSnapshot({
        ...base,
        pin: { ...base.pin, commit: "7".repeat(40) },
      })
    ).rejects.toThrow(/command initialize:two was reused/u);
  });
});
