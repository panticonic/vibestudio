import * as os from "node:os";
import {
  parseConnectLink,
  serverAuthRouteUrl,
  serverWorkspaceRouteUrl,
  PAIRING_CODE_PATTERN,
  parseConnectServerUrl,
  selectedWorkspacePath,
  type ConnectPairing,
} from "@vibestudio/shared/connect";
import { AuthError } from "./output.js";
import { authMethods } from "@vibestudio/shared/serviceSchemas/auth";
import { workspaceMethods } from "@vibestudio/shared/serviceSchemas/workspace";
import {
  isWebRtcCredential,
  type CliHubCredential,
  type CliStoredPairing,
} from "./credentialStore.js";
import { RpcClient, type DeviceCredential } from "./rpcClient.js";
import { typedClient } from "./typedClients.js";

export type { DeviceCredential } from "./rpcClient.js";
export { refreshShell, type RefreshShellResponse } from "./rpcClient.js";

export interface PairOptions {
  url?: string;
  code?: string;
  link?: string;
  label?: string;
  platform?: string;
}

export interface PairingInvite {
  code: string;
  deepLink: string | null;
  /** Legacy WS server URL. WebRTC-paired servers no longer return one, so it is
   * optional — the deep link (room/fp/sig) is the pairing material now. */
  connectUrl?: string;
  serverUrl?: string;
  expiresAt?: number;
}

interface WorkspaceSelectResult {
  workspaceName?: string;
  serverUrl?: string;
  pairing?: {
    deepLink?: string;
  } | null;
}

export interface RemoteWorkspaceEntry {
  name: string;
  lastOpened: number;
  running?: boolean;
  ephemeral?: boolean;
}

