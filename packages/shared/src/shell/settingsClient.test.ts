import { describe, it, expect, vi, beforeEach } from "vitest";
import { SettingsClient } from "./settingsClient.js";
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

describe("SettingsClient", () => {
  let rpc: ReturnType<typeof makeRpc>;
  let client: SettingsClient;

  beforeEach(() => {
    rpc = makeRpc();
    client = new SettingsClient(rpc);
  });

  describe("getData()", () => {
    it("calls settings.getData RPC and returns settings data", async () => {
      const data = { providers: [], models: {} };
      rpc.call.mockResolvedValueOnce(data);

      const result = await client.getData();

      expect(rpc.call).toHaveBeenCalledWith("main", "settings.getData", []);
      expect(result).toEqual(data);
    });
  });
});
