import {
  HubPairingInviteSchema,
  HubReadyPayloadSchema,
  HubWorkspaceRouteSchema,
  type HubPairingInvite,
} from "@vibestudio/service-schemas/hubControl";
import { selectedWorkspacePath } from "@vibestudio/shared/connect";
import {
  loadCliCredentials,
  saveCliCredentials,
  type CliCredentials,
} from "../cli/credentialStore.js";
import { RpcClient } from "../cli/rpcClient.js";
import { ConnectionError } from "../cli/output.js";

/**
 * Pairing authenticates the device to an account. The account's own workspaces
 * are created after redemption, and this development client selects one
 * explicitly below.
 */
type PairingResponse = {
  deviceId: string;
  refreshToken: string;
};

export type DevCliBootstrapResult =
  | { status: "existing"; workspaceName: string; workspaceId: string }
  | { status: "paired"; workspaceName: string; workspaceId: string }
  | { status: "invite-required" };

/** Which of the account's private workspaces this device opens. */
export type DevCliWorkspaceSelection = "personal" | "system";

export interface DevCliPairingSponsor {
  gatewayUrl: string;
  serverId: string;
  workspaceId: string;
  workspaceName: string;
  deviceId: string;
  refreshToken: string;
}

interface BootstrapDeps {
  fetch?: typeof fetch;
  rpcClient?: (credential: { url: string; deviceId: string; refreshToken: string }) => {
    call(method: string, args?: unknown[]): Promise<unknown>;
    close(): Promise<void>;
  };
}

function pairingResponse(value: unknown): PairingResponse {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as Partial<PairingResponse>).deviceId !== "string" ||
    typeof (value as Partial<PairingResponse>).refreshToken !== "string"
  ) {
    throw new Error("Local development pairing returned a malformed device credential");
  }
  return value as PairingResponse;
}

async function postPairing(
  gatewayUrl: string,
  invite: HubPairingInvite,
  fetchImpl: typeof fetch = fetch
): Promise<PairingResponse> {
  const response = await fetchImpl(new URL("/_r/s/auth/complete-pairing", gatewayUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: invite.code,
      label: "Vibestudio development CLI",
      platform: process.platform,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    const message =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { error?: unknown }).error
        : undefined;
    throw new Error(
      typeof message === "string"
        ? `Local development pairing failed: ${message}`
        : `Local development pairing failed with HTTP ${response.status}`
    );
  }
  return pairingResponse(body);
}

function existingCredential(
  serverId: string,
  credentialFile: string | undefined
): CliCredentials | null {
  const existing = loadCliCredentials(credentialFile);
  if (!existing) return null;
  if (existing.serverId !== serverId) {
    throw new Error(
      `Instance CLI credential targets server ${existing.serverId}, ` +
        `but the live hub is ${serverId}`
    );
  }
  return existing;
}

async function routeWorkspace(
  input: {
    gatewayUrl: string;
    deviceId: string;
    refreshToken: string;
    workspaceId: string;
  },
  deps: BootstrapDeps
): Promise<ReturnType<typeof HubWorkspaceRouteSchema.parse>> {
  const createRpc = deps.rpcClient ?? ((credential) => new RpcClient(credential));
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const rpc = createRpc({
      url: input.gatewayUrl,
      deviceId: input.deviceId,
      refreshToken: input.refreshToken,
    });
    try {
      return HubWorkspaceRouteSchema.parse(
        await rpc.call("hubControl.routeWorkspace", [{ workspaceId: input.workspaceId }])
      );
    } catch (error) {
      if (!(error instanceof ConnectionError) || attempt > 0) throw error;
    } finally {
      await rpc.close();
    }
  }
  throw new Error("Development CLI could not route its workspace");
}

/**
 * Prepare the account's private workspaces, exactly as a desktop or mobile
 * client does when it pairs.
 *
 * Pairing has no navigation target. This development client explicitly opens
 * System by default because that is where the account's tooling lives; product
 * desktop startup independently focuses Personal.
 */
async function ensureUserWorkspaces(
  input: { gatewayUrl: string; deviceId: string; refreshToken: string },
  deps: BootstrapDeps
): Promise<{ personal: { workspaceId: string }; system: { workspaceId: string } }> {
  const createRpc = deps.rpcClient ?? ((credential) => new RpcClient(credential));
  // A cold hub can refuse the first call while it is still starting, which is
  // why routing already retries once; preparing the account is no different.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const rpc = createRpc({
      url: input.gatewayUrl,
      deviceId: input.deviceId,
      refreshToken: input.refreshToken,
    });
    try {
      return (await rpc.call("hubControl.ensureUserWorkspaces", [])) as {
        personal: { workspaceId: string };
        system: { workspaceId: string };
      };
    } catch (error) {
      if (!(error instanceof ConnectionError) || attempt > 0) throw error;
    } finally {
      await rpc.close();
    }
  }
  throw new Error("Development CLI could not prepare its account workspaces");
}

