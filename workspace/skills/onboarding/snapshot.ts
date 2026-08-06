import { callMain, gatewayConfig } from "@workspace/runtime";
import {
  onboardingCatalog,
  type OnboardingRole,
  type OnboardingScope,
  type OnboardingTier,
  type SetupAction,
  type SetupPresentationState,
} from "./catalog";
import { createStatusAdapters, type CapabilityOnboardingStatusAdapter } from "./status";

interface OnboardingHostTopologySnapshot {
  devices: {
    availability: "available" | "unknown";
    pairedDeviceCount: number;
    thisDevicePaired: boolean;
  };
  remote: {
    availability: "available" | "unknown";
    route: "local" | "remote";
    workspaceCount: number;
  };
}

interface AuthorityPreflightResult {
  decision: "allowed" | "acquirable" | "denied";
}

interface SkillCatalogEntry {
  skillPath: string;
}

export interface SetupCapabilitySnapshot {
  id: string;
  state: SetupPresentationState;
  verification?: "unverified" | "checking" | "verified" | "failed";
  summary: string;
  scope: OnboardingScope;
  tier: OnboardingTier;
  attention: "none" | "optional" | "blocking";
  nextAction?: SetupAction;
  rawStage?: string;
  observedAt: string;
}

export interface ComposeOnboardingSnapshotOptions {
  verifyCapabilityId?: "connection.google-workspace" | "connection.github";
}

export interface OnboardingSnapshotDependencies {
  adapters?: Readonly<Record<string, CapabilityOnboardingStatusAdapter>>;
  readHostTopology?: () => Promise<OnboardingHostTopologySnapshot>;
  hasSkill?: (skillPath: string) => Promise<boolean>;
  now?: () => Date;
}

function currentConnectionRoute(): "local" | "remote" {
  try {
    const hostname = new URL(gatewayConfig.serverUrl).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
      ? "local"
      : "remote";
  } catch {
    return "remote";
  }
}

async function canReadHubControl(method: "listDevices" | "listWorkspaces"): Promise<boolean> {
  try {
    const result = await callMain<AuthorityPreflightResult>("authority.preflight", {
      service: "hubControl",
      method,
      args: [],
    });
    return result.decision === "allowed";
  } catch {
    return false;
  }
}

async function readHostTopology(): Promise<OnboardingHostTopologySnapshot> {
  // These are intentionally optional setup reads. Preflight avoids sending a
  // gated call that is guaranteed to fail (and would be noisy over Electron's
  // IPC handler) while preserving the honest Unknown state until the user has
  // explicitly granted access through the relevant workflow.
  const [canReadDevices, canReadWorkspaces] = await Promise.all([
    canReadHubControl("listDevices"),
    canReadHubControl("listWorkspaces"),
  ]);
  const [devices, workspaces] = await Promise.all([
    canReadDevices
      ? callMain<{ devices: unknown[] }>("hubControl.listDevices").catch(() => null)
      : Promise.resolve(null),
    canReadWorkspaces
      ? callMain<unknown[]>("hubControl.listWorkspaces").catch(() => null)
      : Promise.resolve(null),
  ]);
  const deviceList = devices?.devices ?? null;
  const workspaceList = workspaces;
  return {
    devices: {
      availability: deviceList ? "available" : "unknown",
      pairedDeviceCount: deviceList?.length ?? 0,
      thisDevicePaired: deviceList !== null && deviceList.length > 0,
    },
    remote: {
      availability: workspaceList ? "available" : "unknown",
      route: currentConnectionRoute(),
      workspaceCount: workspaceList?.length ?? 0,
    },
  };
}

async function hasSkill(skillPath: string): Promise<boolean> {
  const entries = await callMain<SkillCatalogEntry[]>("workspace.listSkills");
  return entries.some((entry) => entry.skillPath === skillPath);
}

function nextAction(
  state: SetupPresentationState,
  role: OnboardingRole,
  actions: Readonly<Partial<Record<SetupAction, unknown>>>
): SetupAction | undefined {
  if (state === "connected-unverified" && actions.check) return "check";
  if (state === "needs-attention" && actions.repair) return "repair";
  if (state === "in-progress" && actions.resume) return "resume";
  if (state === "connected") return actions.change ? "change" : undefined;
  if (state === "configured") {
    if (actions.change) return "change";
    return role === "migration" && actions.setup ? "setup" : undefined;
  }
  if (state === "using-defaults" && actions.change) return "change";
  if (state === "unavailable") return undefined;
  if (actions.setup) return "setup";
  if (actions.change) return "change";
  return undefined;
}

function unknownSnapshot(
  id: string,
  scope: OnboardingScope,
  tier: OnboardingTier,
  observedAt: string,
  actions: Readonly<Partial<Record<SetupAction, unknown>>>
): SetupCapabilitySnapshot {
  return {
    id,
    state: "unknown",
    summary: "Status could not be read right now.",
    scope,
    tier,
    attention: "none",
    nextAction: actions.setup ? "setup" : actions.change ? "change" : undefined,
    rawStage: "read-error",
    observedAt,
  };
}

