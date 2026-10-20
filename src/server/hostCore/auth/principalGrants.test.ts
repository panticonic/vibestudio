import { describe, expect, it, vi } from "vitest";
import { grantClientPrincipal, type PrincipalGrantRequest } from "./principalGrants.js";

const request: PrincipalGrantRequest = {
  source: "clients/terminal-browser",
  buildKey: "build-1",
  executionDigest: "d".repeat(64),
  deviceId: "dev_one",
};

const attestation = {
  principalId: "client:browser:terminal:dev_one",
  deviceId: "dev_one",
  clientId: "browser",
  runtime: "terminal",
  source: "clients/terminal-browser",
  buildKey: "build-1",
  effectiveVersion: "ev-1",
  executionDigest: "d".repeat(64),
  authority: { requests: [], provides: [] },
  capabilities: ["device-session"],
};

function deps() {
  return {
    getServerId: () => "server",
    getServerBootId: () => "boot",
    attestClientPrincipal: vi.fn(async () => attestation),
    hub: {
      attestClientPrincipal: vi.fn(async () => undefined),
      mintClientCredential: vi.fn(async () => ({
        credentialId: "ccr_1",
        token: "clientcred:ccr_1:s",
      })),
    },
  };
}

describe("grantClientPrincipal", () => {
  it("fails closed outside the System workspace and without a hub", async () => {
    const { attestClientPrincipal: _attest, ...noAttester } = deps();
    await expect(grantClientPrincipal(noAttester, request)).rejects.toMatchObject({
      code: "PRINCIPAL_GRANTS_UNAVAILABLE",
    });
    const { hub: _hub, ...noHub } = deps();
    await expect(grantClientPrincipal(noHub, request)).rejects.toMatchObject({
      code: "PRINCIPAL_GRANTS_UNAVAILABLE",
    });
  });

  it("propagates the vetting refusal and attests and mints nothing", async () => {
    const d = deps();
    d.attestClientPrincipal.mockRejectedValue(
      new Error("build-1 is no longer the active build of clients/terminal-browser")
    );
    await expect(grantClientPrincipal(d, request)).rejects.toMatchObject({
      code: "PRINCIPAL_UNAVAILABLE",
      message: expect.stringContaining("no longer the active build"),
    });
    expect(d.hub.attestClientPrincipal).not.toHaveBeenCalled();
    expect(d.hub.mintClientCredential).not.toHaveBeenCalled();
  });

  it("propagates the hub's refusal to attest and mints nothing", async () => {
    const d = deps();
    d.hub.attestClientPrincipal.mockRejectedValue(new Error("only the System workspace attests"));
    await expect(grantClientPrincipal(d, request)).rejects.toMatchObject({
      code: "PRINCIPAL_UNAVAILABLE",
      message: expect.stringContaining("only the System workspace"),
    });
    expect(d.hub.mintClientCredential).not.toHaveBeenCalled();
  });

  it("attests the vetted build at the hub and binds the credential to the endpoint", async () => {
    const d = deps();
    await expect(
      grantClientPrincipal(d, { ...request, remoteDeviceKey: "e".repeat(64) })
    ).resolves.toEqual({
      credential: "clientcred:ccr_1:s",
      principalId: attestation.principalId,
      deviceId: "dev_one",
      serverId: "server",
      serverBootId: "boot",
    });
    expect(d.attestClientPrincipal).toHaveBeenCalledWith("dev_one", {
      source: request.source,
      buildKey: request.buildKey,
      executionDigest: request.executionDigest,
    });
    expect(d.hub.attestClientPrincipal).toHaveBeenCalledWith(attestation);
    expect(d.hub.mintClientCredential).toHaveBeenCalledWith({
      principalId: attestation.principalId,
      deviceKey: "e".repeat(64),
    });
  });

  it("mints an unbound credential for a loopback caller", async () => {
    const d = deps();
    await grantClientPrincipal(d, request);
    expect(d.hub.mintClientCredential).toHaveBeenCalledWith({
      principalId: attestation.principalId,
    });
  });
});
