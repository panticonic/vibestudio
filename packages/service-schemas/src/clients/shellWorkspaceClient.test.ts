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

      expect(rpc.call).toHaveBeenCalledOnce();
      const [target, method, args, options] = rpc.call.mock.calls[0]!;
      expect(target).toBe("main");
      expect(method).toMatchObject({ name: "workspace.getActive" });
      expect(method).toEqual(
        expect.objectContaining({
          invoke: expect.any(Function),
          parseArgs: expect.any(Function),
        })
      );
      expect(args).toEqual([]);
      expect(options).toBeUndefined();
      expect(result).toBe("default");
    });
  });
});
