import type { PaletteCommand } from "@vibestudio/shared/types";

const CONTRIBUTED_COMMAND_PREFIX = "contributed-panel-command:";

export interface MobileContributedPanelCommand {
  id: string;
  label: string;
  description?: string;
}

/** Present renderer-contributed commands as native action-sheet rows. */
export function presentMobilePanelCommands(
  commands: readonly PaletteCommand[]
): MobileContributedPanelCommand[] {
  return commands.map((command) => {
    const description = [command.section, command.hint].filter(Boolean).join(" · ");
    return {
      id: `${CONTRIBUTED_COMMAND_PREFIX}${encodeURIComponent(command.id)}`,
      label: command.label,
      ...(description ? { description } : {}),
    };
  });
}

export function contributedPanelCommandId(actionSheetId: string): string | null {
  if (!actionSheetId.startsWith(CONTRIBUTED_COMMAND_PREFIX)) return null;
  try {
    return decodeURIComponent(actionSheetId.slice(CONTRIBUTED_COMMAND_PREFIX.length));
  } catch {
    return null;
  }
}
