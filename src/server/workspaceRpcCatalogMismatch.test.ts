import { describe, expect, it } from "vitest";
import {
  WORKSPACE_RPC_METHOD_UNDECLARED,
  WorkspaceRpcMethodUndeclaredError,
} from "./workspaceRpcCatalogMismatch.js";

describe("WorkspaceRpcMethodUndeclaredError", () => {
  it("carries actionable exact-build evidence without requiring message parsing", () => {
    const error = new WorkspaceRpcMethodUndeclaredError({
      source: "workers/board-store",
      className: "BoardStore",
      objectKey: "main",
      method: "importBoard",
      serviceName: "board-store",
      activeBuildKey: "b".repeat(64),
      activeEffectiveVersion: "ev-active",
      declaredMethods: ["listBoard", "addCard", "listBoard"],
      callerContextId: "ctx-agent",
      candidateStateHash: `state:${"c".repeat(64)}`,
      candidateBuildKey: "d".repeat(64),
      candidateDeclaresMethod: true,
    });

    expect(error).toMatchObject({
      code: WORKSPACE_RPC_METHOD_UNDECLARED,
      errorKind: "application",
      errorData: {
        code: WORKSPACE_RPC_METHOD_UNDECLARED,
        serviceName: "board-store",
        method: "importBoard",
        declaredMethods: ["addCard", "listBoard"],
        activeEffectiveVersion: "ev-active",
        callerContextId: "ctx-agent",
        candidateBuildKey: "d".repeat(64),
        candidateDeclaresMethod: true,
        recovery: {
          kind: "publish-verified-provider-candidate",
          repoPath: "workers/board-store",
          liveRuntimeUpdated: false,
          steps: [
            { operation: "vcs.commit" },
            { operation: "vcs.push", arguments: { repoPaths: ["workers/board-store"] } },
            { operation: "workers.resolveService" },
            { operation: "rpc.call", method: "importBoard" },
          ],
        },
      },
    });
    expect(error.message).toContain("Build verification does not update a live service");
    expect(error.message).toContain("push workers/board-store to protected main");
  });

  it("gives an exact provider publication path when no candidate was verified", () => {
    const error = new WorkspaceRpcMethodUndeclaredError({
      source: "workers/board-store",
      className: "BoardStore",
      objectKey: "main",
      method: "importBoard",
      declaredMethods: ["listBoard"],
    });

    expect(error.message).toContain("verify the provider, commit its edits, and push");
    expect(error.errorData).toMatchObject({
      candidateDeclaresMethod: false,
      recovery: {
        kind: "inspect-or-publish-provider",
        repoPath: "workers/board-store",
      },
    });
  });
});
