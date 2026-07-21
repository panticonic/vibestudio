import { describe, expect, it, vi } from "vitest";
import type { HubProcessLeaseRecord } from "@vibestudio/shared/centralData";
import type { CliCredentials } from "./credentialStore.js";
import {
  localHubIdentityDatabasePath,
  resolveLocalHubControlTransport,
} from "./localHubTransport.js";

const serverId = `srv_${"S".repeat(24)}`;
const hubBootId = `boot_${"H".repeat(24)}`;
const credentials = {
  serverId,
} as CliCredentials;
const lease: HubProcessLeaseRecord = {
  ownerBootId: hubBootId,
  gatewayPort: 46247,
  pid: 1234,
  acquiredAt: 1,
  heartbeatAt: 900,
  expiresAt: 2_000,
};

function health(overrides: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      ok: true,
      mode: "hub",
      serverId,
      serverBootId: hubBootId,
      gatewayPort: lease.gatewayPort,
      pid: lease.pid,
      ...overrides,
    })
  );
}

describe("local hub control resolution", () => {
  it("uses the hub identity override for isolated local servers", () => {
    expect(
      localHubIdentityDatabasePath({
        VIBESTUDIO_IDENTITY_DB_PATH: "/tmp/vibestudio-system-tests-identity.db",
      })
    ).toBe("/tmp/vibestudio-system-tests-identity.db");
  });

  it("returns only the fenced machine-control endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => health());

    await expect(
      resolveLocalHubControlTransport(credentials, {
        now: () => 1_000,
        readLease: () => lease,
        fetch: fetchMock,
      })
    ).resolves.toEqual({ serverUrl: "http://127.0.0.1:46247" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not infer a local endpoint without a live matching lease", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(
      resolveLocalHubControlTransport(credentials, {
        now: () => 2_000,
        readLease: () => lease,
        fetch: fetchMock,
      })
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(health({ serverId: `srv_${"X".repeat(24)}` }));
    await expect(
      resolveLocalHubControlTransport(credentials, {
        now: () => 1_000,
        readLease: () => lease,
        fetch: fetchMock,
      })
    ).resolves.toBeNull();
  });

  it("treats an unreachable or malformed health endpoint as non-local", async () => {
    const unreachable = vi.fn<typeof fetch>(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      resolveLocalHubControlTransport(credentials, {
        now: () => 1_000,
        readLease: () => lease,
        fetch: unreachable,
      })
    ).resolves.toBeNull();

    await expect(
      resolveLocalHubControlTransport(credentials, {
        now: () => 1_000,
        readLease: () => lease,
        fetch: vi.fn<typeof fetch>(async () => new Response("{}")),
      })
    ).resolves.toBeNull();
  });
});
