import { HubWorkspaceRouteSchema, hubControlMethods } from "@vibestudio/service-schemas/hubControl";
import type { PairingContext } from "@vibestudio/rpc/protocol/wsProtocol";
import type { IrohConnection } from "./connect.js";
import { composeMobileSession } from "./connectionPair.js";
import {
  createPairedMobileConnection,
  createRoutedMobileConnection,
  selectMobileConnectionWorkspace,
  type ShellCredential,
  type FreshShellPairing,
  type StoredShellPairing,
  type StoredMobileConnection,
} from "./storedCredential.js";

export interface CompleteFreshMobilePairingOptions {
  /** Stable-hub pipe retained alongside the selected workspace pipe. */
  controlConnection: IrohConnection;
  credential: ShellCredential | null;
  pairingContext: PairingContext | null;
  controlPairing: FreshShellPairing;
  persistConnection(connection: StoredMobileConnection): Promise<void>;
  /** Open the actual workspace pipe after the durable route is committed. */
  connectWorkspace(
    workspacePairing: StoredShellPairing,
    credential: ShellCredential,
    controlConnection: IrohConnection
  ): Promise<IrohConnection>;
}

/**
 * Commit a freshly redeemed mobile pairing as one fail-closed transaction.
 * The pairing issuer authenticates the account. The hub ensures its private
 * workspaces and selects System as the native app source; Keychain persistence
 * completes before success is exposed.
 * Every post-connect failure closes the session so a retry cannot accumulate a
 * half-paired keepalive loop.
 */
export async function completeFreshMobilePairing(
  options: CompleteFreshMobilePairingOptions
): Promise<IrohConnection> {
  const {
    controlConnection,
    credential,
    pairingContext,
    controlPairing,
    persistConnection,
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
    const paired = createPairedMobileConnection(
      credential,
      controlPairing,
      pairingContext.workspaceId,
      controlConnection.endpointIdentityId
    );
    await persistConnection(paired);
    const pair = hubControlMethods.ensureUserWorkspaces.returns.parse(
      await controlConnection.rpc.call("main", "hubControl.ensureUserWorkspaces", [])
    );
    const source = selectMobileConnectionWorkspace(paired, pair.system.workspaceId);
    const route = HubWorkspaceRouteSchema.parse(
      await controlConnection.rpc.call("main", "hubControl.routeWorkspace", [
        { workspaceId: source.selectedWorkspaceId },
      ])
    );
    if (route.workspaceId !== source.selectedWorkspaceId) {
      throw new Error("Workspace route changed the System app source");
    }
    const routed = createRoutedMobileConnection(source, route.workspaceReach);
    await persistConnection(routed);
    const workspaceConnection = await connectWorkspace(
      route.workspaceReach,
      credential,
      controlConnection
    );
    workspaceConnection.deviceId = credential.deviceId;
    workspaceConnection.serverId = route.serverId;
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
