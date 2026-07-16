import { atom } from "jotai";
import type { WorkspaceEntry } from "@vibestudio/shared/types";
import { app, workspace } from "../shell/client.js";

// =============================================================================
// Workspace State
// =============================================================================

/**
 * List of workspaces
 */
export const recentWorkspacesAtom = atom<WorkspaceEntry[]>([]);

/**
 * Whether workspaces are currently loading
 */
export const workspacesLoadingAtom = atom(false);

/**
 * Name of the currently active workspace
 */
export const activeWorkspaceNameAtom = atom<string | null>(null);

/**
 * Transient error for workspace operations (dismissable)
 */
export const workspaceErrorAtom = atom<string | null>(null);
/** True while this shell is connected to a paired remote workspace server. */
export const remoteWorkspaceModeAtom = atom(false);

// =============================================================================
// Panel Pin State (client-local)
// =============================================================================

/**
 * Slot ids of client-local pinned panels, mirrored from the main process pin
 * store. Read by the 📌 indicators (header + tree row); replaced wholesale on
 * startup and on every tree-snapshot update (named-panel slot ids are reused
 * after remove+recreate, so a stale pin must be reconciled, not just seeded).
 */
export const pinnedPanelIdsAtom = atom<Set<string>>(new Set<string>());

/**
 * Monotonic counter bumped on every local pin mutation (toggle). The tree-driven
 * reconcile captures it before fetching `listPinnedPanelIds()` and discards a
 * resolved response if a toggle happened meanwhile — so a stale in-flight
 * reconcile can't clobber a just-toggled optimistic update.
 */
export const pinMutationSeqAtom = atom<number>(0);

/**
 * Load workspaces from main process
 */
export const loadRecentWorkspacesAtom = atom(null, async (_get, set) => {
  set(workspacesLoadingAtom, true);
  try {
    const [workspaces, activeName, appInfo] = await Promise.all([
      workspace.list(),
      workspace.getActive(),
      app.getInfo(),
    ]);
    set(recentWorkspacesAtom, workspaces);
    set(activeWorkspaceNameAtom, activeName);
    // Connection liveness and connection topology are different concerns. A
    // temporarily disconnected remote must not expose local-only create/delete
    // controls that still target the remote workspace service.
    set(remoteWorkspaceModeAtom, appInfo.connectionMode === "remote");
    set(workspaceErrorAtom, null);
  } catch (error) {
    console.error("Failed to load workspaces:", error);
    set(
      workspaceErrorAtom,
      `Couldn't load workspaces: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    set(workspacesLoadingAtom, false);
  }
});

/**
 * Delete a workspace — reloads full list on success, sets error on failure.
 */
export const removeRecentWorkspaceAtom = atom(null, async (_get, set, name: string) => {
  try {
    await workspace.delete(name);
    set(workspaceErrorAtom, null);
    // Reload full list to ensure consistency with disk state
    const [workspaces, activeName] = await Promise.all([workspace.list(), workspace.getActive()]);
    set(recentWorkspacesAtom, workspaces);
    set(activeWorkspaceNameAtom, activeName);
  } catch (error) {
    set(
      workspaceErrorAtom,
      `Failed to delete "${name}": ${error instanceof Error ? error.message : String(error)}`
    );
    // Reload list anyway to sync with disk
    try {
      const workspaces = await workspace.list();
      set(recentWorkspacesAtom, workspaces);
    } catch (reloadErr) {
      console.error("Failed to reload workspace list:", reloadErr);
    }
  }
});

// =============================================================================
// Workspace Choice State
// =============================================================================

/**
 * Choose and open a workspace (triggers app relaunch)
 */
export const chooseWorkspaceAtom = atom(null, async (_get, _set, name: string) => {
  try {
    // The Electron hub-control adapter durably stores the exact returned child
    // route and relaunches. Chrome never exchanges or reconstructs credentials.
    await workspace.select(name);
  } catch (error) {
    console.error("Failed to choose workspace:", error);
    throw error;
  }
});

// =============================================================================
// Settings State
// =============================================================================

/**
 * Whether settings dialog is open
 */
export const settingsDialogOpenAtom = atom(false);

// =============================================================================
// Workspace Chooser State (for switch workspace dialog)
// =============================================================================

/**
 * Whether workspace chooser dialog is open
 */
export const workspaceChooserDialogOpenAtom = atom(false);

// =============================================================================
// Workspace Wizard State
// =============================================================================

/**
 * Whether workspace wizard dialog is open
 */
export const wizardDialogOpenAtom = atom(false);

// =============================================================================
// Shell Overlay State
// =============================================================================

/**
 * Idempotent overlay-owner registry. Each shell dialog registers its stable
 * hook instance while open and removes only that owner on close. A Set avoids
 * leaked counts when React replays effects during strict-mode/remount flows.
 */
export const shellOverlayOwnersAtom = atom<ReadonlySet<string>>(new Set<string>());
export const shellOverlayActiveAtom = atom((get) => get(shellOverlayOwnersAtom).size > 0);

/**
 * Wizard form data
 */
export interface WizardFormData {
  workspaceName: string;
  forkFrom: string;
}

export const wizardFormDataAtom = atom<WizardFormData>({
  workspaceName: "",
  forkFrom: "",
});

/**
 * Whether workspace is being created
 */
export const wizardCreatingAtom = atom(false);

/**
 * Wizard error message
 */
export const wizardErrorAtom = atom<string | null>(null);

/**
 * Reset wizard state
 */
export const resetWizardAtom = atom(null, (_get, set) => {
  set(wizardFormDataAtom, { workspaceName: "", forkFrom: "" });
  set(wizardCreatingAtom, false);
  set(wizardErrorAtom, null);
});

/**
 * Create a new workspace
 */
export const createWorkspaceAtom = atom(null, async (get, set) => {
  const formData = get(wizardFormDataAtom);

  if (!formData.workspaceName) {
    set(wizardErrorAtom, "Workspace name is required");
    return null;
  }

  set(wizardCreatingAtom, true);
  set(wizardErrorAtom, null);

  try {
    const opts: { forkFrom?: string } = {};
    if (formData.forkFrom) opts.forkFrom = formData.forkFrom;
    await workspace.create(formData.workspaceName, Object.keys(opts).length > 0 ? opts : undefined);

    // Select the newly created workspace (triggers app relaunch)
    await workspace.select(formData.workspaceName);
    return true;
  } catch (error) {
    set(wizardErrorAtom, error instanceof Error ? error.message : String(error));
    return null;
  } finally {
    set(wizardCreatingAtom, false);
  }
});
