import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import {
  PhoneDeviceSchema,
  PhoneProvisioningIssueSchema,
  PhoneProvisioningResultSchema,
  phoneProvisioningMethods,
  type PhoneDeviceDiscovery,
  type PhoneInstallArgs,
  type PhoneOpenPairingArgs,
  type PhonePlatform,
} from "@vibestudio/service-schemas/phoneProvisioning";
import { z } from "zod";

interface ScriptResult {
  stdout: string;
  stderr: string;
}

const LocalDiscoverySchema = z.object({
  devices: z.array(PhoneDeviceSchema.omit({ providerId: true })),
  issues: z.array(PhoneProvisioningIssueSchema.omit({ providerId: true })),
});

export interface PhoneProvisioningServiceDeps {
  /** Physical checkout or app.asar.unpacked root used as the child-process cwd. */
  appRoot: string;
  appVersion: string;
  resolveScriptPath: (name: string) => string;
  hostPlatform?: NodeJS.Platform;
  runScript?: (
    name: string,
    args: string[],
    options?: { sensitive?: boolean }
  ) => Promise<ScriptResult>;
}

function defaultRunner(deps: PhoneProvisioningServiceDeps) {
  return async (name: string, args: string[], options: { sensitive?: boolean } = {}) =>
    await new Promise<ScriptResult>((resolve, reject) => {
      const script = deps.resolveScriptPath(name);
      const child = spawn(process.execPath, [script, ...args], {
        cwd: deps.appRoot,
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          VIBESTUDIO_APP_ROOT: deps.appRoot,
          VIBESTUDIO_APP_VERSION: deps.appVersion,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const append = (current: string, chunk: Buffer) =>
        (current + chunk.toString()).slice(-1024 * 1024);
      child.stdout.on("data", (chunk: Buffer) => (stdout = append(stdout, chunk)));
      child.stderr.on("data", (chunk: Buffer) => (stderr = append(stderr, chunk)));
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) resolve({ stdout, stderr });
        else {
          const detail = options.sensitive ? "" : `: ${(stderr || stdout).trim()}`;
          reject(new Error(`${name} exited ${code ?? signal}${detail}`));
        }
      });
    });
}

function jsonLine(stdout: string): unknown {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) continue;
    try {
      return JSON.parse(line);
    } catch {
      continue;
    }
  }
  throw new Error("Phone provisioning command returned no JSON result");
}

export function createPhoneProvisioningService(
  deps: PhoneProvisioningServiceDeps
): ServiceDefinition {
  const runScript = deps.runScript ?? defaultRunner(deps);
  const hostPlatform = deps.hostPlatform ?? process.platform;
  const platforms: PhonePlatform[] = hostPlatform === "darwin" ? ["android", "ios"] : ["android"];
  const sourcePlatforms = platforms.filter((platform) =>
    fs.existsSync(path.join(deps.appRoot, "apps", "mobile", platform))
  );
  const localProviderId = "desktop-local";

  async function discover(platform?: PhonePlatform): Promise<PhoneDeviceDiscovery> {
    const selected = platform ? [platform] : platforms;
    const devices: PhoneDeviceDiscovery["devices"] = [];
    const issues: PhoneDeviceDiscovery["issues"] = [];
    for (const candidate of selected) {
      try {
        const result = LocalDiscoverySchema.parse(
          jsonLine(
            (await runScript("mobile-device.mjs", ["devices", "--platform", candidate, "--json"]))
              .stdout
          )
        );
        devices.push(
          ...result.devices.map((device) => ({ ...device, providerId: localProviderId }))
        );
        issues.push(...result.issues.map((issue) => ({ ...issue, providerId: localProviderId })));
      } catch (error) {
        issues.push({
          providerId: localProviderId,
          code: "discovery-failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { devices, issues };
  }

  return {
    name: "desktopPhoneProvider",
    description: "Desktop-bound phone discovery, installation, and pairing launch",
    authority: { principals: ["host"] },
    methods: phoneProvisioningMethods,
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "providers":
          return [
            {
              providerId: localProviderId,
              label: "This desktop",
              hostPlatform,
              platforms,
              sourcePlatforms,
              appVersion: deps.appVersion,
            },
          ];
        case "devices": {
          const query = args[0] as { platform?: PhonePlatform } | undefined;
          return await discover(query?.platform);
        }
        case "install": {
          const input = args[0] as PhoneInstallArgs;
          const before = await discover(input.platform);
          const ready = before.devices.filter(
            (device) => device.ready && (!input.deviceId || device.deviceId === input.deviceId)
          );
          const compatibleDevice = ready.find((device) => device.compatibleAppInstalled);
          if (compatibleDevice) {
            return PhoneProvisioningResultSchema.parse({
              providerId: localProviderId,
              platform: input.platform,
              deviceId: compatibleDevice.deviceId,
              status: "already-compatible",
              message: "A compatible Vibestudio app is already installed.",
            });
          }
          const mode = input.mode ?? "auto";
          if (input.platform === "ios" && !sourcePlatforms.includes("ios")) {
            return {
              providerId: localProviderId,
              platform: "ios",
              ...(input.deviceId ? { deviceId: input.deviceId } : {}),
              status: "manual-action",
              message:
                "iOS installation requires a source checkout, Xcode, and an Apple development team.",
            };
          }
          if (mode === "source" && !sourcePlatforms.includes(input.platform)) {
            throw new Error(`A ${input.platform} source checkout is not available on this desktop`);
          }
          const installArgs = ["--platform", input.platform, "--launch"];
          if (input.deviceId) installArgs.push("--device", input.deviceId);
          if (mode === "source" || input.platform === "ios") installArgs.push("--from-source");
          await runScript("mobile-install.mjs", installArgs);
          return {
            providerId: localProviderId,
            platform: input.platform,
            ...(input.deviceId ? { deviceId: input.deviceId } : {}),
            status: "installed",
            message: "Vibestudio was installed and launched.",
          };
        }
        case "openPairing": {
          const input = args[0] as PhoneOpenPairingArgs;
          const commandArgs = [
            "connect",
            "--platform",
            input.platform,
            "--pair",
            input.pairUrl,
            "--json",
          ];
          if (input.deviceId) commandArgs.push("--device", input.deviceId);
          if (input.packageId) commandArgs.push("--package", input.packageId);
          if (input.bundleId) commandArgs.push("--bundle-id", input.bundleId);
          const result = jsonLine(
            (await runScript("mobile-device.mjs", commandArgs, { sensitive: true })).stdout
          );
          return PhoneProvisioningResultSchema.parse({
            ...(result as object),
            providerId: localProviderId,
          });
        }
        default:
          throw new Error(`Unknown phoneProvisioning method: ${method}`);
      }
    },
  };
}
