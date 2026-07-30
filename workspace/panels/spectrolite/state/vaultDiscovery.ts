/** Discover present `projects/*` repositories by walking the semantic state. */

import { contextId, vcs } from "@workspace/runtime";

export interface VaultEntry {
  name: string;
  repoRoot: string;
}

export async function discoverVaults(): Promise<VaultEntry[]> {
  if (!contextId) return [];
  const status = await vcs.status({ contextId });
  const entries: VaultEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await vcs.neighbors({
      root: status.workingHead,
      limit: 500,
      ...(cursor ? { cursor } : {}),
    });
    const repositories = page.edges.flatMap((edge) =>
      edge.kind === "contains-repository" && edge.to.kind === "repository" ? [edge.to] : []
    );
    const inspected = await Promise.all(
      repositories.map((node) => vcs.inspect({ node, edgeLimit: 1 }))
    );
    for (const result of inspected) {
      if (result.node.kind !== "repository" || result.node.value.kind !== "present") continue;
      const repoRoot = result.node.value.repoPath;
      if (!repoRoot.startsWith("projects/")) continue;
      entries.push({
        name: repoRoot.slice("projects/".length),
        repoRoot,
      });
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}
