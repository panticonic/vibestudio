import {
  HubPairingInviteSchema,
  HubReadyPayloadSchema,
  HubWorkspaceRouteSchema,
  type HubPairingInvite,
} from "@vibestudio/service-schemas/hubControl";
import { selectedWorkspacePath } from "@vibestudio/shared/connect";
import {
  canonicalStoredPairing,
  loadCliCredentials,
  saveCliCredentials,
  type CliCredentials,
  type CliStoredPairing,
} from "../cli/credentialStore.js";
import { RpcClient } from "../cli/rpcClient.js";
import { ConnectionError } from "../cli/output.js";

type PairingResponse = {
  deviceId: string;
  refreshToken: string;
  workspaceId: string;
};

export type DevCliBootstrapResult =
  | { status: "existing"; workspaceName: string }
  | { status: "paired"; workspaceName: string }
  | { status: "invite-required" };

export interface DevCliPairingSponsor {
  gatewayUrl: string;
  serverId: string;
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

function stableReach(value: {
  room: string;
  fp: string;
  sig: string;
  v: 2;
  ice: "all" | "relay";
}): CliStoredPairing {
  return canonicalStoredPairing({
    room: value.room,
    fp: value.fp,
    sig: value.sig,
    v: value.v,
    ice: value.ice,
  });
}

function pairingResponse(value: unknown): PairingResponse {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as Partial<PairingResponse>).deviceId !== "string" ||
    typeof (value as Partial<PairingResponse>).refreshToken !== "string" ||
    typeof (value as Partial<PairingResponse>).workspaceId !== "string"
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
): DevCliBootstrapResult | null {
  const existing = loadCliCredentials(credentialFile);
  if (!existing) return null;
  if (existing.serverId !== serverId) {
    throw new Error(
      `Instance CLI credential targets server ${existing.serverId}, ` +
        `but the live hub is ${serverId}`
    );
  }
  return { status: "existing", workspaceName: existing.workspaceName };
}

async function pairWithInvite(
  input: {
    gatewayUrl: string;
    serverId: string;
    expectedWorkspaceIds?: ReadonlySet<string>;
    invite: HubPairingInvite;
  },
  credentialFile: string | undefined,
  deps: BootstrapDeps = {}
): Promise<DevCliBootstrapResult> {
  if (input.invite.serverId !== input.serverId) {
    throw new Error("Development CLI invite targets a different hub");
  }
  const device = await postPairing(input.gatewayUrl, input.invite, deps.fetch);
  if (input.expectedWorkspaceIds && !input.expectedWorkspaceIds.has(device.workspaceId)) {
    throw new Error(
      `Development pairing selected unknown workspace ${JSON.stringify(device.workspaceId)}`
    );
  }
  const createRpc = deps.rpcClient ?? ((credential) => new RpcClient(credential));
  let route: ReturnType<typeof HubWorkspaceRouteSchema.parse> | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const rpc = createRpc({
      url: input.gatewayUrl,
      deviceId: device.deviceId,
      refreshToken: device.refreshToken,
    });
    try {
      route = HubWorkspaceRouteSchema.parse(
        await rpc.call("hubControl.routeWorkspace", [{ workspaceId: device.workspaceId }])
      );
      break;
    } catch (error) {
      if (!(error instanceof ConnectionError) || attempt > 0) throw error;
    } finally {
      await rpc.close();
    }
  }
  if (!route) throw new Error("Development CLI could not route its paired workspace");

  const controlPairing = stableReach(input.invite);
  const workspacePairing = stableReach(route.workspaceReach);
  const credentials: CliCredentials = {
    schemaVersion: 4,
    kind: "device",
    url: `webrtc://${workspacePairing.room}${selectedWorkspacePath(route.workspace)}`,
    workspaceId: route.workspaceId,
    workspaceName: route.workspace,
    serverId: route.serverId,
    deviceId: device.deviceId,
    refreshToken: device.refreshToken,
    controlPairing,
    workspacePairing,
    pairedAt: Date.now(),
  };
  saveCliCredentials(credentials, credentialFile);
  return { status: "paired", workspaceName: route.workspace };
}

/**
 * Give a source-server instance its own CLI device without WebRTC/signaling.
 *
 * This is the same one-time root pairing and route contract used by remote
 * clients, transported over the hub's loopback HTTP ingress. The resulting
 * credential remains instance-scoped and all later CLI calls use ordinary
 * authenticated routing.
 */
export async function bootstrapInstanceCli(
  rawReady: unknown,
  options: { credentialFile?: string } & BootstrapDeps = {}
): Promise<DevCliBootstrapResult> {
  const ready = HubReadyPayloadSchema.parse(rawReady);
  const existing = existingCredential(ready.serverId, options.credentialFile);
  if (existing) return existing;
  if (!ready.rootInvite) return { status: "invite-required" };
  if (ready.workspaces.length === 0) {
    throw new Error("The development hub has no workspace for its CLI");
  }
  return pairWithInvite(
    {
      gatewayUrl: ready.gatewayUrl,
      serverId: ready.serverId,
      expectedWorkspaceIds: new Set(ready.workspaces.map((workspace) => workspace.workspaceId)),
      invite: ready.rootInvite,
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
  if (existing) return existing;

  const rpc = (options.rpcClient ?? ((credential) => new RpcClient(credential)))({
    url: sponsor.gatewayUrl,
    deviceId: sponsor.deviceId,
    refreshToken: sponsor.refreshToken,
  });
  let rawInvite: unknown;
  try {
    rawInvite = await rpc.call("hubControl.pairDevice", [{ workspace: sponsor.workspaceName }]);
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
