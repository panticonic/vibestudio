import * as os from "node:os";
import {
  parseConnectLink,
  selectedWorkspacePath,
  type ConnectPairing,
} from "@vibestudio/shared/connect";
import {
  hubControlMethods,
  type HubPairingInvite,
  type HubWorkspaceRoute,
} from "@vibestudio/service-schemas/hubControl";
import type { CliStoredPairing } from "./credentialStore.js";
import { canonicalStoredPairing } from "./credentialStore.js";
import { AuthError, UsageError } from "./output.js";
import { RpcClient, type DeviceCredential } from "./rpcClient.js";
import { resolveLocalHubControlTransport } from "./localHubTransport.js";
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
  const local = await resolveLocalHubControlTransport(creds);
  const rpc = new RpcClient({
    url: local?.serverUrl ?? creds.url,
    deviceId: creds.deviceId,
    refreshToken: creds.refreshToken,
    ...(local ? {} : { pairing: creds.controlPairing }),
  });
  try {
    return await operation(controlClient(rpc));
  } finally {
    await rpc.close();
  }
}

export async function pairRemoteServer(options: PairOptions): Promise<DeviceCredential> {
  if (!options.link) throw new AuthError("pair requires a Vibestudio pairing link");
  const pairing = parsePairingLink(options.link);
  const pairedRef: {
    current: {
      credential: { deviceId: string; refreshToken: string };
      workspaceId: string;
    } | null;
  } = {
    current: null,
  };
  const { WebRtcRpcClient } = await import("./webrtcClient.js");
  const client = new WebRtcRpcClient({
    pairing,
    callerId: "shell:pairing",
    getToken: () => pairing.code,
    clientLabel: options.label ?? `${os.userInfo().username}@${os.hostname()}`,
    onPaired: (credential, context) => {
      if (!context) throw new AuthError("pairing did not return its target workspace");
      pairedRef.current = { credential, workspaceId: context.workspaceId };
    },
  });
  let pairedCredential: DeviceCredential | null = null;
  let pairingFailure: unknown = null;
  try {
    await client.ready();
    const paired = pairedRef.current;
    if (!paired) throw new AuthError("pairing did not return a device credential");
    const route = await client.call<HubWorkspaceRoute>("hubControl.routeWorkspace", [
      { workspaceId: paired.workspaceId },
    ]);
    if (route.workspaceId !== paired.workspaceId) {
      throw new AuthError("workspace route changed the pairing target");
    }
    const { code: _code, ...stableHubReach } = pairing;
    const controlPairing = storeReach(stableHubReach);
    const workspacePairing = storeReach(route.workspaceReach);
    pairedCredential = {
      schemaVersion: 4,
      kind: "device",
      url: selectedUrl(workspacePairing, route.workspace),
      workspaceId: route.workspaceId,
      workspaceName: route.workspace,
      serverId: route.serverId,
      deviceId: paired.credential.deviceId,
      refreshToken: paired.credential.refreshToken,
      controlPairing,
      workspacePairing,
      pairedAt: Date.now(),
    };
  } catch (error) {
    pairingFailure =
      error instanceof AuthError
        ? error
        : new AuthError(
            `pairing failed: ${error instanceof Error ? error.message : String(error)}`
          );
  }
  const [closed] = await Promise.allSettled([client.close()]);
  if (closed.status === "rejected") {
    if (pairingFailure) {
      throw new AggregateError(
        [pairingFailure, closed.reason],
        "Remote pairing failed and its WebRTC connection could not be closed"
      );
    }
    throw closed.reason;
  }
  if (pairingFailure) throw pairingFailure;
  if (!pairedCredential) throw new AuthError("pairing produced no device credential");
  return pairedCredential;
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
  const route: HubWorkspaceRoute = await withControl(creds, async (client) => {
    const entries = await client.listWorkspaces();
    const entry = entries.find((workspace) => workspace.name === name);
    if (!entry) throw new AuthError(`workspace "${name}" is not visible to this account`);
    return await client.routeWorkspace({ workspaceId: entry.workspaceId });
  });
  if (route.serverId !== creds.serverId) {
    throw new AuthError("workspace route changed the paired server identity");
  }
  const workspacePairing = storeReach(route.workspaceReach);
  return {
    ...creds,
    url: selectedUrl(workspacePairing, route.workspace),
    workspaceId: route.workspaceId,
    workspaceName: route.workspace,
    serverId: creds.serverId,
    controlPairing: creds.controlPairing,
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
  if (parsed.kind === "error") throw new UsageError(parsed.reason);
  const { kind: _kind, ...pairing } = parsed;
  return pairing;
}

function storeReach(reach: HubWorkspaceRoute["workspaceReach"]): CliStoredPairing {
  try {
    return canonicalStoredPairing(reach);
  } catch (error) {
    throw new AuthError(error instanceof Error ? error.message : String(error));
  }
}

function selectedUrl(pairing: Pick<CliStoredPairing, "room">, workspaceName: string): string {
  return `webrtc://${pairing.room}${selectedWorkspacePath(workspaceName)}`;
}
