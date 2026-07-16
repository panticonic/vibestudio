import { RpcClient } from "@vibestudio/direct-client";
import type { CliCredentials } from "./credentialStore.js";
import {
  clearSystemTestTarget,
  loadSystemTestTarget,
  type StoredSystemTestTarget,
} from "./systemTestStore.js";

export interface VerifiedLocalWorkspaceClient {
  client: RpcClient;
  target: StoredSystemTestTarget;
}

export interface VerifiedLocalWorkspaceClientResolution {
  local: VerifiedLocalWorkspaceClient | null;
  unavailableReason?: string;
}

/**
 * Reopen the loopback route last proved by `system-test doctor` with the same
 * paired device principal. The cached URL is only a route hint: every process
 * rechecks the full host incarnation before using it, then pins subsequent
 * calls to that server/workspace identity.
 *
 * This is intentionally shared by system-test orchestration and approval CLI
 * commands. A local test runner and its approval operator must not contend for
 * the paired host's single WebRTC offerer room merely because they are separate
 * processes. Remote hosts continue to use WebRTC when no verified loopback
 * route exists.
 */
export async function resolveVerifiedLocalWorkspaceClient(
  credentials: CliCredentials
): Promise<VerifiedLocalWorkspaceClientResolution> {
  const target = loadSystemTestTarget();
  if (
    !target ||
    target.pairedUrl !== credentials.url ||
    target.workspaceName !== credentials.workspaceName ||
    target.serverId !== credentials.serverId
  ) {
    return { local: null };
  }

  const client = new RpcClient(
    {
      url: target.serverUrl,
      deviceId: credentials.deviceId,
      refreshToken: credentials.refreshToken,
    },
    {
      expectedHost: {
        serverId: target.serverId,
        workspaceId: target.workspaceId,
      },
      clientLabel: "Vibestudio local CLI side-channel",
    }
  );
  try {
    const info = await client.call<Record<string, unknown>>("auth.getConnectionInfo", []);
    if (
      info["serverId"] !== target.serverId ||
      info["serverBootId"] !== target.serverBootId ||
      info["workspaceId"] !== target.workspaceId
    ) {
      throw new Error("the gateway identity no longer matches the doctor-verified target");
    }
    return { local: { client, target } };
  } catch (error) {
    await client.close().catch(() => undefined);
    clearSystemTestTarget();
    return {
      local: null,
      unavailableReason: error instanceof Error ? error.message : String(error),
    };
  }
}
