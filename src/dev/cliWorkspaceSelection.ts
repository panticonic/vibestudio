/**
 * Which private workspace a development instance's CLI opens.
 *
 * Templates are independent repositories, so Personal and System install
 * different units and a case that needs one of them can only run where it is
 * installed. The selection is fixed when the instance pairs.
 */
export const CLI_WORKSPACE_ENV = "VIBESTUDIO_CLI_WORKSPACE";

export const CLI_WORKSPACES = ["personal", "system"] as const;

export type CliWorkspaceSelection = (typeof CLI_WORKSPACES)[number];

export function isCliWorkspaceSelection(value: unknown): value is CliWorkspaceSelection {
  return CLI_WORKSPACES.includes(value as CliWorkspaceSelection);
}
