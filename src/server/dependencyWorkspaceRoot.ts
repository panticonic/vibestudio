import * as fs from "node:fs";
import * as path from "node:path";

export function hasDependencyWorkspaceMetadata(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "package.json")) ||
    fs.existsSync(path.join(dir, "pnpm-lock.yaml")) ||
    fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))
  );
}

export function resolveDependencyWorkspaceRoot(activeWorkspacePath: string): string {
  if (hasDependencyWorkspaceMetadata(activeWorkspacePath)) return activeWorkspacePath;
  throw new Error(
    `Active semantic workspace ${activeWorkspacePath} has no dependency workspace metadata`
  );
}
