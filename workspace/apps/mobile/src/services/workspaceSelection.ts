import {
  createPairedMobileConnection,
  createRoutedMobileConnection,
  loadShellCredential,
  persistStoredMobileConnection,
  type MobileHubWorkspace,
  type MobileHubWorkspaceRoute,
  type StoredMobileConnection,
} from "@vibestudio/mobile-webrtc";
import { resetToNativeBootstrap } from "./auth";

export interface MobileWorkspaceSelectionDependencies {
  control: {
    listWorkspaces(): Promise<MobileHubWorkspace[]>;
    routeWorkspace(input: { workspaceId: string }): Promise<MobileHubWorkspaceRoute>;
  };
  loadCredential(): ReturnType<typeof loadShellCredential>;
  persistCredential(stored: StoredMobileConnection): Promise<void>;
  reloadBootstrap(): Promise<{ reloading: boolean }>;
}

export function mobileWorkspaceSelectionDependencies(
  control: MobileWorkspaceSelectionDependencies["control"]
): MobileWorkspaceSelectionDependencies {
  return {
    control,
    loadCredential: loadShellCredential,
    persistCredential: persistStoredMobileConnection,
    reloadBootstrap: resetToNativeBootstrap,
  };
}

function missingCredentialError(): Error {
  return new Error("No current mobile device credential is stored. Pair this device again.");
}

/** List account-visible workspaces through the already-retained hub session. */
export async function listMobileWorkspaces(
  dependencies: MobileWorkspaceSelectionDependencies
): Promise<MobileHubWorkspace[]> {
  return dependencies.control.listWorkspaces();
}

/**
 * Select a workspace without touching the live workspace session until the
 * handoff is committed. The new exact reach is in Keychain before native bundle
 * reset/reload starts. If reset fails, the prior workspace reach is restored and
 * the existing ShellClient remains active.
 */
export async function selectMobileWorkspace(
  workspaceId: string,
  dependencies: MobileWorkspaceSelectionDependencies
): Promise<MobileHubWorkspaceRoute> {
  if (!workspaceId.trim() || workspaceId !== workspaceId.trim()) {
    throw new Error("Choose a valid workspace.");
  }
  const initialStored = await dependencies.loadCredential();
  if (!initialStored) throw missingCredentialError();
  if (initialStored.phase !== "routed") {
    throw new Error("Finish preparing the selected workspace before switching workspaces.");
  }

  const baseline = initialStored;
  let selectionWriteAttempted = false;
  try {
    const paired = createPairedMobileConnection(
      baseline.credential,
      baseline.controlPairing,
      workspaceId,
      baseline.pairedAt
    );
    selectionWriteAttempted = true;
    await dependencies.persistCredential(paired);
    const route = await dependencies.control.routeWorkspace({ workspaceId });
    if (route.workspaceId !== workspaceId) {
      throw new Error("The server routed a different workspace than the one selected.");
    }
    const selected = createRoutedMobileConnection(paired, route.workspaceReach);
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
  }
}
