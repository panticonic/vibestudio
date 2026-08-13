import { describe, expect, it, vi } from "vitest";
import { createBrowserVaultNativeService } from "./browserVaultNativeService.js";

const hostContext = {
  caller: {
    runtime: { id: "main", kind: "host" },
    subject: { userId: "alice", handle: "alice" },
  },
};

describe("browser vault native service", () => {
  it("is host-only and derives the protected object key from the authenticated context", async () => {
    const dispatch = vi.fn(async () => [{ id: 7, origin_url: "https://example.com" }]);
    const service = createBrowserVaultNativeService({
      doDispatch: { dispatch } as never,
      workspaceId: "workspace-1",
    });

    expect(service.authority).toEqual({ principals: ["host"] });
    await expect(
      service.handler(hostContext as never, "getPasswordForSite", ["https://example.com"])
    ).resolves.toEqual([{ id: 7, origin_url: "https://example.com" }]);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "vibestudio/internal",
        className: "BrowserVaultDO",
        objectKey: expect.any(String),
      }),
      "getPasswordForSite",
      "https://example.com"
    );
  });

  it("publishes no agent-facing method", () => {
    const service = createBrowserVaultNativeService({
      doDispatch: { dispatch: vi.fn() } as never,
      workspaceId: "workspace-1",
    });
    for (const method of Object.values(service.methods)) {
      expect(method.authority).toEqual({ principals: ["host"] });
      expect(method.agentFacing).toBe(false);
      expect(method.tier?.residency).toBe("native-effect");
    }
  });
});
