import { consumePhoneSetup } from "@vibestudio/service-schemas/clients/phoneSetupStream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { processGroupAlive } from "../../../scripts/owned-process-tree.mjs";
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

function hubControlClient(platform: "android" | "ios" = "android") {
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
                    label: "Test phone",
                    platform,
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
  it.skipIf(process.platform === "win32")(
    "joins detached native descendants when setup is cancelled",
    async () => {
      const root = sourceRoot();
      const receipt = path.join(root, "owned-native.json");
      const binding = pathToFileURL(path.resolve("scripts/owned-process-tree.mjs")).href;
      fs.writeFileSync(
        path.join(root, "mobile-device.mjs"),
        `
      import { bindProcessLifetimeToParent } from ${JSON.stringify(binding)};
      bindProcessLifetimeToParent(); process.channel.unref();
      if (process.argv[2] === 'devices') console.log(${JSON.stringify(discovery())});
    `
      );
      fs.writeFileSync(
        path.join(root, "mobile-install.mjs"),
        `
      import { spawn } from 'node:child_process';
      import { writeFileSync, renameSync } from 'node:fs';
      import { bindProcessLifetimeToParent } from ${JSON.stringify(binding)};
      bindProcessLifetimeToParent(); process.channel.unref();
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"], {detached:true,stdio:['ignore','pipe','ignore']});
      child.stdout.once('data', () => {
        writeFileSync(${JSON.stringify(receipt + ".pending")}, JSON.stringify({leader:process.pid,descendant:child.pid}));
        renameSync(${JSON.stringify(receipt + ".pending")}, ${JSON.stringify(receipt)});
      });
      setInterval(() => {}, 1000);
    `
      );
      const definition = createPhoneProvisioningService({
        appRoot: root,
        appVersion: "0.1.5",
        workspaceName: "current-workspace",
        resolveScriptPath: (name) => path.join(root, name),
        hubControlClient: hubControlClient(),
      });
      // Observe the native child's published readiness before starting setup.
      // Slow process creation is valid; the test runner bounds the investigation.
      const watcher = fs.watch(root);
      const ready = new Promise<void>((resolve, reject) => {
        watcher.on("error", reject);
        watcher.on("change", (_event, filename) => {
          if (filename === path.basename(receipt)) resolve();
        });
      });
      const response = (await definition.handler({} as never, "provision", [
        { platform: "android", mode: "release" },
      ])) as Response;
      try {
        await ready;
        const owned = JSON.parse(fs.readFileSync(receipt, "utf8")) as {
          leader: number;
          descendant: number;
        };
        expect(processGroupAlive(owned.descendant)).toBe(true);
        await response.body!.cancel();
        expect(processGroupAlive(owned.leader)).toBe(false);
        expect(processGroupAlive(owned.descendant)).toBe(false);
      } finally {
        watcher.close();
        await response.body!.cancel();
        if (fs.existsSync(receipt)) {
          const owned = JSON.parse(fs.readFileSync(receipt, "utf8")) as {
            leader: number;
            descendant: number;
          };
          for (const pid of [owned.leader, owned.descendant]) {
            try {
              process.kill(-pid, "SIGKILL");
            } catch {
              /* Already retired. */
            }
          }
        }
      }
    },
    15_000
  );
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

  it.each(["simulator", "physical"] as const)(
    "preserves an iOS %s target through workspace phone setup",
    async (kind) => {
      const root = sourceRoot();
      const project = path.join(root, "apps/mobile/ios/Vibestudio.xcodeproj/project.pbxproj");
      fs.mkdirSync(path.dirname(project), { recursive: true });
      fs.writeFileSync(project, "");
      let discoveries = 0;
      const runScript = vi.fn(async (name: string, args: string[]) => {
        const isDiscovery = name === "mobile-device.mjs" && args[0] === "devices";
        if (isDiscovery) discoveries += 1;
        return {
          stdout: isDiscovery
            ? JSON.stringify({
                devices: [
                  {
                    platform: "ios",
                    deviceId: "ios-1",
                    state: "connected",
                    kind,
                    ready: true,
                    installedApps: [],
                    compatibleAppInstalled: discoveries > 1,
                  },
                ],
                issues: [],
              })
            : "",
          stderr: "",
        };
      });
      const definition = createPhoneProvisioningService({
        appRoot: root,
        appVersion: "0.1.5",
        workspaceName: "current-workspace",
        hostPlatform: "darwin",
        resolveScriptPath: (name) => name,
        runScript,
        hubControlClient: hubControlClient("ios"),
      });
      const result = await provision(definition, { platform: "ios", deviceId: "ios-1" });
      expect(runScript).toHaveBeenCalledWith(
        "mobile-install.mjs",
        [
          "--platform",
          "ios",
          "--launch",
          "--device",
          "ios-1",
          ...(kind === "simulator" ? ["--simulator"] : []),
          "--from-source",
        ],
        { signal: expect.any(AbortSignal) }
      );
      expect(result).toMatchObject({ installStatus: "installed", pairingStatus: "paired" });
    }
  );

  it("pairs an already-compatible iOS app without requiring a source checkout or rebuilding", async () => {
    const runScript = vi.fn(async (name: string, args: string[]) => ({
      stdout:
        name === "mobile-device.mjs" && args[0] === "devices"
          ? JSON.stringify({
              devices: [
                {
                  platform: "ios",
                  deviceId: "phone",
                  state: "connected",
                  kind: "physical",
                  ready: true,
                  installedApps: [{ packageId: "app.vibestudio.mobile", versionName: "0.1.5" }],
                  compatibleAppInstalled: true,
                },
              ],
              issues: [],
            })
          : "",
      stderr: "",
    }));
    const definition = createPhoneProvisioningService({
      appRoot: sourceRoot(),
      appVersion: "0.1.5",
      workspaceName: "current-workspace",
      hostPlatform: "darwin",
      resolveScriptPath: (name) => name,
      runScript,
      hubControlClient: hubControlClient("ios"),
    });
    const result = await provision(definition, { platform: "ios", deviceId: "phone" });
    expect(runScript.mock.calls.some(([name]) => name === "mobile-install.mjs")).toBe(false);
    expect(result).toMatchObject({ installStatus: "already-compatible", pairingStatus: "paired" });
  });
});
