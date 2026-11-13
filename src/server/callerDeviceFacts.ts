import type { CallerKind } from "@vibestudio/rpc";

/**
 * Caller facts the server projects into userland Durable Object caller
 * context (`callerPanelId`, `callerDeviceId`, `callerPanelSource`).
 *
 * Every input is the server's own authenticated knowledge of the connection:
 * the verified runtime id/kind, the verified code identity, the runtime lease
 * the coordinator granted, and the hub-attested client principal row. Nothing
 * here is read from an RPC payload or anything a panel supplies.
 */
export interface CallerDeviceFacts {
  callerPanelId?: string;
  callerDeviceId?: string;
  callerPanelSource?: string;
}

export interface CallerDeviceFactSources {
  /** Stable slot identity for a panel runtime (`PanelRuntimeCoordinator.panelIdentityForRuntime`). */
  panelIdentityForRuntime(runtimeEntityId: string): string | undefined;
  /** Authenticated owner of the host session holding a panel runtime's lease. */
  presentationCallerForRuntime(runtimeEntityId: string): string | null;
  /** Device of a hub-attested, unrevoked client principal (`client:…`). */
  clientPrincipalDevice(principalId: string): string | null;
}

const SHELL_PREFIX = "shell:";

/** The local console principals: the server machine's own desktop app and headless host. */
const LOCAL_CONSOLE_PRINCIPALS: ReadonlySet<string> = new Set(["electron-main", "headless-host"]);

/**
 * The device behind an authenticated host principal. `shell:<deviceId>` is
 * the device shell session itself; a `client` principal carries its attested
 * device. The local consoles (`electron-main`, `headless-host`) are this
 * machine and are named `local:<principal>`, so a panel can be placed on them
 * and their panels carry a stable device origin. Every other principal has no
 * device.
 */
export function deviceIdOfHostPrincipal(
  principalId: string,
  sources: Pick<CallerDeviceFactSources, "clientPrincipalDevice">
): string | null {
  if (LOCAL_CONSOLE_PRINCIPALS.has(principalId)) return `local:${principalId}`;
  if (principalId.startsWith(SHELL_PREFIX)) {
    const deviceId = principalId.slice(SHELL_PREFIX.length);
    return deviceId.length > 0 ? deviceId : null;
  }
  if (principalId.startsWith("client:")) return sources.clientPrincipalDevice(principalId);
  return null;
}

export function resolveCallerDeviceFacts(
  caller: {
    runtime: { id: string; kind: CallerKind };
    code?: { repoPath: string };
  },
  sources: CallerDeviceFactSources
): CallerDeviceFacts {
  const { id, kind } = caller.runtime;
  if (kind === "panel") {
    const callerPanelId = sources.panelIdentityForRuntime(id);
    const host = sources.presentationCallerForRuntime(id);
    const callerDeviceId = host ? deviceIdOfHostPrincipal(host, sources) : null;
    const callerPanelSource = caller.code?.repoPath;
    return {
      ...(callerPanelId ? { callerPanelId } : {}),
      ...(callerDeviceId ? { callerDeviceId } : {}),
      ...(callerPanelSource ? { callerPanelSource } : {}),
    };
  }
  if (kind === "shell" || kind === "client") {
    const callerDeviceId = deviceIdOfHostPrincipal(id, sources);
    return callerDeviceId ? { callerDeviceId } : {};
  }
  return {};
}
