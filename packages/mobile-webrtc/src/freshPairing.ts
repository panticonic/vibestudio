import { ConnectionInfoResponseSchema } from "@vibestudio/shared/serviceSchemas/auth";
import { HubWorkspaceRouteSchema } from "@vibestudio/shared/serviceSchemas/hubControl";
import type { WebRtcConnection } from "./connect.js";
import type { ShellCredential, ShellPairing } from "./storedCredential.js";

export interface CompleteFreshMobilePairingOptions {
  connection: WebRtcConnection;
  credential: ShellCredential | null;
  persistCredential(
    credential: ShellCredential,
    controlPairing: ShellPairing,
    workspacePairing: ShellPairing
  ): Promise<void>;
}

/**
 * Commit a freshly redeemed mobile pairing as one fail-closed transaction.
 * The authenticated child identifies its workspace, the hub returns both exact
 * durable reaches, and Keychain persistence completes before success is exposed.
 * Every post-connect failure closes the session so a retry cannot accumulate a
 * half-paired keepalive loop.
 */
export async function completeFreshMobilePairing(
  options: CompleteFreshMobilePairingOptions
): Promise<WebRtcConnection> {
  const { connection, credential, persistCredential } = options;
  try {
    if (!credential) {
      throw new Error("Fresh pairing did not issue a current mobile device credential");
    }
    const workspace = await connection.rpc.call<unknown>("main", "workspace.getActive", []);
    if (typeof workspace !== "string" || !workspace) {
      throw new Error("Paired workspace did not report its active name");
    }
    const connectionInfo = ConnectionInfoResponseSchema.parse(
      await connection.rpc.call("main", "auth.getConnectionInfo", [])
    );
    const route = HubWorkspaceRouteSchema.parse(
      await connection.rpc.call("main", "hubControl.routeWorkspace", [{ workspace }])
    );
    if (
      route.workspace !== workspace ||
      route.workspaceId !== connectionInfo.workspaceId ||
      route.serverId !== connectionInfo.serverId ||
      route.serverBootId !== connectionInfo.serverBootId
    ) {
      throw new Error("Workspace route changed the authenticated server or workspace identity");
    }
    await persistCredential(credential, route.controlReach, route.workspaceReach);
    connection.deviceId = credential.deviceId;
    return connection;
  } catch (error) {
    try {
      await connection.close();
    } catch (closeError) {
      const failure = error instanceof Error ? error.message : String(error);
      const cleanup = closeError instanceof Error ? closeError.message : String(closeError);
      throw new Error(
        `Fresh pairing failed (${failure}) and connection cleanup failed (${cleanup})`
      );
    }
    throw error;
  }
}
