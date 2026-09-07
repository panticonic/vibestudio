/** Native app storage belongs to one context in one authenticated workspace. */
export function contextIdToPartition(workspaceId: string, contextId: string): string {
  if (!workspaceId || !contextId) throw new Error("Workspace and context identities are required");
  return `persist:panel:${encodeURIComponent(workspaceId)}:${encodeURIComponent(contextId)}`;
}
