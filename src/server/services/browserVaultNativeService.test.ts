import { describe, expect, it, vi } from "vitest";
import { createBrowserVaultNativeService } from "./browserVaultNativeService.js";

const hostContext = {
  caller: {
    runtime: { id: "main", kind: "server" },
    hostOriginated: true,
    subject: { userId: "alice", handle: "alice" },
  },
};

const shellContext = {
  caller: {
    runtime: { id: "shell:desktop-1", kind: "shell" },
    subject: { userId: "alice", handle: "alice" },
  },
};

describe("browser vault native service", () => {
  it("admits the product host and authenticated shell using a server-derived object key", async () => {
    const dispatch = vi.fn(async () => [{ id: 7, origin_url: "https://example.com" }]);
    const service = createBrowserVaultNativeService({
      doDispatch: { dispatch } as never,
      workspaceId: "workspace-1",
    });

    expect(service.authority).toEqual({ principals: ["host", "user"] });
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
    await expect(
      service.handler(shellContext as never, "getPasswordForSite", ["https://example.com"])
    ).resolves.toEqual([{ id: 7, origin_url: "https://example.com" }]);
  });

  it.each(["electron-main", "headless-host", "shell:desktop-1"])(
    "admits the desktop console principal %s",
    async (callerId) => {
      const dispatch = vi.fn(async () => []);
      const service = createBrowserVaultNativeService({
        doDispatch: { dispatch } as never,
        workspaceId: "workspace-1",
      });

      await expect(
        service.handler(
          {
            caller: {
              runtime: { id: callerId, kind: "shell" },
              subject: { userId: "alice", handle: "alice" },
            },
          } as never,
          "listCookieOrigins",
          []
        )
      ).resolves.toEqual([]);
    }
  );

  it("rejects userland runtimes even when they carry the same human subject", async () => {
    const service = createBrowserVaultNativeService({
      doDispatch: { dispatch: vi.fn() } as never,
      workspaceId: "workspace-1",
    });
    await expect(
      service.handler(
        {
          caller: {
            runtime: { id: "app:@workspace-apps/shell", kind: "app" },
            subject: { userId: "alice", handle: "alice" },
          },
        } as never,
        "listCookieOrigins",
        []
      )
    ).rejects.toThrow(/product host or authenticated shell/);
  });

  it("publishes no agent-facing method", () => {
    const service = createBrowserVaultNativeService({
      doDispatch: { dispatch: vi.fn() } as never,
      workspaceId: "workspace-1",
    });
    for (const method of Object.values(service.methods)) {
      expect(method.authority).toEqual({ principals: ["host", "user"] });
      expect(method.agentFacing).toBe(false);
      expect(method.tier?.residency).toBe("native-effect");
    }
  });
});