export async function pairRemoteServer(options: PairOptions): Promise<DeviceCredential> {
  if (options.link) {
    return await pairRemoteServerViaWebRtc(options.link, {
      label: options.label,
    });
  }
  const parsed = parsePairOptions(options);
  let response: Response;
  try {
    response = await fetch(serverAuthRouteUrl(parsed.url, "complete-pairing"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: parsed.code,
        label: options.label ?? `${os.userInfo().username}@${os.hostname()}`,
        platform: options.platform ?? "desktop",
      }),
    });
  } catch (error) {
    throw new AuthError(
      `cannot reach ${parsed.url}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const body = (await response.json().catch(() => ({}))) as {
    deviceId?: unknown;
    refreshToken?: unknown;
    error?: unknown;
  };
  if (!response.ok || typeof body.deviceId !== "string" || typeof body.refreshToken !== "string") {
    throw new AuthError(
      remoteErrorMessage(body, `pairing failed (${response.status} ${response.statusText})`)
    );
  }
  return {
    schemaVersion: 1,
    kind: "device",
    url: parsed.url,
    hubUrl: parsed.url,
    deviceId: body.deviceId,
    refreshToken: body.refreshToken,
  };
}

async function pairRemoteServerViaWebRtc(
  link: string,
  options: { label?: string; workspaceName?: string; hubCredential?: CliHubCredential } = {}
): Promise<DeviceCredential> {
  const pairing = parsePairingLink(link);
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
    if (!issued) {
      throw new AuthError("pairing did not return a device credential");
    }
    const storedPairing = storePairing(pairing);
    const workspaceName = options.workspaceName ?? (await detectActiveWorkspace(client));
    const url = workspaceName
      ? webrtcSelectedUrl(storedPairing, workspaceName)
      : webrtcBaseUrl(storedPairing);
    return {
      schemaVersion: 1,
      kind: "device",
      url,
      hubUrl: options.hubCredential?.url ?? webrtcBaseUrl(storedPairing),
      ...(workspaceName ? { workspaceName } : {}),
      deviceId: issued.deviceId,
      refreshToken: issued.refreshToken,
      pairing: storedPairing,
      pairedAt: Date.now(),
      ...(options.hubCredential ? { hubCredential: options.hubCredential } : {}),
    };
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function postHubWorkspaceJson(
  creds: Pick<DeviceCredential, "hubUrl" | "deviceId" | "refreshToken">,
  route: string,
  body: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  if (!creds.hubUrl) {
    throw new AuthError("stored credential is missing a hub URL; pair again");
  }
  const response = await fetch(serverWorkspaceRouteUrl(creds.hubUrl, route), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...body,
      deviceId: creds.deviceId,
      refreshToken: creds.refreshToken,
    }),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new AuthError(remoteErrorMessage(json, `workspace ${route} failed (${response.status})`));
  }
  return json;
}

export async function listRemoteWorkspaces(
  creds: Pick<DeviceCredential, "url" | "hubUrl" | "deviceId" | "refreshToken"> &
    Partial<Pick<DeviceCredential, "pairing" | "hubCredential">>
): Promise<RemoteWorkspaceEntry[]> {
  if (isWebRtcCredential(creds)) {
    const workspace = typedClient(
      "workspace",
      workspaceMethods,
      new RpcClient(hubCredential(creds))
    );
    const result = await workspace.list();
    return parseWorkspaceEntries(Array.isArray(result) ? result : []);
  }
  const json = await postHubWorkspaceJson(creds, "list");
  return parseWorkspaceEntries(Array.isArray(json["workspaces"]) ? json["workspaces"] : []);
}

function parseWorkspaceEntries(workspaces: unknown[]): RemoteWorkspaceEntry[] {
  const result: RemoteWorkspaceEntry[] = [];
  for (const entry of workspaces) {
    const record = entry as Record<string, unknown>;
    if (typeof record["name"] !== "string") continue;
    result.push({
      name: record["name"],
      lastOpened: typeof record["lastOpened"] === "number" ? record["lastOpened"] : 0,
      running: typeof record["running"] === "boolean" ? record["running"] : undefined,
      ephemeral: typeof record["ephemeral"] === "boolean" ? record["ephemeral"] : undefined,
    });
  }
  return result;
}

export async function selectRemoteWorkspace(
  creds: DeviceCredential,
  name: string
): Promise<DeviceCredential> {
  if (isWebRtcCredential(creds)) {
    const hub = hubCredential(creds);
    const workspace = typedClient("workspace", workspaceMethods, new RpcClient(hub));
    const selected = (await workspace.select(name)) as unknown as WorkspaceSelectResult | undefined;
    const workspaceName =
      typeof selected?.workspaceName === "string" ? selected.workspaceName : name;
    const deepLink =
      selected?.pairing && typeof selected.pairing.deepLink === "string"
        ? selected.pairing.deepLink
        : undefined;
    if (!deepLink) {
      throw new AuthError(
        `workspace "${workspaceName}" did not return a WebRTC pairing link; cannot select it remotely`
      );
    }
    return await pairRemoteServerViaWebRtc(deepLink, {
      workspaceName,
      hubCredential: stripHubCredential(hub),
    });
  }
  const json = await postHubWorkspaceJson(creds, "select", { name });
  const serverUrl = typeof json["serverUrl"] === "string" ? json["serverUrl"] : null;
  const workspaceName = typeof json["workspaceName"] === "string" ? json["workspaceName"] : name;
  if (!serverUrl) throw new AuthError("server did not return a workspace URL");
  return {
    ...creds,
    url: serverUrl,
    workspaceName,
  };
}

export async function createPairingInvite(
  creds: Pick<DeviceCredential, "url" | "deviceId" | "refreshToken">,
  options: { ttlMs?: number } = {}
): Promise<PairingInvite> {
  const auth = typedClient("auth", authMethods, new RpcClient(creds));
  // createPairingInvite has no `returns` schema yet — validate the shape here.
  const result = (await auth.createPairingInvite(options.ttlMs ? { ttlMs: options.ttlMs } : {})) as
    | Record<string, unknown>
    | undefined;
  if (!result || typeof result["code"] !== "string") {
    throw new Error("invite failed: server returned an unexpected response");
  }
  return {
    // The server mints the deep link from its WebRTC pairing material (room/fp/
    // sig); the CLI no longer has that material, so it cannot build one itself.
    // A null deepLink means the server hasn't advertised pairing material yet.
    code: result["code"],
    deepLink: typeof result["deepLink"] === "string" ? result["deepLink"] : null,
    connectUrl: typeof result["connectUrl"] === "string" ? result["connectUrl"] : undefined,
    serverUrl: typeof result["serverUrl"] === "string" ? result["serverUrl"] : undefined,
    expiresAt: typeof result["expiresAt"] === "number" ? result["expiresAt"] : undefined,
  };
}

function remoteErrorMessage(body: { error?: unknown; code?: unknown }, fallback: string): string {
  const message = typeof body.error === "string" ? body.error : fallback;
  const code = typeof body.code === "string" ? body.code : undefined;
  return code ? `${message} [${code}]` : message;
}

function parsePairOptions(options: PairOptions): { url: string; code: string } {
  if (options.link) {
    throw new Error("internal error: WebRTC pairing link reached HTTP pair parser");
  }
  if (!options.url || !options.code) {
    throw new Error("pair requires --url and --code");
  }
  if (!PAIRING_CODE_PATTERN.test(options.code)) {
    throw new Error("pairing code has an unexpected format");
  }
  const parsedUrl = parseConnectServerUrl(options.url);
  if (parsedUrl.kind === "error") throw new Error(parsedUrl.reason);
  // parseConnectServerUrl's declared return type unions in ConnectLink, whose ok
  // variant (now WebRTC room/fp, no `url`) it never actually produces — narrow to
  // the origin-bearing result.
  if (!("url" in parsedUrl)) throw new Error("server URL did not resolve to an origin");
  return { url: parsedUrl.url, code: options.code };
}

function parsePairingLink(link: string): ConnectPairing {
  const parsed = parseConnectLink(link);
  if (parsed.kind === "error") throw new Error(parsed.reason);
  const { kind: _kind, ...pairing } = parsed;
  return pairing;
}

function storePairing(pairing: ConnectPairing): CliStoredPairing {
  return {
    room: pairing.room,
    fp: pairing.fp,
    sig: pairing.sig,
    v: pairing.v,
    ice: pairing.ice,
    srv: pairing.srv,
  };
}

function webrtcBaseUrl(pairing: Pick<CliStoredPairing, "room">): string {
  return `webrtc://${pairing.room}`;
}

function webrtcSelectedUrl(pairing: Pick<CliStoredPairing, "room">, workspaceName: string): string {
  return `${webrtcBaseUrl(pairing)}${selectedWorkspacePath(workspaceName)}`;
}

async function detectActiveWorkspace(client: {
  call<T = unknown>(method: string, args?: unknown[]): Promise<T>;
}): Promise<string | undefined> {
  try {
    const active = await client.call("workspace.getActive", []);
    return typeof active === "string" && active ? active : undefined;
  } catch {
    return undefined;
  }
}

function hubCredential(
  creds: Pick<DeviceCredential, "url" | "deviceId" | "refreshToken"> &
    Partial<Pick<DeviceCredential, "pairing" | "hubCredential">>
): DeviceCredential {
  if (creds.hubCredential) {
    return {
      schemaVersion: 1,
      kind: "device",
      url: creds.hubCredential.url,
      hubUrl: creds.hubCredential.url,
      deviceId: creds.hubCredential.deviceId,
      refreshToken: creds.hubCredential.refreshToken,
      ...(creds.hubCredential.pairing ? { pairing: creds.hubCredential.pairing } : {}),
      ...(creds.hubCredential.pairedAt ? { pairedAt: creds.hubCredential.pairedAt } : {}),
    };
  }
  return {
    schemaVersion: 1,
    kind: "device",
    url: creds.url,
    hubUrl: creds.url,
    deviceId: creds.deviceId,
    refreshToken: creds.refreshToken,
    ...(creds.pairing ? { pairing: creds.pairing } : {}),
  };
}

function stripHubCredential(creds: DeviceCredential): CliHubCredential {
  return {
    url: creds.url,
    deviceId: creds.deviceId,
    refreshToken: creds.refreshToken,
    ...(creds.pairing ? { pairing: creds.pairing } : {}),
    ...(creds.pairedAt ? { pairedAt: creds.pairedAt } : {}),
  };
}
