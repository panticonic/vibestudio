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
import type {
  WorkspaceCreationReceipt,
  WorkspaceTemplatePin,
} from "@vibestudio/workspace-contracts/types";
import type {
  CliStoredPairing,
  CliDeviceIdentity,
  CliAccountDeviceCredentials,
} from "./credentialStore.js";
import {
  canonicalStoredPairing,
  loadCliIdentity,
  saveCliCredentials,
  assertCliProfileIsUnpaired,
  requireDeviceCliIdentity,
} from "./credentialStore.js";
import { AuthError, UsageError } from "./output.js";
import { RpcClient, type DeviceCredential } from "./rpcClient.js";
import { resolveLocalHubControlTransport } from "./localHubTransport.js";
import { typedClient } from "./typedClients.js";
import { workspaceLabel } from "../node/workspaceLabel.js";

export type { DeviceCredential } from "./rpcClient.js";
export { refreshShell, type RefreshShellResponse } from "./rpcClient.js";

export interface PairOptions {
  link: string;
  label?: string;
  platform?: string;
  signal?: AbortSignal;
  credentialFile?: string;
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
  operationId: string;
  workspace: string;
  rootTemplate?: WorkspaceTemplatePin;
  purpose?: "use" | "author";
}

function controlClient(rpc: RpcClient, options?: { signal?: AbortSignal }) {
  return typedClient(
    "hubControl",
    hubControlMethods,
    options?.signal ? { call: (method, args) => rpc.call(method, args, options) } : rpc
  );
}

async function withControl<T>(
  creds: CliDeviceIdentity,
  operation: (client: ReturnType<typeof controlClient>) => Promise<T>,
  options: { signal?: AbortSignal } = {}
): Promise<T> {
  options.signal?.throwIfAborted();
  const local = await resolveLocalHubControlTransport(creds);
  const rpc = new RpcClient(
    {
      url: local?.serverUrl ?? creds.url,
      deviceId: creds.deviceId,
      refreshToken: creds.refreshToken,
      ...(local || creds.transport === "local"
        ? {}
        : { pairing: creds.controlPairing, endpointSecret: creds.endpointSecret }),
    },
    options
  );
  let result: T | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    result = await operation(controlClient(rpc, options));
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
    throw closeError;
  }
  return result as T;
}

