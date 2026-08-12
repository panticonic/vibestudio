import type { HostCommand } from "@vibestudio/shared/hostCommands";

const CONTRIBUTED_COMMAND_PREFIX = "contributed-panel-command:";

export interface MobileContributedHostCommand {
  id: string;
  label: string;
  description?: string;
}

/** Present renderer-contributed commands as native action-sheet rows. */
export function presentMobileHostCommands(
  commands: readonly HostCommand[]
): MobileContributedHostCommand[] {
  return commands.map((command) => {
    const description = [command.group, command.description].filter(Boolean).join(" · ");
    return {
      id: `${CONTRIBUTED_COMMAND_PREFIX}${encodeURIComponent(command.id)}`,
      label: command.label,
      ...(description ? { description } : {}),
    };
  });
}

export function contributedHostCommandId(actionSheetId: string): string | null {
  if (!actionSheetId.startsWith(CONTRIBUTED_COMMAND_PREFIX)) return null;
  try {
    return decodeURIComponent(actionSheetId.slice(CONTRIBUTED_COMMAND_PREFIX.length));
  } catch {
    return null;
  }
}
