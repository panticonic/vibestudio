import {
  phoneSetupStream,
  type PhoneSetupEvent,
} from "@vibestudio/service-schemas/clients/phoneSetupStream";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { finished } from "node:stream/promises";
import { OwnedProcessGroup } from "@vibestudio/shared/ownedProcessGroup";
import { captureOwnedProcessIdentity } from "@vibestudio/shared/ownedProcessIdentity";
import { terminateOwnedProcessTree } from "../../../scripts/owned-process-tree.mjs";
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
import {
  HubPairingOutcomeSchema,
  type HubPairingOutcome,
} from "@vibestudio/service-schemas/hubControl";
import { z } from "zod";
import {
  hasCompleteAndroidSourceProject,
  mobileCliEnvironment,
} from "../../../scripts/cli/lib/mobile-native-android.mjs";

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
  /** Exact workspace selected by the desktop session hosting this provider. */
  workspaceName: string;
  resolveScriptPath: (name: string) => string;
  hostPlatform?: NodeJS.Platform;
  runScript?: (
    name: string,
    args: string[],
    options?: { sensitive?: boolean; signal?: AbortSignal }
  ) => Promise<ScriptResult>;
  hubControlClient: {
    call(service: string, method: string, args: unknown[]): Promise<unknown>;
  };
}

/**
 * Join the hub-owned invite's lifecycle. Aborting cancels the invite, which
 * settles this same wait, so an aborted setup still returns only after the
 * invite is terminal.
 */
