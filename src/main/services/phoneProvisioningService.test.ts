import { consumePhoneSetup } from "@vibestudio/service-schemas/clients/phoneSetupStream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
import { createPhoneProvisioningService } from "./phoneProvisioningService.js";

async function provision(
  definition: ReturnType<typeof createPhoneProvisioningService>,
  input: object
) {
  return consumePhoneSetup(
    (await definition.handler({} as never, "provision", [input])) as Response
  );
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sourceRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phone-provisioning-test-"));
  roots.push(root);
  for (const relative of [
    "apps/mobile/android/gradlew",
    "apps/mobile/package.json",
    "apps/mobile/index.js",
    "node_modules/react-native/package.json",
  ]) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "");
  }
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
  it.each([
    { state: "unauthorized", kind: "physical", expected: "accept its USB debugging prompt" },
    { state: "offline", kind: "physical", expected: "reconnect its USB cable" },
    { state: "offline", kind: "emulator", expected: "emulator to finish starting" },
  ])(
    "explains recovery for a $state $kind before creating an invite",
    async ({ state, kind, expected }) => {
      const hub = hubControlClient();
      const runScript = vi.fn(async () => ({
        stdout: JSON.stringify({
          devices: [
            {
              platform: "android",
              deviceId: "android-1",
              state,
              kind,
              ready: false,
              installedApps: [],
              compatibleAppInstalled: false,
            },
          ],
          issues: [],
        }),
        stderr: "",
      }));
      const definition = createPhoneProvisioningService({
        appRoot: "/nonexistent/vibestudio-test-root",
        appVersion: "0.1.34",
        workspaceName: "current-workspace",
        resolveScriptPath: (name) => name,
        runScript,
        hubControlClient: hub,
      });
      await expect(provision(definition, { platform: "android" })).rejects.toThrow(expected);
      expect(runScript).toHaveBeenCalledTimes(2);
      expect(hub.call).not.toHaveBeenCalled();
    }
  );

  it("preserves discovery failures instead of asking the user to reconnect a phone", async () => {
    const hub = hubControlClient();
    const definition = createPhoneProvisioningService({
      appRoot: "/nonexistent/vibestudio-test-root",
      appVersion: "0.1.34",
      workspaceName: "current-workspace",
      resolveScriptPath: (name) => name,
      runScript: async () => ({
        stdout: JSON.stringify({
          devices: [],
          issues: [
            {
              code: "tooling-unavailable",
              message: "Android tools are missing.",
              action: "Install platform-tools on this desktop.",
            },
          ],
        }),
        stderr: "",
      }),
      hubControlClient: hub,
    });
    await expect(provision(definition, { platform: "android" })).rejects.toThrow(
      "Android tools are missing. Install platform-tools on this desktop."
    );
    expect(hub.call).not.toHaveBeenCalled();
  });

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

    const result = await provision(definition, {
      platform: "android",
      deviceId: "android-1",
      mode: "auto",
    });

    expect(runScript).toHaveBeenCalledWith(
      "mobile-install.mjs",
      ["--platform", "android", "--launch", "--device", "android-1", "--from-source"],
      { signal: expect.any(AbortSignal) }
    );
    expect(result).toMatchObject({
      installStatus: "installed",
      pairingStatus: "paired",
      workspaceStatus: "opening",
      workspace: "current-workspace",
      pairedDevice: { deviceId: "paired-mobile" },
    });
    expect(hub.call).toHaveBeenCalledWith("hubControl", "pairDevice", []);
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

    await provision(definition, { platform: "android", deviceId: "android-1", mode: "release" });

    expect(runScript).toHaveBeenCalledWith(
      "mobile-install.mjs",
      ["--platform", "android", "--launch", "--device", "android-1"],
      { signal: expect.any(AbortSignal) }
    );
  });
});
