/**
 * Mobile workspace settings sheet — vault, branch, and agent management
 * in a bottom sheet (nested dropdowns are awkward on touch).
 */

import { BottomSheet } from "./BottomSheet";
import { WorkspaceSettingsContent } from "../drawers";
import { useApp } from "../../app/context";

export function WorkspaceSettingsSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const app = useApp();
  return (
    <BottomSheet open={open} onOpenChange={onOpenChange} title="Workspace">
      <WorkspaceSettingsContent
        onSwitchVault={() => {
          onOpenChange(false);
          void app.vault.switchVault();
        }}
      />
    </BottomSheet>
  );
}
