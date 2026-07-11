import * as os from "node:os";
import {
  normalizeFingerprint,
  parseConnectLink,
  parseSignalingEndpoint,
  selectedWorkspacePath,
  type ConnectPairing,
} from "@vibestudio/shared/connect";
import {
  hubControlMethods,
  type HubPairingInvite,
  type HubWorkspaceRoute,
} from "@vibestudio/shared/serviceSchemas/hubControl";
import type { CliStoredPairing } from "./credentialStore.js";
import { AuthError } from "./output.js";
import { RpcClient, type DeviceCredential } from "./rpcClient.js";
import { typedClient } from "./typedClients.js";

export type { DeviceCredential } from "./rpcClient.js";
export { refreshShell, type RefreshShellResponse } from "./rpcClient.js";

export interface PairOptions {
  link: string;
  label?: string;
  platform?: string;
}

export interface RemoteWorkspaceEntry {
  workspaceId: string;
  name: string;
  lastOpened: number;
  running: boolean;
  ephemeral?: boolean;
}

export interface InviteUserOptions {
  handle: string;
  displayName?: string;
  role?: "admin" | "member";
  workspaces: string[];
  ttlMs?: number;
}

function controlClient(rpc: RpcClient) {
  return typedClient("hubControl", hubControlMethods, rpc);
}

async function withControl<T>(
  creds: DeviceCredential,
  operation: (client: ReturnType<typeof controlClient>) => Promise<T>
): Promise<T> {
  const rpc = new RpcClient({ ...creds, workspacePairing: creds.controlPairing });
  try {
    return await operation(controlClient(rpc));
  } finally {
    await rpc.close();
  }
}

export async function pairRemoteServer(options: PairOptions): Promise<DeviceCredential> {
  if (!options.link) throw new AuthError("pair requires a vibestudio://connect link");
  const pairing = parsePairingLink(options.link);
  const issuedRef: { current: { deviceId: string; refreshToken: string } | null } = {
    current: null,
  };
  const { WebRtcRpcClient } = await import("./webrtcClient.js");
  const client = new WebRtcRpcClient({
    pairing,
    callerId: "shell:pairing",
    getToken: () => pairing.code,
    clientLabel: options.label ?? `${os.userInfo().username}@${os.hostname()}`,
    onPaired: (credential) => {
      issuedRef.current = credential;
    },
  });
  try {
    await client.ready();
    const issued = issuedRef.current;
    if (!issued) throw new AuthError("pairing did not return a device credential");
    const workspaceName = await client.call<unknown>("workspace.getActive", []);
    const connectionInfo = await client.call<Record<string, unknown>>("auth.getConnectionInfo", []);
    if (typeof workspaceName !== "string" || !workspaceName) {
      throw new AuthError("paired child did not report an active workspace");
    }
    if (typeof connectionInfo["serverId"] !== "string") {
      throw new AuthError("paired child did not report its server identity");
    }
    const route = await client.call<HubWorkspaceRoute>("hubControl.routeWorkspace", [
      { workspace: workspaceName },
    ]);
    if (route.serverId !== connectionInfo["serverId"]) {
      throw new AuthError("workspace route changed server identity during pairing");
    }
    const controlPairing = storeReach(route.controlReach);
    const workspacePairing = storeReach(route.workspaceReach);
    return {
      schemaVersion: 3,
      kind: "device",
      url: selectedUrl(workspacePairing, route.workspace),
      workspaceName: route.workspace,
      serverId: route.serverId,
      deviceId: issued.deviceId,
      refreshToken: issued.refreshToken,
      controlPairing,
      workspacePairing,
      pairedAt: Date.now(),
    };
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError(
      `pairing failed: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function listRemoteWorkspaces(
  creds: DeviceCredential
): Promise<RemoteWorkspaceEntry[]> {
  return await withControl(creds, (client) => client.listWorkspaces());
}

export async function selectRemoteWorkspace(
  creds: DeviceCredential,
  name: string
): Promise<DeviceCredential> {
  const route: HubWorkspaceRoute = await withControl(creds, (client) =>
    client.routeWorkspace({ workspace: name })
  );
  if (route.serverId !== creds.serverId) {
    throw new AuthError("workspace route changed the paired server identity");
  }
  const controlPairing = storeReach(route.controlReach);
  const workspacePairing = storeReach(route.workspaceReach);
  return {
    ...creds,
    url: selectedUrl(workspacePairing, route.workspace),
    workspaceName: route.workspace,
    serverId: creds.serverId,
    controlPairing,
    workspacePairing,
  };
}

export async function inviteRemoteUser(
  creds: DeviceCredential,
  options: InviteUserOptions
): Promise<{ user: unknown; workspaces: string[]; pairing: HubPairingInvite }> {
  return await withControl(creds, (client) => client.inviteUser(options));
}

export async function pairRemoteDevice(
  creds: DeviceCredential,
  options: { workspace?: string; ttlMs?: number } = {}
): Promise<{ userId: string; handle: string; workspace: string; pairing: HubPairingInvite }> {
  return await withControl(creds, (client) => client.pairDevice(options));
}

export async function addRemoteWorkspaceMember(
  creds: DeviceCredential,
  options: { workspace: string; userId?: string; handle?: string }
): Promise<Record<string, unknown>> {
  return await withControl(creds, (client) => client.addWorkspaceMember(options));
}

export async function removeRemoteWorkspaceMember(
  creds: DeviceCredential,
  options: { workspace: string; userId?: string; handle?: string }
): Promise<{ removed: boolean; closedSessions: number }> {
  return await withControl(creds, (client) => client.removeWorkspaceMember(options));
}

export async function listRemoteWorkspaceMembers(
  creds: DeviceCredential,
  workspace: string
): Promise<{ workspace: string; workspaceId: string; members: Record<string, unknown>[] }> {
  return await withControl(creds, (client) => client.listWorkspaceMembers({ workspace }));
}

export async function listRemoteDevices(creds: DeviceCredential) {
  return await withControl(creds, (client) => client.listDevices());
}

export async function revokeRemoteDevice(creds: DeviceCredential, deviceId: string) {
  return await withControl(creds, (client) => client.revokeDevice(deviceId));
}

export function pairingDeepLink(invite: HubPairingInvite): string {
  return invite.deepLink;
}

function parsePairingLink(link: string): ConnectPairing {
  const parsed = parseConnectLink(link);
  if (parsed.kind === "error") throw new AuthError(parsed.reason);
  const { kind: _kind, ...pairing } = parsed;
  return pairing;
}

function storeReach(reach: HubWorkspaceRoute["controlReach"]): CliStoredPairing {
  const signaling = parseSignalingEndpoint(reach.sig);
  if (signaling.kind === "error") throw new AuthError(signaling.reason);
  return {
    room: reach.room,
    fp: normalizeFingerprint(reach.fp),
    sig: signaling.url,
    v: reach.v,
    ice: reach.ice,
    ...(reach.srv ? { srv: reach.srv } : {}),
  };
}

function selectedUrl(pairing: Pick<CliStoredPairing, "room">, workspaceName: string): string {
  return `webrtc://${pairing.room}${selectedWorkspacePath(workspaceName)}`;
}
