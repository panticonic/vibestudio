import { describe, expect, it, vi } from "vitest";
import { createShellBrowserPrivacyService } from "./shellBrowserPrivacyService.js";

const shellContext = {
  caller: {
    runtime: { id: "shell:dev_aaaaaaaaaaaaaaaaaaaaaaaa", kind: "shell" },
    subject: { userId: "alice", handle: "alice" },
  },
};

describe("paired-shell browser privacy direct service", () => {
  it("derives the vault from the authenticated human shell and returns bounded pages", async () => {
    const dispatch = vi.fn(async () => ({ items: [{ id: 7 }], total: 1 }));
    const service = createShellBrowserPrivacyService({
      doDispatch: { dispatch } as never,
      workspaceId: "workspace-1",
    });

    await expect(
      service.handler(shellContext as never, "listPasswordSummariesPage", [0, 25])
    ).resolves.toEqual({ items: [{ id: 7 }], total: 1 });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ className: "BrowserVaultDO", objectKey: expect.any(String) }),
      "listPasswordSummariesPage",
      0,
      25
    );
  });

  it("rejects panels, system subjects, and caller-chosen identities", async () => {
    const service = createShellBrowserPrivacyService({
      doDispatch: { dispatch: vi.fn() } as never,
      workspaceId: "workspace-1",
    });
    await expect(
      service.handler(
        {
          caller: { runtime: { id: "panel:one", kind: "panel" }, subject: { userId: "alice" } },
        } as never,
        "listPasswordSummariesPage",
        [0, 25]
      )
    ).rejects.toThrow(/authenticated human shell/);
    await expect(
      service.handler(
        {
          caller: { runtime: { id: "app:one", kind: "app" }, subject: { userId: "alice" } },
        } as never,
        "listPasswordSummariesPage",
        [0, 25]
      )
    ).rejects.toThrow(/authenticated human shell/);
    await expect(
      service.handler(
        {
          caller: { runtime: { id: "electron-main", kind: "shell" }, subject: { userId: "alice" } },
        } as never,
        "listPasswordSummariesPage",
        [0, 25]
      )
    ).rejects.toThrow(/authenticated human shell/);
    await expect(
      service.handler(
        {
          caller: { runtime: { id: "shell:dev_x", kind: "shell" }, subject: { userId: "system" } },
        } as never,
        "listPasswordSummariesPage",
        [0, 25]
      )
    ).rejects.toThrow(/authenticated human shell/);
  });

  it("counts site passwords without returning protected rows", async () => {
    const dispatch = vi.fn(async () => [{ password: "one" }, { password: "two" }]);
    const service = createShellBrowserPrivacyService({
      doDispatch: { dispatch } as never,
      workspaceId: "workspace-1",
    });
    await expect(
      service.handler(shellContext as never, "getPasswordCountForSite", [
        "https://example.com/path?q=1",
      ])
    ).resolves.toEqual({ origin: "https://example.com", passwordCount: 2 });
    expect(dispatch).toHaveBeenCalledWith(
      expect.any(Object),
      "getPasswordForSite",
      "https://example.com"
    );
  });

  it("publishes only the exact paired-shell allowlist", () => {
    const service = createShellBrowserPrivacyService({
      doDispatch: { dispatch: vi.fn() } as never,
      workspaceId: "workspace-1",
    });
    expect(Object.keys(service.methods).sort()).toEqual(
      [
        "addFormFillValue",
        "clearAllCookies",
        "clearCookiesForOrigin",
        "clearFormFillValues",
        "deleteFormFillValue",
        "deletePassword",
        "endBrowserSession",
        "getCookieSiteSummary",
        "getNeverSaveOriginsPage",
        "getPasswordCountForSite",
        "listCookieOriginsPage",
        "listFormFillValuesPage",
        "listPasswordSummariesPage",
        "removeNeverSave",
        "updateFormFillValue",
      ].sort()
    );
    for (const method of Object.values(service.methods)) {
      expect(method.authority).toEqual({ principals: ["user"] });
      expect(method.agentFacing).toBe(false);
      expect(method.tier?.tier).toBe("open");
    }
  });
});