async function awaitPairingOrCancel(
  client: PhoneProvisioningServiceDeps["hubControlClient"],
  code: string,
  signal: AbortSignal,
  cancelInvite: () => Promise<void>
): Promise<HubPairingOutcome> {
  let onAbort: (() => void) | undefined;
  try {
    const outcome = await new Promise<HubPairingOutcome>((resolve, reject) => {
      client
        .call("hubControl", "awaitPairing", [{ code }])
        .then((value) => HubPairingOutcomeSchema.parse(value))
        .then(resolve, reject);
      onAbort = () => void cancelInvite().catch(reject);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    signal.throwIfAborted();
    return outcome;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function defaultRunner(deps: PhoneProvisioningServiceDeps) {
  return async (
    name: string,
    args: string[],
    options: { sensitive?: boolean; signal?: AbortSignal } = {}
  ): Promise<ScriptResult> => {
    options.signal?.throwIfAborted();
    const script = deps.resolveScriptPath(name);
    const child = spawn(process.execPath, [script, ...args], {
      cwd: deps.appRoot,
      env: mobileCliEnvironment(deps.appRoot, deps.appVersion),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    // Install listeners before observing ownership, including a refused spawn.
    const completion = new Promise<ScriptResult>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const append = (current: string, chunk: Buffer) =>
        (current + chunk.toString()).slice(-1024 * 1024);
      child.stdout!.on("data", (chunk: Buffer) => (stdout = append(stdout, chunk)));
      child.stderr!.on("data", (chunk: Buffer) => (stderr = append(stderr, chunk)));
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) resolve({ stdout, stderr });
        else {
          const detail = options.sensitive ? "" : `: ${(stderr || stdout).trim()}`;
          reject(new Error(`${name} exited ${code ?? signal}${detail}`));
        }
      });
    });
    // Join the actual process exit and captured output independently. Node's
    // aggregate `close` can remain pending after an explicit IPC revocation,
    // even when the process was reaped and both output streams ended.
    const settled = Promise.all([
      completion,
      finished(child.stdout!, { cleanup: true }),
      finished(child.stderr!, { cleanup: true }),
    ]);
    // Capture the root while it is alive. Cancellation must snapshot and join
    // the complete ancestry before the kernel reparents detached descendants.
    const identity = child.pid === undefined ? null : captureOwnedProcessIdentity(child.pid);
    const owner = identity ? OwnedProcessGroup.adopt(identity) : null;
    // Start retirement from the abort edge itself: `settled` cannot complete
    // until the child exits, and waiting until `finally` would deadlock.
    let abortRetirement: Promise<void> | null = null;
    const retireOnAbort = () => {
      if (child.pid === undefined || !identity) return;
      abortRetirement ??= terminateOwnedProcessTree(child.pid, {
        identity,
        termTimeoutMs: 5_000,
        killTimeoutMs: 5_000,
      }).then((result) => {
        if (!result.gone) throw new Error(result.detail ?? "Owned command tree did not retire");
      });
      void abortRetirement.catch(() => {
        // The same idempotent retirement is awaited below, where its error is
        // returned through the command boundary rather than as an unhandled
        // abort-listener rejection.
      });
    };
    options.signal?.addEventListener("abort", retireOnAbort, { once: true });
    if (options.signal?.aborted) retireOnAbort();
    try {
      const [result] = await settled;
      options.signal?.throwIfAborted();
      return result;
    } catch (error) {
      if (options.signal?.aborted) options.signal.throwIfAborted();
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", retireOnAbort);
      if (abortRetirement) await abortRetirement;
      else await owner?.retire();
    }
  };
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
    platform === "android"
      ? hasCompleteAndroidSourceProject(deps.appRoot)
      : fs.existsSync(
          path.join(
            deps.appRoot,
            "apps",
            "mobile",
            "ios",
            "Vibestudio.xcodeproj",
            "project.pbxproj"
          )
        )
  );
  const localProviderId = "desktop-local";

  async function discover(
    platform?: PhonePlatform,
    signal?: AbortSignal
  ): Promise<PhoneDeviceDiscovery> {
    const selected = platform ? [platform] : platforms;
    const devices: PhoneDeviceDiscovery["devices"] = [];
    const issues: PhoneDeviceDiscovery["issues"] = [];
    for (const candidate of selected) {
      try {
        const result = LocalDiscoverySchema.parse(
          jsonLine(
            (
              await runScript("mobile-device.mjs", ["devices", "--platform", candidate, "--json"], {
                signal,
              })
            ).stdout
          )
        );
        devices.push(
          ...result.devices.map((device) => ({ ...device, providerId: localProviderId }))
        );
        issues.push(...result.issues.map((issue) => ({ ...issue, providerId: localProviderId })));
      } catch (error) {
        signal?.throwIfAborted();
        issues.push({
          providerId: localProviderId,
          code: "discovery-failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { devices, issues };
  }

  async function prepare(input: Pick<PhoneProvisionArgs, "platform">, signal?: AbortSignal) {
    await runScript("mobile-device.mjs", ["prepare", "--platform", input.platform, "--json"], {
      signal,
    });
    return { ready: true as const };
  }

  async function provision(
    input: PhoneProvisionArgs,
    emit: (event: PhoneSetupEvent) => void,
    signal: AbortSignal
  ) {
    emit({
      type: "progress",
      phase: "preparing-tools",
      message: "Preparing phone tools on your desktop…",
    });
    await prepare(input, signal);
    signal.throwIfAborted();
    emit({ type: "progress", phase: "checking-device", message: "Checking your phone…" });
    const before = await discover(input.platform, signal);
    const ready = before.devices.filter(
      (device) => device.ready && (!input.deviceId || device.deviceId === input.deviceId)
    );
    if (ready.length === 0) {
      const device = input.deviceId
        ? before.devices.find((candidate) => candidate.deviceId === input.deviceId)
        : before.devices.length === 1
          ? before.devices[0]
          : undefined;
      if (device?.state === "unauthorized") {
        throw new Error("Unlock the phone and accept its USB debugging prompt, then try again.");
      }
      if (device?.kind === "emulator" || device?.kind === "simulator") {
        throw new Error("Wait for the emulator to finish starting, then try again.");
      }
      if (device?.state === "offline") {
        throw new Error(
          "The phone is offline. Unlock it and reconnect its USB cable, then try again."
        );
      }
      if (before.issues.length > 0) {
        throw new Error(
          before.issues
            .map((issue) => [issue.message, issue.action].filter(Boolean).join(" "))
            .join("\n")
        );
      }
      throw new Error(
        input.platform === "android"
          ? "No ready phone was found. Connect and unlock your phone, enable USB debugging, then check for devices again."
          : "No ready iPhone was found. Connect and unlock your phone, trust this Mac, then check for devices again."
      );
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
      if (selected.kind === "simulator") installArgs.push("--simulator");
      if (useSource) installArgs.push("--from-source");
      emit({
        type: "progress",
        phase: "installing",
        message: useSource
          ? "Building and installing the phone app. The first build can take several minutes…"
          : "Downloading and installing the phone app…",
      });
      await runScript("mobile-install.mjs", installArgs, { signal });
      installStatus = "installed";

      {
        const afterInstall = await discover(input.platform, signal);
        const installed = afterInstall.devices.find(
          (device) => device.deviceId === selected.deviceId
        );
        if (!installed?.compatibleAppInstalled) {
          throw new Error(
            `The ${input.platform === "ios" ? "iOS" : "Android"} app installed successfully but its version is not compatible with this desktop`
          );
        }
      }
    }

    signal.throwIfAborted();
    emit({
      type: "progress",
      phase: "pairing",
      message: "Connecting your phone securely. Keep it unlocked…",
    });
    const invite = z
      .object({
        pairing: z.object({ code: z.string().min(1), deepLink: z.string().min(1) }),
      })
      .parse(await deps.hubControlClient.call("hubControl", "pairDevice", []));

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
    let inviteCancellation: Promise<void> | undefined;
    const cancelInvite = (): Promise<void> =>
      (inviteCancellation ??= Promise.resolve()
        .then(() =>
          deps.hubControlClient.call("hubControl", "cancelPairing", [{ code: invite.pairing.code }])
        )
        .then((value) => z.object({ cancelled: z.boolean() }).parse(value))
        .then(() => undefined));
    let outcome: HubPairingOutcome;
    try {
      await runScript("mobile-device.mjs", connectArgs, { sensitive: true, signal });

      // The hub settles this wait on the invite's own lifecycle: redemption,
      // protocol expiry, or cancellation (which aborting setup requests).
      outcome = await awaitPairingOrCancel(
        deps.hubControlClient,
        invite.pairing.code,
        signal,
        cancelInvite
      );
    } catch (error) {
      // The invite is hub-owned, so retire it if connecting failed before the
      // phone redeemed it. This also covers cancellation during the local CLI
      // step, before an awaitPairing RPC exists to join.
      try {
        await cancelInvite();
      } catch (cancelError) {
        throw new AggregateError(
          [error, cancelError],
          "Phone setup failed and its pairing invite could not be retired",
          { cause: error }
        );
      }
      throw error;
    }
    if (outcome.status !== "paired") {
      throw new Error(
        outcome.status === "expired"
          ? "The phone did not join the current account before the pairing invite expired"
          : "The pairing invite was cancelled before the phone joined"
      );
    }
    const pairedDevice = outcome.device;
    return PhoneProvisioningResultSchema.parse({
      providerId: input.providerId ?? localProviderId,
      platform: input.platform,
      workspace: deps.workspaceName,
      attachedDeviceId: selected.deviceId,
      installStatus,
      compatibleAppInstalled: true,
      pairingStatus: "paired",
      workspaceStatus: "opening",
      pairedDevice: {
        deviceId: pairedDevice.deviceId,
        label: pairedDevice.label,
        ...(pairedDevice.platform ? { platform: pairedDevice.platform } : {}),
        createdAt: pairedDevice.createdAt,
      },
    });
  }

  return {
    name: "desktopPhoneProvider",
    description: "Desktop-bound phone discovery, installation, and pairing launch",
    authority: { principals: ["host"] },
    methods: {
      providers: phoneProvisioningMethods.providers,
      devices: phoneProvisioningMethods.devices,
      prepare: phoneProvisioningMethods.prepare,
      provision: phoneProvisioningMethods.provision,
    },
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
        case "prepare":
          return prepare(args[0] as PhoneProvisionArgs);
        case "provision":
          return phoneSetupStream(async (emit, signal) => {
            const result = await provision(args[0] as PhoneProvisionArgs, emit, signal);
            emit({ type: "paired", result });
          });
        default:
          throw new Error(`Unknown phoneProvisioning method: ${method}`);
      }
    },
  };
}
