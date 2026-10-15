import type { HubWorkspaceEntry } from "@vibestudio/service-schemas/hubControl";

/**
 * The name a person sees for a workspace. The account's private pair is named
 * by role ("Personal", "System"): their stored names (`personal-ws_<id>`,
 * `system-ws_<id>`) are internal identifiers. Any other workspace shows its
 * display name, or its name when it has none.
 */
export function workspaceLabel(
  entry: Pick<HubWorkspaceEntry, "name" | "displayName" | "privateRole">
): string {
  if (entry.privateRole === "personal") return "Personal";
  if (entry.privateRole === "system") return "System";
  return entry.displayName ?? entry.name;
}
