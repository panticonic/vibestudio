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
  type PhonePlatform,
  type PhoneProvisionArgs,
} from "@vibestudio/service-schemas/phoneProvisioning";
import { HubDeviceSchema } from "@vibestudio/service-schemas/hubControl";
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
  hubControlClient: {
    call(service: string, method: string, args: unknown[]): Promise<unknown>;
  };
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  pairingTimeoutMs?: number;
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
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const pairingTimeoutMs = deps.pairingTimeoutMs ?? 45_000;

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

  async function provision(input: PhoneProvisionArgs) {
    const before = await discover(input.platform);
    const ready = before.devices.filter(
      (device) => device.ready && (!input.deviceId || device.deviceId === input.deviceId)
    );
    if (ready.length === 0) {
      throw new Error("The selected phone is not connected, ready, and authorized");
    }
    if (!input.deviceId && ready.length > 1) {
      throw new Error("More than one phone is ready; select one before provisioning");
    }
    const selected = ready[0];
    if (!selected) throw new Error("No ready phone was selected");

    let installStatus: "installed" | "already-compatible" = "already-compatible";
    if (!selected.compatibleAppInstalled) {
      const mode = input.mode ?? "auto";
      if (mode === "source" && !sourcePlatforms.includes(input.platform)) {
        throw new Error(`A ${input.platform} source checkout is not available on this desktop`);
      }
      if (input.platform === "ios" && !sourcePlatforms.includes("ios")) {
        throw new Error(
          "iOS installation requires a source checkout, Xcode, and an Apple development team"
        );
      }
      const useSource =
        input.platform === "ios" ||
        mode === "source" ||
        (mode === "auto" && sourcePlatforms.includes(input.platform));
      const installArgs = ["--platform", input.platform, "--launch", "--device", selected.deviceId];
      if (useSource) installArgs.push("--from-source");
      await runScript("mobile-install.mjs", installArgs);
      installStatus = "installed";

      if (input.platform === "android") {
        const afterInstall = await discover("android");
        const installed = afterInstall.devices.find(
          (device) => device.deviceId === selected.deviceId
        );
        if (!installed?.compatibleAppInstalled) {
          throw new Error(
            "The Android app installed successfully but its version is not compatible with this desktop"
          );
        }
      }
    }

    const beforePairing = z
      .object({ devices: z.array(HubDeviceSchema) })
      .parse(await deps.hubControlClient.call("hubControl", "listDevices", []));
    const knownDeviceIds = new Set(beforePairing.devices.map((device) => device.deviceId));
    const invite = z
      .object({ pairing: z.object({ deepLink: z.string().min(1) }) })
      .parse(await deps.hubControlClient.call("hubControl", "pairDevice", [{}]));

    const connectArgs = [
      "connect",
      "--platform",
      input.platform,
      "--pair",
      invite.pairing.deepLink,
      "--device",
      selected.deviceId,
      "--json",
    ];
    await runScript("mobile-device.mjs", connectArgs, { sensitive: true });

    const deadline = now() + pairingTimeoutMs;
    while (now() < deadline) {
      const current = z
        .object({ devices: z.array(HubDeviceSchema) })
        .parse(await deps.hubControlClient.call("hubControl", "listDevices", []));
      const pairedDevice = current.devices.find(
        (device) => !device.revokedAt && !knownDeviceIds.has(device.deviceId)
      );
      if (pairedDevice) {
        return PhoneProvisioningResultSchema.parse({
          providerId: localProviderId,
          platform: input.platform,
          attachedDeviceId: selected.deviceId,
          installStatus,
          compatibleAppInstalled: true,
          pairingStatus: "paired",
          pairedDevice: {
            deviceId: pairedDevice.deviceId,
            label: pairedDevice.label,
            ...(pairedDevice.platform ? { platform: pairedDevice.platform } : {}),
            createdAt: pairedDevice.createdAt,
          },
        });
      }
      await sleep(500);
    }
    throw new Error(
      "The phone did not join the current account before the pairing invite timed out"
    );
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
        case "provision":
          return await provision(args[0] as PhoneProvisionArgs);
        default:
          throw new Error(`Unknown phoneProvisioning method: ${method}`);
      }
    },
  };
}
