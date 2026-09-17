import { describe, expect, it, vi } from "vitest";
import { createPhoneNativeEndpointService } from "./phoneNativeEndpointService.js";

const context = {
  caller: {
    runtime: {
      id: "do:workers/phone-provisioning:PhoneProvisioningDO:workspace-phone-provisioning",
      kind: "do",
    },
    code: {
      callerId: "do:workers/phone-provisioning:PhoneProvisioningDO:workspace-phone-provisioning",
      callerKind: "do",
      repoPath: "workers/phone-provisioning",
      effectiveVersion: "ev-phone",
    },
    codeApproved: true,
    subject: { userId: "system", handle: "system" },
  },
  authorizingCaller: {
    runtime: { id: "agent:alice", kind: "agent" },
    subject: { userId: "alice", handle: "alice" },
  },
};

describe("phone native endpoint", () => {
  it("exposes only typed phone calls to desktops on the initiating user's account", async () => {
    const call = vi.fn(async () => ({ ok: true }));
    const service = createPhoneNativeEndpointService({
      hasClientMethod: () => true,
      getUserConnections: (userId) =>
        userId === "alice"
          ? [
              {
                caller: { runtime: { id: "shell:alice", kind: "shell" } },
                userId,
                clientLabel: "Alice's desktop",
                clientPlatform: "desktop",
              },
              {
                caller: { runtime: { id: "headless:alice", kind: "headless" } },
                userId,
                clientLabel: "Not a desktop shell",
                clientPlatform: "desktop",
              },
            ]
          : [],
      getClientBridge: (clientId) =>
        clientId === "shell:alice" ? { call, stream: vi.fn() } : undefined,
    });

    await expect(service.handler(context as never, "desktops", [])).resolves.toEqual([
      { clientId: "shell:alice", label: "Alice's desktop", platform: "desktop" },
    ]);
    await expect(
      service.handler(context as never, "devices", [
        { clientId: "shell:alice", query: { platform: "android" } },
      ])
    ).resolves.toEqual({ ok: true });
    expect(call).toHaveBeenCalledWith("shell:alice", "desktopPhoneProvider.devices", [
      { platform: "android" },
    ]);
    await expect(
      service.handler(context as never, "provision", [
        { clientId: "shell:bob", input: { platform: "android" } },
      ])
    ).rejects.toThrow("no longer connected");
  });

  it("rejects unapproved or differently sourced code before account routing", async () => {
    const service = createPhoneNativeEndpointService({
      hasClientMethod: () => true,
      getUserConnections: () => [],
      getClientBridge: () => undefined,
    });
    await expect(
      service.handler(
        {
          ...context,
          caller: {
            ...context.caller,
            codeApproved: undefined,
          },
        } as never,
        "desktops",
        []
      )
    ).rejects.toThrow("exact approved Base phone provider");
  });
  it("checks only the exact mobile connection on the initiating account", async () => {
    const call = vi.fn(async () => ({ status: "ready", message: "Workspace ready" }));
    const hasClientMethod = vi.fn(() => false);
    const service = createPhoneNativeEndpointService({
      hasClientMethod,
      getUserConnections: () => [
        {
          caller: { runtime: { id: "shell:phone", kind: "shell" } },
          userId: "alice",
          clientPlatform: "mobile",
        },
        {
          caller: { runtime: { id: "shell:other", kind: "shell" } },
          userId: "bob",
          clientPlatform: "mobile",
        },
      ],
      getClientBridge: () => ({ call, stream: vi.fn() }),
    });
    expect(
      await service.handler(context as never, "readiness", [{ deviceId: "other" }])
    ).toMatchObject({ status: "opening" });
    expect(call).not.toHaveBeenCalled();
    expect(
      await service.handler(context as never, "readiness", [{ deviceId: "phone" }])
    ).toMatchObject({ status: "opening", message: "Phone paired. Loading the workspace app…" });
    expect(call).not.toHaveBeenCalled();
    hasClientMethod.mockReturnValue(true);

    expect(
      await service.handler(context as never, "readiness", [{ deviceId: "phone" }])
    ).toMatchObject({ status: "ready" });
    expect(call).toHaveBeenCalledWith("shell:phone", "mobileWorkspace.readiness", []);
  });
});