export async function pairRemoteServer(options: PairOptions): Promise<DeviceCredential> {
  options.signal?.throwIfAborted();
  if (!options.link) throw new AuthError("pair requires a Vibestudio pairing link");
  const pairing = parsePairingLink(options.link);
  const existing = loadCliIdentity(options.credentialFile);
  if (existing) {
    const identity = requireDeviceCliIdentity(existing, "pairing recovery");
    if (
      identity.transport !== "iroh" ||
      identity.controlPairing.endpointId !== pairing.endpointId
    ) {
      throw new AuthError(
        "CLI is already paired to another account; run `vibestudio remote logout` first"
      );
    }
    if (identity.phase === "workspace") return identity;
    const selected = await selectRemoteWorkspace(
      identity,
      { privateRole: "personal" },
      { signal: options.signal }
    );
    saveCliCredentials(selected, options.credentialFile);
    return selected;
  }
  // Also refuse unreadable existing state before consuming a one-use invite.
  assertCliProfileIsUnpaired(options.credentialFile);
  const endpointSecret = randomBytes(32).toString("base64url");
  const pairedRef: { current: CliAccountDeviceCredentials | null } = {
    current: null,
  };
  const { IrohRpcClient } = await import("../node/iroh/irohRpcClient.js");
  const client = new IrohRpcClient({
    reach: pairing,
    endpointSecret: Buffer.from(endpointSecret, "base64url"),
    callerId: "shell:pairing",
    getToken: () => pairing.code,
    clientLabel: options.label ?? `${os.userInfo().username}@${os.hostname()}`,
    onPaired: (credential) => {
      const { code: _code, ...controlReach } = pairing;
      const receipt: CliAccountDeviceCredentials = {
        schemaVersion: 6,
        phase: "account",
        kind: "device",
        transport: "iroh",
        url: `iroh://${pairing.endpointId}`,
        deviceId: credential.deviceId,
        refreshToken: credential.refreshToken,
        endpointSecret,
        controlPairing: storeReach(controlReach),
        pairedAt: Date.now(),
      };
      saveCliCredentials(receipt, options.credentialFile);
      pairedRef.current = receipt;
    },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  let pairedCredential: DeviceCredential | null = null;
  let pairingFailure: unknown = null;
  try {
    await client.ready();
    const paired = pairedRef.current;
    if (!paired) throw new AuthError("pairing did not return a device credential");
    // The redemption connection has one ownership scope; selection below uses
    // the same account-control operation as every later navigation.
  } catch (error) {
    pairingFailure =
      error instanceof AuthError || (options.signal?.aborted && error === options.signal.reason)
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
  if (!pairedRef.current) throw new AuthError("pairing produced no device credential");
  pairedCredential = await selectRemoteWorkspace(
    pairedRef.current,
    { privateRole: "personal" },
    { signal: options.signal }
  );
  saveCliCredentials(pairedCredential, options.credentialFile);
  return pairedCredential;
}

export async function listRemoteWorkspaces(
  creds: CliDeviceIdentity
): Promise<RemoteWorkspaceEntry[]> {
  return await withControl(creds, (client) => client.listWorkspaces());
}

/** List workspaces over an already-open hub control connection. */
export async function listWorkspacesVia(
  control: RpcClient,
  options?: { signal?: AbortSignal }
): Promise<RemoteWorkspaceEntry[]> {
  return await controlClient(control, options).listWorkspaces();
}

/** Prepare the authenticated account's private pair through the same host operation as apps. */
export async function ensureRemoteUserWorkspaces(
  creds: CliDeviceIdentity
): Promise<{ personal: RemoteWorkspaceEntry; system: RemoteWorkspaceEntry }> {
  return await withControl(creds, (client) => client.ensureUserWorkspaces());
}

export async function createRemoteWorkspace(
  creds: CliDeviceIdentity,
  options: CreateRemoteWorkspaceOptions
): Promise<WorkspaceCreationReceipt> {
  return await withControl(creds, (client) =>
    client.createWorkspace({
      workspace: options.workspace,
      operationId: options.operationId,
      ...(options.purpose ? { purpose: options.purpose } : {}),
      ...(options.rootTemplate ? { rootTemplate: options.rootTemplate } : {}),
    })
  );
}

/**
 * Which workspace to route a device credential to: a visible workspace by
 * name, an exact workspace id, or one of the account's private pair.
 */
export type RemoteWorkspaceSelector =
  | string
  | { workspaceId: string }
  | { privateRole: "personal" | "system" };

/** Account preparation and route selection are one shared navigation boundary,
 * independent of whether the caller transports control over loopback or Iroh. */
export async function selectAccountWorkspace(
  control: {
    ensureUserWorkspaces(): Promise<{
      personal: { workspaceId: string };
      system: { workspaceId: string };
    }>;
    routeWorkspace(input: { workspaceId: string }): Promise<HubWorkspaceRoute>;
  },
  selector: Exclude<RemoteWorkspaceSelector, string>
): Promise<HubWorkspaceRoute> {
  const workspaceId =
    "workspaceId" in selector
      ? selector.workspaceId
      : (await control.ensureUserWorkspaces())[selector.privateRole].workspaceId;
  const route = await control.routeWorkspace({ workspaceId });
  if (route.workspaceId !== workspaceId)
    throw new AuthError("workspace route changed the selected target");
  return route;
}

/** Where a credential's server is, as people see it: never a workspace path. */
export function serverEndpoint(credentials: DeviceCredential): string {
  return credentials.transport === "local"
    ? new URL(credentials.url).origin
    : `iroh:${credentials.workspacePairing.endpointId.slice(0, 12)}`;
}

/**
 * The workspace a person names: by its name, or by the label the CLI shows
 * for it ("Personal", "System", a display name).
 */
export function findWorkspace(
  entries: readonly RemoteWorkspaceEntry[],
  selector: string
): RemoteWorkspaceEntry {
  const named = entries.find((workspace) => workspace.name === selector);
  if (named) return named;
  const labelled = entries.filter((workspace) => workspaceLabel(workspace) === selector);
  const [only] = labelled;
  if (only && labelled.length === 1) return only;
  if (labelled.length > 1) {
    throw new UsageError(
      `${labelled.length} workspaces are called "${selector}"; choose one by its workspace name`
    );
  }
  throw new AuthError(`workspace "${selector}" is not visible to this account`);
}

export async function selectRemoteWorkspace(
  creds: CliDeviceIdentity,
  selector: RemoteWorkspaceSelector,
  options: { signal?: AbortSignal } = {}
): Promise<DeviceCredential> {
  const route: HubWorkspaceRoute = await withControl(
    creds,
    async (client) => {
      if (typeof selector === "string") {
        const entry = findWorkspace(await client.listWorkspaces(), selector);
        return await selectAccountWorkspace(client, { workspaceId: entry.workspaceId });
      }
      return await selectAccountWorkspace(client, selector);
    },
    options
  );
  if ("serverId" in creds && route.serverId !== creds.serverId) {
    throw new AuthError("workspace route changed the paired server identity");
  }
  if (creds.transport === "local") {
    return {
      ...creds,
      schemaVersion: 6,
      phase: "workspace",
      url: route.serverUrl,
      workspaceId: route.workspaceId,
      workspaceName: route.workspace,
      serverId: route.serverId,
    };
  }
  const workspacePairing = storeReach(route.workspaceReach);
  return {
    ...creds,
    schemaVersion: 6,
    phase: "workspace",
    url: selectedUrl(workspacePairing, route.workspace),
    workspaceId: route.workspaceId,
    workspaceName: route.workspace,
    serverId: route.serverId,
    controlPairing: creds.controlPairing,
    workspacePairing,
  };
}

export async function inviteRemoteUser(
  creds: CliDeviceIdentity,
  options: InviteUserOptions
): Promise<{ user: unknown; workspaces: string[]; pairing: HubPairingInvite }> {
  return await withControl(creds, (client) => client.inviteUser(options));
}

export async function pairRemoteDevice(
  creds: CliDeviceIdentity,
  options: { ttlMs?: number } = {}
): Promise<{ userId: string; handle: string; pairing: HubPairingInvite }> {
  return await withControl(creds, (client) => client.pairDevice(options));
}

export async function addRemoteWorkspaceMember(
  creds: CliDeviceIdentity,
  options: { workspace: string; userId?: string; handle?: string }
): Promise<Record<string, unknown>> {
  return await withControl(creds, (client) => client.addWorkspaceMember(options));
}

export async function removeRemoteWorkspaceMember(
  creds: CliDeviceIdentity,
  options: { workspace: string; userId?: string; handle?: string }
): Promise<{ removed: boolean; closedSessions: number }> {
  return await withControl(creds, (client) => client.removeWorkspaceMember(options));
}

export async function listRemoteWorkspaceMembers(
  creds: CliDeviceIdentity,
  workspace: string
): Promise<{ workspace: string; workspaceId: string; members: Record<string, unknown>[] }> {
  return await withControl(creds, (client) => client.listWorkspaceMembers({ workspace }));
}

export async function listRemoteDevices(creds: CliDeviceIdentity) {
  return await withControl(creds, (client) => client.listDevices());
}

export async function revokeRemoteDevice(creds: CliDeviceIdentity, deviceId: string) {
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
  v: typeof import("@vibestudio/iroh-transport").IROH_REACH_VERSION;
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
