import {
  HubReadyPayloadSchema,
  HubWorkspaceRouteSchema,
  type HubReadyPayload,
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

type PairingResponse = {
  deviceId: string;
  refreshToken: string;
  workspaceId: string;
};

export type DevCliBootstrapResult =
  | { status: "existing"; workspaceName: string }
  | { status: "paired"; workspaceName: string }
  | { status: "invite-required" };

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

async function postPairing(ready: HubReadyPayload): Promise<PairingResponse> {
  const invite = ready.rootInvite;
  if (!invite) throw new Error("The development hub has no root invite");
  const response = await fetch(new URL("/_r/s/auth/complete-pairing", ready.gatewayUrl), {
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

/**
 * Give a source-server instance its own CLI device without WebRTC/signaling.
 *
 * This is the same one-time root pairing and route contract used by remote
 * clients, transported over the hub's loopback HTTP ingress. The resulting
 * credential remains instance-scoped and all later CLI calls use ordinary
 * authenticated routing.
 */
export async function bootstrapInstanceCli(rawReady: unknown): Promise<DevCliBootstrapResult> {
  const ready = HubReadyPayloadSchema.parse(rawReady);
  const existing = loadCliCredentials();
  if (existing) {
    if (existing.serverId !== ready.serverId) {
      throw new Error(
        `Instance CLI credential targets server ${existing.serverId}, ` +
          `but the live hub is ${ready.serverId}`
      );
    }
    return { status: "existing", workspaceName: existing.workspaceName };
  }
  if (!ready.rootInvite) return { status: "invite-required" };

  const device = await postPairing(ready);
  const workspace = ready.workspaces.find((entry) => entry.workspaceId === device.workspaceId);
  if (!workspace) {
    throw new Error(
      `Development pairing selected unknown workspace ${JSON.stringify(device.workspaceId)}`
    );
  }
  const rpc = new RpcClient({
    url: ready.gatewayUrl,
    deviceId: device.deviceId,
    refreshToken: device.refreshToken,
  });
  let route;
  try {
    route = HubWorkspaceRouteSchema.parse(
      await rpc.call("hubControl.routeWorkspace", [{ workspaceId: workspace.workspaceId }])
    );
  } finally {
    await rpc.close();
  }

  const controlPairing = stableReach(ready.rootInvite);
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
  saveCliCredentials(credentials);
  return { status: "paired", workspaceName: route.workspace };
}
