import { HubWorkspaceRouteSchema } from "@vibestudio/service-schemas/hubControl";
import type { PairingContext } from "@vibestudio/rpc/transports/pairedConnection";
import type { WebRtcConnection } from "./connect.js";
import { composeMobileSession } from "./connectionPair.js";
import type { ShellCredential, ShellPairing } from "./storedCredential.js";

export interface CompleteFreshMobilePairingOptions {
  /** Stable-hub pipe retained alongside the selected workspace pipe. */
  controlConnection: WebRtcConnection;
  credential: ShellCredential | null;
  pairingContext: PairingContext | null;
  controlPairing: ShellPairing;
  persistCredential(
    credential: ShellCredential,
    controlPairing: ShellPairing,
    workspacePairing: ShellPairing
  ): Promise<void>;
  /** Open the actual workspace pipe after the durable route is committed. */
  connectWorkspace(
    workspacePairing: ShellPairing,
    credential: ShellCredential
  ): Promise<WebRtcConnection>;
}

/**
 * Commit a freshly redeemed mobile pairing as one fail-closed transaction.
 * The pairing issuer identifies the exact workspace, the hub returns its exact
 * durable reach, and Keychain persistence completes before success is exposed.
 * Every post-connect failure closes the session so a retry cannot accumulate a
 * half-paired keepalive loop.
 */
export async function completeFreshMobilePairing(
  options: CompleteFreshMobilePairingOptions
): Promise<WebRtcConnection> {
  const {
    controlConnection,
    credential,
    pairingContext,
    controlPairing,
    persistCredential,
    connectWorkspace,
  } = options;
  let controlCloseAttempted = false;
  const closeControl = async (): Promise<void> => {
    if (controlCloseAttempted) return;
    controlCloseAttempted = true;
    await controlConnection.close();
  };
  try {
    if (!credential) {
      throw new Error("Fresh pairing did not issue a current mobile device credential");
    }
    if (!pairingContext?.workspaceId) {
      throw new Error("Fresh pairing did not identify its workspace");
    }
    const route = HubWorkspaceRouteSchema.parse(
      await controlConnection.rpc.call("main", "hubControl.routeWorkspace", [
        { workspaceId: pairingContext.workspaceId },
      ])
    );
    if (route.workspaceId !== pairingContext.workspaceId) {
      throw new Error("Workspace route changed the pairing target");
    }
    await persistCredential(credential, controlPairing, route.workspaceReach);
    const workspaceConnection = await connectWorkspace(route.workspaceReach, credential);
    workspaceConnection.deviceId = credential.deviceId;
    return composeMobileSession(controlConnection, workspaceConnection);
  } catch (error) {
    try {
      await closeControl();
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
