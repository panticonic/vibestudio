import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkspaceClient } from "./shellWorkspaceClient.js";
import type { RpcClient } from "@vibestudio/rpc";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRpc(): Pick<RpcClient, "call"> & { call: ReturnType<typeof vi.fn> } {
  return {
    call: vi.fn(),
  } as Pick<RpcClient, "call"> & { call: ReturnType<typeof vi.fn> };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorkspaceClient", () => {
  let rpc: ReturnType<typeof makeRpc>;
  let client: WorkspaceClient;

  beforeEach(() => {
    rpc = makeRpc();
    client = new WorkspaceClient(rpc);
  });

  describe("getActive()", () => {
    it("calls workspace.getActive RPC and returns workspace name", async () => {
      rpc.call.mockResolvedValueOnce("default");

      const result = await client.getActive();

      expect(rpc.call).toHaveBeenCalledWith("main", "workspace.getActive", []);
      expect(result).toBe("default");
    });
  });
});
