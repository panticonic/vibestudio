export function normalizeUnitRepoPath(repoPath: string): string {
  return repoPath
    .replace(/^\/+/, "")
    .replace(/^workspace\//, "")
    .replace(/\/+$/, "");
}
