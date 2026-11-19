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
      getClientMethodBridge: () => undefined,
      getUserConnections: (userId) =>
        userId === "alice"
          ? [
              {
                caller: { runtime: { id: "shell:alice", kind: "shell" } },
                userId,
                connectionId: "desktop",
                clientLabel: "Alice's desktop",
                clientPlatform: "desktop",
              },
              {
                caller: { runtime: { id: "headless:alice", kind: "headless" } },
                userId,
                connectionId: "desktop",
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
      getClientMethodBridge: () => undefined,
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
    const bootstrap = { call: vi.fn(), stream: vi.fn() };
    const workspace = { call, stream: vi.fn() };
    const getClientMethodBridge = vi.fn<
      Parameters<typeof createPhoneNativeEndpointService>[0]["getClientMethodBridge"]
    >(() => undefined);
    const service = createPhoneNativeEndpointService({
      getClientMethodBridge,
      getUserConnections: () => [
        {
          caller: { runtime: { id: "shell:phone", kind: "shell" } },
          userId: "alice",
          connectionId: "bootstrap",
          clientPlatform: "mobile",
        },
        {
          caller: { runtime: { id: "shell:phone", kind: "shell" } },
          userId: "alice",
          connectionId: "workspace",
          clientPlatform: "mobile",
        },
        {
          caller: { runtime: { id: "shell:other", kind: "shell" } },
          userId: "bob",
          connectionId: "other",
          clientPlatform: "mobile",
        },
      ],
      getClientBridge: () => bootstrap,
    });
    expect(
      await service.handler(context as never, "readiness", [{ deviceId: "other" }])
    ).toMatchObject({ status: "opening" });
    expect(call).not.toHaveBeenCalled();
    expect(
      await service.handler(context as never, "readiness", [{ deviceId: "phone" }])
    ).toMatchObject({ status: "opening", message: "Phone paired. Loading the workspace app…" });
    expect(call).not.toHaveBeenCalled();
    getClientMethodBridge.mockImplementation((_caller, id) =>
      id === "workspace" ? workspace : undefined
    );

    expect(
      await service.handler(context as never, "readiness", [{ deviceId: "phone" }])
    ).toMatchObject({ status: "ready" });
    expect(call).toHaveBeenCalledWith("shell:phone", "mobileWorkspace.readiness", []);
    expect(bootstrap.call).not.toHaveBeenCalled();
    expect(getClientMethodBridge).not.toHaveBeenCalledWith(
      "shell:other",
      "other",
      expect.anything()
    );
  });
});
