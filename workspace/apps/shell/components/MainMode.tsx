import { useCallback, useEffect } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { AppDialog } from "@workspace/ui";

import {
  connectionSettingsDialogOpenAtom,
  workspaceChooserDialogOpenAtom,
  shellOverlayActiveAtom,
} from "../state/appModeAtoms";
import { view } from "../shell/client";
import { useShellEvent } from "../shell/useShellEvent";
import { useShellOverlay } from "../shell/useShellOverlay";
import { ConnectionSettingsDialog } from "./ConnectionSettingsDialog";
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
  const connectionSettingsOpen = useAtomValue(connectionSettingsDialogOpenAtom);
  const setConnectionSettingsOpen = useSetAtom(connectionSettingsDialogOpenAtom);
  const shellOverlayActive = useAtomValue(shellOverlayActiveAtom);

  // Mounted here, not next to the badge that opens it: the badge lives in the
  // panel tree, which breadcrumb mode unmounts, but this event arrives in both.
  useShellEvent(
    "open-connection-settings",
    useCallback(() => setConnectionSettingsOpen(true), [setConnectionSettingsOpen])
  );

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

  useEffect(() => {
    const bridge = (
      globalThis as {
        __vibestudioApp?: { setChromeInteractiveFocus?: (active: boolean) => void };
      }
    ).__vibestudioApp;
    const isInteractive = (target: EventTarget | null) =>
      target instanceof Element &&
      target.closest(
        'input, textarea, select, button, a[href], [contenteditable="true"], [role="button"], [role="treeitem"], [role="dialog"], [tabindex]:not([tabindex="-1"])'
      ) !== null;
    const sync = (event: FocusEvent) =>
      bridge?.setChromeInteractiveFocus?.(isInteractive(event.target));
    const clear = () => bridge?.setChromeInteractiveFocus?.(false);
    document.addEventListener("focusin", sync, true);
    window.addEventListener("blur", clear);
    return () => {
      document.removeEventListener("focusin", sync, true);
      window.removeEventListener("blur", clear);
      clear();
    };
  }, []);

  return (
    <>
      <PanelApp />
      <WorkspaceWizard />

      {/* Workspace Chooser Dialog (for switching workspaces in main mode) */}
      <AppDialog
        open={workspaceChooserOpen}
        onOpenChange={setWorkspaceChooserOpen}
        maxWidth="920px"
      >
        <WorkspaceChooser />
      </AppDialog>

      <ConnectionSettingsDialog
        open={connectionSettingsOpen}
        onOpenChange={setConnectionSettingsOpen}
      />
    </>
  );
}
