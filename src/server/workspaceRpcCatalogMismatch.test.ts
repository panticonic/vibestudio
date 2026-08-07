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
      declaredMethods: ["listBoard", "addCard", "listBoard"],
    });

    expect(error).toMatchObject({
      code: WORKSPACE_RPC_METHOD_UNDECLARED,
      errorKind: "application",
      errorData: {
        code: WORKSPACE_RPC_METHOD_UNDECLARED,
        serviceName: "board-store",
        method: "importBoard",
        declaredMethods: ["addCard", "listBoard"],
        safeActions: [
          "open-live-service-docs",
          "use-declared-method",
          "publish-or-activate-provider-build",
        ],
      },
    });
    expect(error.message).toContain("publish or activate that exact provider build");
  });
});
