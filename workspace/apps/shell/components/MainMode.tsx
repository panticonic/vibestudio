import { useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Dialog } from "@radix-ui/themes";

import { workspaceChooserDialogOpenAtom, shellOverlayActiveAtom } from "../state/appModeAtoms";
import { view } from "../shell/client";
import { useShellOverlay } from "../shell/useShellOverlay";
import { PanelApp } from "./PanelApp";
import { WorkspaceChooser } from "./WorkspaceChooser";
import { WorkspaceWizard } from "./WorkspaceWizard";

/**
 * Main mode: shows panel app with dialogs for workspace chooser and wizard.
 * Extracted for React.lazy code splitting — this pulls in PanelApp, PanelStack,
 * TitleBar, LazyPanelTreeSidebar, @dnd-kit/*, and all transitive deps.
 */
export default function MainMode() {
  const workspaceChooserOpen = useAtomValue(workspaceChooserDialogOpenAtom);
  const setWorkspaceChooserOpen = useSetAtom(workspaceChooserDialogOpenAtom);
  const shellOverlayActive = useAtomValue(shellOverlayActiveAtom);

  // Register shell overlays — hides panel views so dialogs aren't obscured
  useShellOverlay(workspaceChooserOpen);

  // Sync overlay state to main process
  useEffect(() => {
    void view.setShellOverlay(shellOverlayActive);
  }, [shellOverlayActive]);

  useEffect(() => {
    void view
      .setHostedShellReady({ ready: true })
      .catch((err: unknown) => console.warn("[MainMode] Hosted shell ready failed:", err));
    const markNotReady = () => {
      void view.setHostedShellReady({ ready: false }).catch(() => {});
    };
    window.addEventListener("pagehide", markNotReady);
    window.addEventListener("beforeunload", markNotReady);
    return () => {
      window.removeEventListener("pagehide", markNotReady);
      window.removeEventListener("beforeunload", markNotReady);
    };
  }, []);

  return (
    <>
      <PanelApp />
      <WorkspaceWizard />

      {/* Workspace Chooser Dialog (for switching workspaces in main mode) */}
      <Dialog.Root open={workspaceChooserOpen} onOpenChange={setWorkspaceChooserOpen}>
        <Dialog.Content maxWidth="920px">
          <WorkspaceChooser />
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}
