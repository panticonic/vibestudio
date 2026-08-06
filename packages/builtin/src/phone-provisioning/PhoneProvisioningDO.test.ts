import { describe, expect, it, vi } from "vitest";
import { createTestDO } from "@vibestudio/durable/test-utils";
import { rpcExposedMethodNames } from "@vibestudio/rpc";
import { phoneProvisioningMethods } from "@vibestudio/service-schemas/phoneProvisioning";
import { PhoneProvisioningDO } from "./PhoneProvisioningDO.js";

async function phone() {
  const fixture = await createTestDO(PhoneProvisioningDO, {
    WORKER_SOURCE: "vibestudio/internal",
    WORKER_CLASS_NAME: "PhoneProvisioningDO",
    __objectKey: "workspace",
  });
  return fixture;
}

describe("PhoneProvisioningDO", () => {
  it("exposes exactly the typed builtin contract", async () => {
    const { instance } = await phone();
    const methods = [...rpcExposedMethodNames(instance)].filter(
      (method) => method !== "durableWorkCapabilities"
    );
    expect(methods.sort()).toEqual(Object.keys(phoneProvisioningMethods).sort());
  });

  it("selects desktop transport in builtin code and rewrites provider identity", async () => {
    const { instance, callAs } = await phone();
    const rpcCall = vi.fn(async (_target: string, method: string) => {
      if (method === "connectedClientTransport.list") {
        return [
          {
            clientId: "shell:desktop",
            label: "My desktop",
            platform: "desktop",
            runtimeKind: "shell",
          },
          {
            clientId: "shell:mobile",
            label: "Phone",
            platform: "mobile",
            runtimeKind: "shell",
          },
        ];
      }
      return [
        {
          providerId: "local",
          label: "Native provider",
          hostPlatform: "linux",
          platforms: ["android"],
          sourcePlatforms: ["android"],
          appVersion: "1.0.0",
        },
      ];
    });
    Object.defineProperty(instance, "rpc", {
      value: { call: rpcCall },
      configurable: true,
    });

    await expect(
      callAs({ callerId: "panel:alice", callerKind: "panel", userId: "alice" }, "providers")
    ).resolves.toEqual([
      expect.objectContaining({
        providerId: "shell:desktop",
        label: "My desktop",
      }),
    ]);
    expect(rpcCall).toHaveBeenLastCalledWith("main", "connectedClientTransport.invoke", [
      {
        clientId: "shell:desktop",
        method: "desktopPhoneProvider.providers",
        args: [],
      },
    ]);
  });
});
