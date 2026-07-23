import { describe, expect, it, vi } from "vitest";
import { createPhoneProvisioningProxyService } from "./phoneProvisioningService.js";

const context = (userId: string) =>
  ({
    caller: {
      runtime: { id: `agent:${userId}`, kind: "agent" },
      subject: { userId },
    },
  }) as never;

describe("phoneProvisioning proxy", () => {
  it("carries semantic capabilities with its reusable method contract", () => {
    const definition = createPhoneProvisioningProxyService({
      getUserConnections: () => [],
      getClientBridge: () => undefined,
    });

    expect(definition.methods["providers"]?.capability).toBe("mobile.devices.read");
    expect(definition.methods["devices"]?.capability).toBe("mobile.devices.read");
    expect(definition.methods["install"]?.capability).toBe("mobile.install");
    expect(definition.methods["openPairing"]?.capability).toBe("mobile.pair");
  });

  it("only exposes desktops belonging to the authenticated account", async () => {
    const call = vi.fn(async () => [
      {
        providerId: "desktop-local",
        label: "This desktop",
        hostPlatform: "linux",
        platforms: ["android"],
        sourcePlatforms: [],
        appVersion: "1.0.0",
      },
    ]);
    const definition = createPhoneProvisioningProxyService({
      getUserConnections: (userId) => [
        {
          userId,
          caller: { runtime: { id: `shell:${userId}`, kind: "shell" } },
          clientPlatform: "desktop",
          clientLabel: `${userId} laptop`,
        },
      ],
      getClientBridge: () => ({ call }),
    });

    await expect(definition.handler(context("alice"), "providers", [])).resolves.toEqual([
      expect.objectContaining({ providerId: "shell:alice", label: "alice laptop" }),
    ]);
    expect(call).toHaveBeenCalledWith("shell:alice", "desktopPhoneProvider.providers", []);
  });

  it("requires an explicit provider when several desktops are connected", async () => {
    const definition = createPhoneProvisioningProxyService({
      getUserConnections: (userId) =>
        ["one", "two"].map((id) => ({
          userId,
          caller: { runtime: { id: `shell:${id}`, kind: "shell" } },
          clientPlatform: "desktop",
        })),
      getClientBridge: () => ({ call: vi.fn() }),
    });
    await expect(
      definition.handler(context("alice"), "install", [{ platform: "android" }])
    ).rejects.toThrow("choose a phone provider");
  });
});
