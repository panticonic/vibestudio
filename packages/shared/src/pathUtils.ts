/**
 * Normalizes a panel path to ensure it's relative and doesn't escape the workspace.
 * Returns the normalized relative path.
 *
 * @param panelPath - The path to normalize (must be relative)
 * @param workspaceRoot - The workspace root directory
 * @throws Error if path is absolute, empty, or escapes workspace
 */
export function normalizeRelativePanelPath(
  panelPath: string,
  workspaceRoot: string
): { relativePath: string; absolutePath: string } {
  const relativePath = normalizePanelSource(panelPath);
  const root = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/u, "");
  return { relativePath, absolutePath: `${root}/${relativePath}` };
}

/** Validate a workspace source identifier without requiring a disk checkout. */
export function normalizePanelSource(panelPath: string): string {
  const portable = panelPath.replaceAll("\\", "/");
  if (portable.startsWith("/") || /^[A-Za-z]:\//u.test(portable)) {
    throw new Error("Panel path must be relative to the workspace root");
  }

  const segments: string[] = [];
  for (const segment of portable.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        throw new Error(`Invalid panel path (must stay within workspace): ${panelPath}`);
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const normalized = segments.join("/");
  if (!normalized) {
    throw new Error(`Invalid panel path (must stay within workspace): ${panelPath}`);
  }

  return normalized;
}
