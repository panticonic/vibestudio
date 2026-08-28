import * as os from "node:os";
import { randomBytes } from "node:crypto";
import { selectedWorkspacePath } from "@vibestudio/shared/connect";
import { parseConnectLink, type ConnectPairing } from "@vibestudio/iroh-transport";
import {
  hubControlMethods,
  type HubPairingInvite,
  type HubWorkspaceEntry,
  type HubWorkspaceRoute,
} from "@vibestudio/service-schemas/hubControl";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
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

export type RemoteWorkspaceEntry = HubWorkspaceEntry;

export interface InviteUserOptions {
  handle: string;
  displayName?: string;
  role?: "admin" | "member";
  workspaces: string[];
  ttlMs?: number;
}

export interface CreateRemoteWorkspaceOptions {
  workspace: string;
  rootTemplate?: WorkspaceTemplatePin;
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
    ...(local || creds.transport === "local"
      ? {}
      : { pairing: creds.controlPairing, endpointSecret: creds.endpointSecret }),
  });
  let result: T | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    result = await operation(controlClient(rpc));
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  let closeError: unknown;
  try {
    await rpc.close();
  } catch (error) {
    closeError = error;
  }
  if (operationFailed) {
    if (closeError !== undefined) {
      throw new AggregateError(
        [operationError, closeError],
        "Remote operation failed and its control connection could not be closed"
      );
    }
    throw operationError;
  }
  if (closeError !== undefined) {
    console.warn(
      "[remoteClient] Control operation completed but connection cleanup failed:",
      closeError
    );
  }
  return result as T;
}

export async function pairRemoteServer(options: PairOptions): Promise<DeviceCredential> {
  if (!options.link) throw new AuthError("pair requires a Vibestudio pairing link");
  const pairing = parsePairingLink(options.link);
  const endpointSecret = randomBytes(32).toString("base64url");
  const pairedRef: {
    current: {
      credential: { deviceId: string; refreshToken: string };
      workspaceId: string;
    } | null;
  } = {
    current: null,
  };
  const { IrohRpcClient } = await import("../node/iroh/irohRpcClient.js");
  const client = new IrohRpcClient({
    reach: pairing,
    endpointSecret: Buffer.from(endpointSecret, "base64url"),
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
    const { code: _code, exp: _exp, ...stableHubReach } = pairing;
    const controlPairing = storeReach(stableHubReach);
    const workspacePairing = storeReach(route.workspaceReach);
    pairedCredential = {
      schemaVersion: 5,
      kind: "device",
      transport: "iroh",
      url: selectedUrl(workspacePairing, route.workspace),
      workspaceId: route.workspaceId,
      workspaceName: route.workspace,
      serverId: route.serverId,
      deviceId: paired.credential.deviceId,
      refreshToken: paired.credential.refreshToken,
      endpointSecret,
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
        "Remote pairing failed and its Iroh connection could not be closed"
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

export async function createRemoteWorkspace(
  creds: DeviceCredential,
  options: CreateRemoteWorkspaceOptions
): Promise<RemoteWorkspaceEntry> {
  return await withControl(creds, (client) =>
    client.createWorkspace({
      workspace: options.workspace,
      ...(options.rootTemplate ? { rootTemplate: options.rootTemplate } : {}),
    })
  );
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
  if (creds.transport === "local") {
    return {
      ...creds,
      url: route.serverUrl,
      workspaceId: route.workspaceId,
      workspaceName: route.workspace,
      serverId: creds.serverId,
    };
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

function storeReach(reach: {
  endpointId: string;
  relays: readonly string[];
  v: 4;
}): CliStoredPairing {
  try {
    return canonicalStoredPairing({ ...reach, relays: [...reach.relays] });
  } catch (error) {
    throw new AuthError(error instanceof Error ? error.message : String(error));
  }
}

function selectedUrl(pairing: Pick<CliStoredPairing, "endpointId">, workspaceName: string): string {
  return `iroh://${pairing.endpointId}${selectedWorkspacePath(workspaceName)}`;
}
