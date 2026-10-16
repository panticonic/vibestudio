export interface WorkspaceTransportIdentity {
  workspaceId: string;
  runtimeId: string;
}
const argumentPrefix = "--vibestudio-workspace-identity=";

/** Routing metadata comes from native view creation; IPC still verifies its own sender. */
export function workspaceTransportArgument(identity: WorkspaceTransportIdentity): string {
  return argumentPrefix + encodeURIComponent(JSON.stringify(identity));
}

export function readWorkspaceTransportIdentity(
  args: readonly string[]
): WorkspaceTransportIdentity {
  const argument = args.find((value) => value.startsWith(argumentPrefix));
  if (!argument) throw new Error("App transport has no workspace identity");
  const value: unknown = JSON.parse(decodeURIComponent(argument.slice(argumentPrefix.length)));
  if (
    !value ||
    typeof value !== "object" ||
    !("workspaceId" in value) ||
    !("runtimeId" in value) ||
    typeof value.workspaceId !== "string" ||
    !value.workspaceId ||
    typeof value.runtimeId !== "string" ||
    !value.runtimeId
  ) {
    throw new Error("App transport has invalid workspace identity");
  }
  return { workspaceId: value.workspaceId, runtimeId: value.runtimeId };
}