function hostSnapshots(
  host: OnboardingHostTopologySnapshot,
  mobileOwnerAvailable: boolean,
  observedAt: string
): SetupCapabilitySnapshot[] {
  const device = onboardingCatalog.find((entry) => entry.id === "connection.device")!;
  const remote = onboardingCatalog.find((entry) => entry.id === "connection.remote-server")!;
  const deviceActions = device.actions ?? {};
  const remoteActions = remote.actions ?? {};

  const deviceSnapshot: SetupCapabilitySnapshot = !mobileOwnerAvailable
    ? {
        id: device.id,
        state: "unavailable",
        summary:
          "Device setup is unavailable because its base capability owner could not be loaded.",
        scope: device.scope,
        tier: device.tier,
        attention: "blocking",
        rawStage: "owner-unavailable",
        observedAt,
      }
    : host.devices.availability === "unknown"
      ? unknownSnapshot(device.id, device.scope, device.tier, observedAt, deviceActions)
      : {
          id: device.id,
          state: host.devices.thisDevicePaired ? "connected" : "not-configured",
          summary: host.devices.thisDevicePaired
            ? host.devices.pairedDeviceCount === 1
              ? "This device is paired."
              : `${host.devices.pairedDeviceCount} devices are paired.`
            : "This device is not paired.",
          scope: device.scope,
          tier: device.tier,
          attention: "none",
          nextAction: host.devices.thisDevicePaired ? "change" : "setup",
          rawStage: host.devices.thisDevicePaired ? "paired" : "not-paired",
          observedAt,
        };

  const remoteSnapshot: SetupCapabilitySnapshot =
    host.remote.availability === "unknown"
      ? unknownSnapshot(remote.id, remote.scope, remote.tier, observedAt, remoteActions)
      : {
          id: remote.id,
          state: host.remote.route === "remote" ? "connected" : "not-configured",
          summary:
            host.remote.route === "remote"
              ? `Connected to a remote server with ${host.remote.workspaceCount} visible workspace${host.remote.workspaceCount === 1 ? "" : "s"}.`
              : `Using the local server; ${host.remote.workspaceCount} workspace${host.remote.workspaceCount === 1 ? "" : "s"} available.`,
          scope: remote.scope,
          tier: remote.tier,
          attention: "none",
          nextAction: host.remote.route === "remote" ? "change" : "setup",
          rawStage: host.remote.route,
          observedAt,
        };

  return [deviceSnapshot, remoteSnapshot];
}

export async function composeOnboardingSnapshot(
  options: ComposeOnboardingSnapshotOptions = {},
  dependencies: OnboardingSnapshotDependencies = {}
): Promise<SetupCapabilitySnapshot[]> {
  const observedAt = (dependencies.now?.() ?? new Date()).toISOString();
  const adapters = dependencies.adapters ?? createStatusAdapters();
  const directEntries = onboardingCatalog.filter((entry) => entry.setup && entry.tier === "direct");

  const direct = await Promise.all(
    directEntries.map(async (entry): Promise<SetupCapabilitySnapshot> => {
      const actions = entry.actions ?? {};
      const adapter = adapters[entry.setup!.statusAdapter];
      if (!adapter) {
        return unknownSnapshot(entry.id, entry.scope, entry.tier, observedAt, actions);
      }
      try {
        const result = await adapter({
          verify: options.verifyCapabilityId === entry.id,
        });
        return {
          id: entry.id,
          ...result,
          scope: entry.scope,
          tier: entry.tier,
          nextAction: nextAction(result.state, entry.role, actions),
          observedAt,
        };
      } catch {
        return unknownSnapshot(entry.id, entry.scope, entry.tier, observedAt, actions);
      }
    })
  );

  let host: SetupCapabilitySnapshot[];
  try {
    const [topology, mobileOwnerAvailable] = await Promise.all([
      (dependencies.readHostTopology ?? readHostTopology)(),
      (dependencies.hasSkill ?? hasSkill)("skills/phone-setup/SKILL.md"),
    ]);
    host = hostSnapshots(topology, mobileOwnerAvailable, observedAt);
  } catch {
    host = onboardingCatalog
      .filter((entry) => entry.setup && entry.tier === "host-topology")
      .map((entry) =>
        unknownSnapshot(entry.id, entry.scope, entry.tier, observedAt, entry.actions ?? {})
      );
  }

  const byId = new Map([...direct, ...host].map((entry) => [entry.id, entry]));
  return onboardingCatalog.flatMap((entry) => {
    const snapshot = byId.get(entry.id);
    return snapshot ? [snapshot] : [];
  });
}
