import {
  connectMobileHubControl,
  createStoredShellCredential,
  loadShellCredential,
  persistStoredShellCredential,
  type MobileHubControlConnection,
  type MobileHubWorkspace,
  type MobileHubWorkspaceRoute,
  type StoredShellCredential,
} from "@vibestudio/mobile-webrtc";
import { resetToNativeBootstrap } from "./auth";

export interface MobileWorkspaceSelectionDependencies {
  loadCredential(): Promise<StoredShellCredential | null>;
  connectControl(stored: StoredShellCredential): Promise<MobileHubControlConnection>;
  persistCredential(stored: StoredShellCredential): Promise<void>;
  reloadBootstrap(): Promise<{ reloading: boolean }>;
}

const defaultDependencies: MobileWorkspaceSelectionDependencies = {
  loadCredential: loadShellCredential,
  connectControl: connectMobileHubControl,
  persistCredential: persistStoredShellCredential,
  reloadBootstrap: resetToNativeBootstrap,
};

function missingCredentialError(): Error {
  return new Error("No current mobile device credential is stored. Pair this device again.");
}

async function closeControlConnection(control: MobileHubControlConnection): Promise<void> {
  try {
    await control.close();
  } catch (error) {
    // Cleanup happens after the user-visible operation has settled. Surface a
    // close failure without replacing a successful reload or the real routing /
    // rollback error with a secondary transport teardown error.
    console.warn("[mobile-workspaces] control connection cleanup failed", error);
  }
}

/** List account-visible workspaces through the durable control reach. */
export async function listMobileWorkspaces(
  dependencies: MobileWorkspaceSelectionDependencies = defaultDependencies
): Promise<MobileHubWorkspace[]> {
  const stored = await dependencies.loadCredential();
  if (!stored) throw missingCredentialError();
  const control = await dependencies.connectControl(stored);
  try {
    return await control.client.listWorkspaces();
  } finally {
    await closeControlConnection(control);
  }
}

/**
 * Select a workspace without touching the live workspace session until the
 * handoff is committed. The new exact reach is in Keychain before native bundle
 * reset/reload starts. If reset fails, the prior workspace reach is restored and
 * the existing ShellClient remains active.
 */
export async function selectMobileWorkspace(
  workspace: string,
  dependencies: MobileWorkspaceSelectionDependencies = defaultDependencies
): Promise<MobileHubWorkspaceRoute> {
  if (!workspace.trim() || workspace !== workspace.trim()) {
    throw new Error("Choose a valid workspace name.");
  }
  const initialStored = await dependencies.loadCredential();
  if (!initialStored) throw missingCredentialError();

  const control = await dependencies.connectControl(initialStored);
  let baseline = control.getStoredCredential();
  let selectionWriteAttempted = false;
  try {
    const route = await control.client.routeWorkspace({ workspace });
    // A control-session authentication may rotate the refresh secret. Always
    // base the selected record (and any rollback) on that latest durable value.
    baseline = control.getStoredCredential();
    const selected = createStoredShellCredential(
      { deviceId: baseline.deviceId, refreshToken: baseline.refreshToken },
      route.controlReach,
      route.workspaceReach,
      baseline.pairedAt
    );
    selectionWriteAttempted = true;
    await dependencies.persistCredential(selected);

    const reset = await dependencies.reloadBootstrap();
    if (reset.reloading !== true) {
      throw new Error("The native host did not start the workspace reload.");
    }
    return route;
  } catch (error) {
    if (selectionWriteAttempted) {
      try {
        await dependencies.persistCredential(baseline);
      } catch (rollbackError) {
        const selectionMessage = error instanceof Error ? error.message : String(error);
        const rollbackMessage =
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(
          `Workspace selection failed (${selectionMessage}) and the previous secure credential could not be restored (${rollbackMessage}).`
        );
      }
    }
    throw error;
  } finally {
    await closeControlConnection(control);
  }
}
