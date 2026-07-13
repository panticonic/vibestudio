import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { RpcClient } from "@vibestudio/rpc";
import type { CdpHostBridgeDiagnostic, CdpHostBridgeSocket } from "./hostBridge.js";

export interface IpcTokenAuth {
  kind: "token";
  token: string;
}

export interface InjectedAuth {
  kind: "injected";
}

export interface HeadlessHostServerConnection {
  rpc: Pick<RpcClient, "call" | "stream">;
  /** Current auth token, when the transport has one. */
  getToken(): string;
  onServerEvent(listener: (event: string, payload: unknown) => void): void;
  onResubscribe(handler: () => void | Promise<void>): void;
  close(): Promise<void>;
}

export interface HeadlessHostConfig {
  /** Base server URL, e.g. http://127.0.0.1:3030 */
  serverUrl: string;
  auth: IpcTokenAuth | InjectedAuth;
  label: string;
  clientSessionId: string;
  maxPanels: number;
  idleUnloadMs: number;
  /** Self-exit when holding zero leases for this long; 0/undefined disables. */
  idleExitMs?: number;
  chromiumPath?: string;
  cacheDir: string;
  profileDir: string;
  /** Prefer chrome-headless-shell over full Chrome when downloading. */
  leanBrowser?: boolean;
  /** Inject a non-WS management-plane connection, e.g. CLI WebRTC. */
  connectionFactory?: () => Promise<HeadlessHostServerConnection>;
  /** Override the CDP host-provider bridge transport, e.g. RPC stream over WebRTC. */
  bridgeSocketFactory?: (url: string) => CdpHostBridgeSocket;
  lifecycle?: {
    onRegistered?: () => void;
    onBridgeDiagnostic?: (diagnostic: CdpHostBridgeDiagnostic) => void;
    onReady?: () => void;
  };
}

export interface ConfigOverrides {
  serverUrl?: string;
  /** Server-spawned child capability received over the private IPC channel. */
  ipcToken?: string;
  label?: string;
  clientSessionId?: string;
  maxPanels?: number;
  idleUnloadMs?: number;
  idleExitMs?: number;
  chromiumPath?: string;
  cacheDir?: string;
  profileDir?: string;
  leanBrowser?: boolean;
  connectionFactory?: () => Promise<HeadlessHostServerConnection>;
  bridgeSocketFactory?: (url: string) => CdpHostBridgeSocket;
  lifecycle?: HeadlessHostConfig["lifecycle"];
}

// Parse an optional non-negative integer env var, honoring an explicit 0 (so `|| undefined`
// doesn't silently swallow it). Returns undefined for missing or non-numeric values.
function parseOptionalNonNegativeInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function resolveConfig(
  overrides: ConfigOverrides = {},
  env = process.env
): HeadlessHostConfig {
  const serverUrl = overrides.serverUrl ?? env["VIBESTUDIO_SERVER_URL"];
  if (!serverUrl) {
    throw new Error("headless-host: serverUrl is required");
  }
  const auth: HeadlessHostConfig["auth"] = overrides.connectionFactory
    ? { kind: "injected" }
    : overrides.ipcToken
      ? { kind: "token", token: overrides.ipcToken }
      : (() => {
          throw new Error(
            "headless-host: auth requires private server IPC or an injected connection"
          );
        })();

  const idleExitEnv = env["VIBESTUDIO_HEADLESS_IDLE_EXIT_MS"];
  const clientSessionId = overrides.clientSessionId ?? `headless-${randomUUID()}`;
  const profileRoot = path.join(os.homedir(), ".local", "state", "vibestudio", "headless-host");
  return {
    serverUrl: serverUrl.replace(/\/$/, ""),
    auth,
    label: overrides.label ?? "Headless",
    clientSessionId,
    maxPanels: overrides.maxPanels ?? 8,
    idleUnloadMs: overrides.idleUnloadMs ?? 5 * 60_000,
    idleExitMs: overrides.idleExitMs ?? parseOptionalNonNegativeInt(idleExitEnv),
    chromiumPath: overrides.chromiumPath ?? env["VIBESTUDIO_CHROMIUM_PATH"],
    cacheDir: overrides.cacheDir ?? path.join(os.homedir(), ".cache", "vibestudio", "chromium"),
    // Chromium enforces a single process per user-data directory. A shared
    // profile made concurrent servers — and a server restart after an orphaned
    // browser — fail on SingletonLock. Each host session owns its own profile;
    // an explicit override remains available to tests/embedders that manage
    // their own isolation.
    profileDir:
      overrides.profileDir ?? path.join(profileRoot, profileInstanceName(clientSessionId)),
    leanBrowser: overrides.leanBrowser ?? false,
    connectionFactory: overrides.connectionFactory,
    bridgeSocketFactory: overrides.bridgeSocketFactory,
    lifecycle: overrides.lifecycle,
  };
}

function profileInstanceName(clientSessionId: string): string {
  const safe = clientSessionId
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^\.+$/g, "")
    .slice(0, 100);
  return `instance-${safe || randomUUID()}`;
}
