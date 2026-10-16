import { describe, expect, it, vi } from "vitest";
import { grantClientPrincipal, type PrincipalGrantRequest } from "./principalGrants.js";

const request: PrincipalGrantRequest = {
  source: "clients/terminal-browser",
  buildKey: "build-1",
  executionDigest: "digest-1",
  deviceId: "dev_one",
  subject: { userId: "usr_root", handle: "root" },
  issuedBy: "shell:dev_one",
};

const baseDeps = {
  getServerId: () => "server",
  getServerBootId: () => "boot",
  getWorkspaceId: () => "workspace",
};

const principal = {
  principalId: "client:browser:terminal:dev_one",
  id: "browser",
  runtime: "terminal" as const,
  source: "clients/terminal-browser",
  buildKey: "build-1",
  effectiveVersion: "ev-1",
};

describe("grantClientPrincipal", () => {
  it("fails closed when client principals are not configured", async () => {
    const grantPrincipal = vi.fn();
    await expect(
      grantClientPrincipal({ ...baseDeps, grantClientPrincipal: grantPrincipal }, request)
    ).rejects.toMatchObject({ code: "PRINCIPAL_GRANTS_UNAVAILABLE" });
    await expect(
      grantClientPrincipal({ ...baseDeps, connectionGrants: { grant: vi.fn() } }, request)
    ).rejects.toMatchObject({ code: "PRINCIPAL_GRANTS_UNAVAILABLE" });
    expect(grantPrincipal).not.toHaveBeenCalled();
  });

  it("propagates the registry's refusal and mints no grant", async () => {
    const grant = vi.fn();
    await expect(
      grantClientPrincipal(
        {
          ...baseDeps,
          connectionGrants: { grant },
          grantClientPrincipal: async () => {
            throw new Error("build-1 is no longer the active build of clients/terminal-browser");
          },
        },
        request
      )
    ).rejects.toMatchObject({
      code: "PRINCIPAL_UNAVAILABLE",
      message: expect.stringContaining("no longer the active build"),
    });
    expect(grant).not.toHaveBeenCalled();
  });

  it("asks for the exact build the host verified and binds the grant to the endpoint", async () => {
    const grant = vi.fn(() => ({ token: "grant-token", expiresAt: 1234 }));
    const grantPrincipal = vi.fn(async () => principal);
    await expect(
      grantClientPrincipal(
        { ...baseDeps, connectionGrants: { grant }, grantClientPrincipal: grantPrincipal },
        { ...request, remoteEndpointId: "endpoint-1" }
      )
    ).resolves.toEqual({
      connectionGrant: "grant-token",
      expiresAt: 1234,
      principalId: principal.principalId,
      deviceId: "dev_one",
      serverId: "server",
      serverBootId: "boot",
      workspaceId: "workspace",
    });
    expect(grantPrincipal).toHaveBeenCalledWith("dev_one", {
      source: "clients/terminal-browser",
      buildKey: "build-1",
      executionDigest: "digest-1",
    });
    expect(grant).toHaveBeenCalledWith(principal.principalId, "shell:dev_one", {
      subject: request.subject,
      remoteEndpointId: "endpoint-1",
    });
  });
});
