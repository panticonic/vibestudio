import * as fs from "node:fs";
import * as path from "node:path";
import { resolveWorkspaceTemplateDir } from "@vibestudio/shared/workspace/loader";

export function hasDependencyWorkspaceMetadata(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, "package.json")) ||
    fs.existsSync(path.join(dir, "pnpm-lock.yaml")) ||
    fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))
  );
}

export function resolveDependencyWorkspaceRoot(
  appRoot: string,
  activeWorkspacePath: string
): string {
  const templateDir = resolveWorkspaceTemplateDir(appRoot);
  if (templateDir && hasDependencyWorkspaceMetadata(templateDir)) return templateDir;
  if (hasDependencyWorkspaceMetadata(activeWorkspacePath)) return activeWorkspacePath;
  return templateDir ?? activeWorkspacePath;
}