async function reconcileExistingCredential(
  input: { gatewayUrl: string; serverId: string; workspaceId: string },
  existing: CliCredentials,
  credentialFile: string | undefined,
  deps: BootstrapDeps
): Promise<DevCliBootstrapResult> {
  if (existing.kind !== "device") {
    throw new Error("The instance CLI profile is not a paired device credential");
  }
  const route = await routeWorkspace(
    {
      gatewayUrl: input.gatewayUrl,
      deviceId: existing.deviceId,
      refreshToken: existing.refreshToken,
      workspaceId: input.workspaceId,
    },
    deps
  );
  if (route.serverId !== input.serverId || route.workspaceId !== input.workspaceId) {
    throw new Error("Development hub routed a different workspace than the instance selected");
  }
  saveCliCredentials(
    {
      ...existing,
      url: new URL(selectedWorkspacePath(route.workspace), input.gatewayUrl).toString(),
      workspaceId: route.workspaceId,
      workspaceName: route.workspace,
      serverId: route.serverId,
    },
    credentialFile
  );
  return { status: "existing", workspaceName: route.workspace, workspaceId: route.workspaceId };
}

async function pairWithInvite(
  input: {
    gatewayUrl: string;
    serverId: string;
    invite: HubPairingInvite;
    workspace?: DevCliWorkspaceSelection;
  },
  credentialFile: string | undefined,
  deps: BootstrapDeps = {}
): Promise<DevCliBootstrapResult> {
  if (input.invite.serverId !== input.serverId) {
    throw new Error("Development CLI invite targets a different hub");
  }
  const device = await postPairing(input.gatewayUrl, input.invite, deps.fetch);
  const pair = await ensureUserWorkspaces(
    {
      gatewayUrl: input.gatewayUrl,
      deviceId: device.deviceId,
      refreshToken: device.refreshToken,
    },
    deps
  );
  // System is where the account's tooling lives and what a desktop client
  // routes its own connection to, so a headless development CLI and an
  // attached client see the same workspace by default. Personal is a real
  // choice, not a fallback: it installs different units, so it is the only
  // place cases that need those units can run.
  const workspaceId = pair[input.workspace ?? "system"].workspaceId;
  const route = await routeWorkspace(
    {
      gatewayUrl: input.gatewayUrl,
      deviceId: device.deviceId,
      refreshToken: device.refreshToken,
      workspaceId,
    },
    deps
  );
  if (route.serverId !== input.serverId || route.workspaceId !== workspaceId) {
    throw new Error("Development hub routed a different workspace than the pairing selected");
  }

  const credentials: CliCredentials = {
    schemaVersion: 5,
    kind: "device",
    transport: "local",
    url: new URL(selectedWorkspacePath(route.workspace), input.gatewayUrl).toString(),
    workspaceId: route.workspaceId,
    workspaceName: route.workspace,
    serverId: route.serverId,
    deviceId: device.deviceId,
    refreshToken: device.refreshToken,
    pairedAt: Date.now(),
  };
  saveCliCredentials(credentials, credentialFile);
  return { status: "paired", workspaceName: route.workspace, workspaceId: route.workspaceId };
}

/**
 * Give a source-server instance its own CLI device over the loopback topology.
 *
 * This is the same one-time root pairing and route contract used by remote
 * clients, transported over the hub's loopback HTTP ingress. The resulting
 * credential remains instance-scoped and all later CLI calls use ordinary
 * authenticated routing.
 */
export async function bootstrapInstanceCli(
  rawReady: unknown,
  options: {
    credentialFile?: string;
    workspace?: DevCliWorkspaceSelection;
  } & BootstrapDeps = {}
): Promise<DevCliBootstrapResult> {
  const ready = HubReadyPayloadSchema.parse(rawReady);
  const existing = existingCredential(ready.serverId, options.credentialFile);
  if (existing) {
    // Public readiness deliberately omits private workspaces. Authenticate and
    // route the saved identity; neither a public listing nor a reused display
    // name may retarget this device's workspace.
    return reconcileExistingCredential(
      {
        gatewayUrl: ready.gatewayUrl,
        serverId: ready.serverId,
        workspaceId: existing.workspaceId,
      },
      existing,
      options.credentialFile,
      options
    );
  }
  if (!ready.rootInvite) return { status: "invite-required" };
  return pairWithInvite(
    {
      gatewayUrl: ready.gatewayUrl,
      serverId: ready.serverId,
      invite: ready.rootInvite,
      ...(options.workspace ? { workspace: options.workspace } : {}),
    },
    options.credentialFile,
    options
  );
}

/**
 * Add the instance CLI as another device of an already-paired development
 * desktop. The sponsor authenticates through the ordinary device flow and
 * mints the same account-bound invite exposed by `hubControl.pairDevice`.
 */
export async function bootstrapInstanceCliFromDevice(
  sponsor: DevCliPairingSponsor,
  options: { credentialFile?: string } & BootstrapDeps = {}
): Promise<DevCliBootstrapResult> {
  const existing = existingCredential(sponsor.serverId, options.credentialFile);
  if (existing) {
    return reconcileExistingCredential(sponsor, existing, options.credentialFile, options);
  }

  const rpc = (options.rpcClient ?? ((credential) => new RpcClient(credential)))({
    url: sponsor.gatewayUrl,
    deviceId: sponsor.deviceId,
    refreshToken: sponsor.refreshToken,
  });
  let rawInvite: unknown;
  try {
    rawInvite = await rpc.call("hubControl.pairDevice", []);
  } finally {
    await rpc.close();
  }
  const result =
    rawInvite && typeof rawInvite === "object" && !Array.isArray(rawInvite)
      ? (rawInvite as { pairing?: unknown })
      : {};
  const invite = HubPairingInviteSchema.parse(result.pairing);
  return pairWithInvite(
    {
      gatewayUrl: sponsor.gatewayUrl,
      serverId: sponsor.serverId,
      invite,
    },
    options.credentialFile,
    options
  );
}
