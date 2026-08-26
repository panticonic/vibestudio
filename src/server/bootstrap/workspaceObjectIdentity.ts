import { createHash } from "node:crypto";

/**
 * Derive the stable semantic context owned by one workspace Durable Object.
 *
 * The identity is deterministic within a workspace, while remaining a valid
 * context slug wherever the build system forms a `ctx:<contextId>` ref.
 */
export function canonicalWorkspaceObjectContextId(
  workspaceId: string,
  identity: { source: string; className: string; key: string }
): string {
  const digest = createHash("sha256")
    .update(`${workspaceId}\x00${identity.source}\x00${identity.className}\x00${identity.key}`)
    .digest("hex")
    .slice(0, 32);
  return `object-${digest}`;
}
