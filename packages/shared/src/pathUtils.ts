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

  const root = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/u, "");
  const absolutePath = `${root}/${normalized}`;

  return { relativePath: normalized, absolutePath };
}
