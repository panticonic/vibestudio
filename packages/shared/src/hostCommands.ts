/**
 * A command contributed by hosted content to its owning application shell.
 * The contract describes intent; each host chooses an idiomatic presentation
 * such as the desktop command palette or a native mobile action sheet.
 */
export interface HostCommand {
  /** Stable id, unique within the contributing panel. */
  id: string;
  label: string;
  /** Optional supporting copy shown by hosts that have room for it. */
  description?: string;
  /** Optional grouping label, usually the contributing feature or panel. */
  group?: string;
}

export const HOST_COMMAND_CONTRIBUTION_EVENT = "runtime:host-command-contribution";
export const HOST_COMMAND_RUN_EVENT = "runtime:host-command-run";
