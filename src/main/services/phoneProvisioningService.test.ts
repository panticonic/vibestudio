import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
import { createPhoneProvisioningService } from "./phoneProvisioningService.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sourceRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phone-provisioning-test-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "apps", "mobile", "android"), { recursive: true });
  return root;
}

function discovery(deviceId = "android-1", compatibleAppInstalled = false): string {
  return `${JSON.stringify({
    devices: [
      {
        platform: "android",
        deviceId,
        state: "device",
        kind: "physical",
        ready: true,
        installedApps: [],
        compatibleAppInstalled,
      },
    ],
    issues: [],
  })}\n`;
}

function hubControlClient() {
  let listCount = 0;
  return {
    call: vi.fn(async (_service: string, method: string) => {
      if (method === "pairDevice") {
        return {
          workspace: "current-workspace",
          pairing: { deepLink: "vibestudio://connect?test" },
        };
      }
      if (method === "listDevices") {
        listCount += 1;
        return {
          devices:
            listCount === 1
              ? []
              : [
                  {
                    deviceId: "paired-mobile",
                    userId: "user-1",
                    label: "Android phone",
                    platform: "android",
                    createdAt: 1,
                  },
                ],
        };
      }
      throw new Error(`Unexpected hub method ${method}`);
    }),
  };
}

describe("desktop phone provisioning service", () => {
  it("registers its aliased receiver methods from colocated semantic capabilities", () => {
    const definition = createPhoneProvisioningService({
      appRoot: "/nonexistent/vibestudio-test-root",
      appVersion: "test",
      workspaceName: "current-workspace",
      resolveScriptPath: (name) => name,
      runScript: async () => ({ stdout: "", stderr: "" }),
      hubControlClient: hubControlClient(),
    });
    const dispatcher = new ServiceDispatcher();

    expect(() => dispatcher.registerService(definition)).not.toThrow();
  });

  it("resolves auto install to a locally producible source artifact in a source checkout", async () => {
    let discoveries = 0;
    const runScript = vi.fn(async (name: string, args: string[]) => {
      const isDiscovery = name === "mobile-device.mjs" && args[0] === "devices";
      if (isDiscovery) discoveries += 1;
      return {
        stdout: isDiscovery ? discovery("android-1", discoveries > 1) : "",
        stderr: "",
      };
    });
    const hub = hubControlClient();
    const definition = createPhoneProvisioningService({
      appRoot: sourceRoot(),
      appVersion: "0.1.5",
      workspaceName: "current-workspace",
      resolveScriptPath: (name) => name,
      runScript,
      hubControlClient: hub,
    });

    const result = await definition.handler({} as never, "provision", [
      { platform: "android", deviceId: "android-1", mode: "auto" },
    ]);

    expect(runScript).toHaveBeenCalledWith("mobile-install.mjs", [
      "--platform",
      "android",
      "--launch",
      "--device",
      "android-1",
      "--from-source",
    ]);
    expect(result).toMatchObject({
      installStatus: "installed",
      pairingStatus: "paired",
      workspace: "current-workspace",
      pairedDevice: { deviceId: "paired-mobile" },
    });
    expect(hub.call).toHaveBeenCalledWith("hubControl", "pairDevice", [
      { workspace: "current-workspace" },
    ]);
  });

  it("honors an explicit release request even when mobile source is available", async () => {
    let discoveries = 0;
    const runScript = vi.fn(async (name: string, args: string[]) => {
      const isDiscovery = name === "mobile-device.mjs" && args[0] === "devices";
      if (isDiscovery) discoveries += 1;
      return {
        stdout: isDiscovery ? discovery("android-1", discoveries > 1) : "",
        stderr: "",
      };
    });
    const definition = createPhoneProvisioningService({
      appRoot: sourceRoot(),
      appVersion: "0.1.5",
      workspaceName: "current-workspace",
      resolveScriptPath: (name) => name,
      runScript,
      hubControlClient: hubControlClient(),
    });

    await definition.handler({} as never, "provision", [
      { platform: "android", deviceId: "android-1", mode: "release" },
    ]);

    expect(runScript).toHaveBeenCalledWith("mobile-install.mjs", [
      "--platform",
      "android",
      "--launch",
      "--device",
      "android-1",
    ]);
  });
});
