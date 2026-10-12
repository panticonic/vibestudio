import { describe, expect, it, vi } from "vitest";
import { grantAppPrincipal, type PrincipalGrantRequest } from "./principalGrants.js";

const request: PrincipalGrantRequest = {
  principal: "terminal-app",
  source: null,
  deviceId: "dev_one",
  subject: { userId: "usr_root", handle: "root" },
  issuedBy: "shell:dev_one",
};

const baseDeps = {
  getServerId: () => "server",
  getServerBootId: () => "boot",
  getWorkspaceId: () => "workspace",
};

describe("grantAppPrincipal", () => {
  it("fails closed when device-scoped app principals are not configured", async () => {
    const registerDevicePrincipal = vi.fn();
    await expect(
      grantAppPrincipal({ ...baseDeps, registerDevicePrincipal }, request)
    ).rejects.toMatchObject({ code: "PRINCIPAL_GRANTS_UNAVAILABLE" });
    await expect(
      grantAppPrincipal({ ...baseDeps, connectionGrants: { grant: vi.fn() } }, request)
    ).rejects.toMatchObject({ code: "PRINCIPAL_GRANTS_UNAVAILABLE" });
    expect(registerDevicePrincipal).not.toHaveBeenCalled();
  });

  it("does not consult mobile readiness for a terminal principal", async () => {
    const ensureMobileAppReady = vi.fn(async () => ({ ready: false }));
    const grant = vi.fn();
    await expect(
      grantAppPrincipal(
        {
          ...baseDeps,
          connectionGrants: { grant },
          ensureMobileAppReady,
          registerDevicePrincipal: async () => null,
        },
        request
      )
    ).rejects.toMatchObject({
      code: "PRINCIPAL_UNAVAILABLE",
      message: expect.stringContaining("vibestudio terminal"),
    });
    expect(ensureMobileAppReady).not.toHaveBeenCalled();
    expect(grant).not.toHaveBeenCalled();
  });
});
