import { lstatSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { WORKSPACE_IMPORT_PARENT_DIRS } from "./sourceDirs.js";

export { WORKSPACE_IMPORT_PARENT_DIRS } from "./sourceDirs.js";

export function isSupportedImportRepoPath(repoPath: string): boolean {
  const [parent, child] = repoPath.split("/");
  return !!child && (WORKSPACE_IMPORT_PARENT_DIRS as readonly string[]).includes(parent ?? "");
}

export function resolveWorkspaceRepoPath(
  workspacePath: string,
  repoPath: string
): {
  absolutePath: string;
  normalizedRepoPath: string;
} {
  const workspaceAbs = resolve(workspacePath);
  const absolutePath = resolve(workspaceAbs, repoPath);
  const rel = relative(workspaceAbs, absolutePath);
  if (rel.length > 0 && (rel.startsWith("..") || isAbsolute(rel))) {
    throw new Error("Invalid workspace unit path: escapes workspace root");
  }
  return { absolutePath, normalizedRepoPath: rel || "." };
}

export function assertWorkspaceCreateTargetSafe(
  workspacePath: string,
  absolutePath: string,
  operation: string
): void {
  let current = dirname(absolutePath);
  const workspaceAbs = resolve(workspacePath);
  while (current.length >= workspaceAbs.length) {
    try {
      const st = lstatSync(current);
      if (st.isSymbolicLink()) {
        throw new Error(`Refusing to ${operation}: ancestor "${current}" is a symlink`);
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }
    if (current === workspaceAbs) break;
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
  try {
    const tStat = lstatSync(absolutePath);
    if (tStat.isSymbolicLink()) {
      throw new Error(`Refusing to ${operation}: target "${absolutePath}" is a symlink`);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}
