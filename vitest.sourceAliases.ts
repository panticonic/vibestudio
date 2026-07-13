import { readFileSync } from "node:fs";
import path from "node:path";
import type { Alias } from "vite";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Resolve the workspace tsconfig's package paths for a Vitest config. */
export function workspaceSourceAliases(repoRoot: string): Alias[] {
  const workspaceTsconfig = JSON.parse(
    readFileSync(path.resolve(repoRoot, "workspace/tsconfig.json"), "utf8")
  ) as { compilerOptions?: { paths?: Record<string, string[]> } };
  const tsconfigPaths = workspaceTsconfig.compilerOptions?.paths ?? {};
  const aliases: Alias[] = [];

  // Subpath mappings must precede their less-specific bare-package mapping.
  for (const [importPath, sourcePaths] of Object.entries(tsconfigPaths).sort(
    (a, b) => b[0].length - a[0].length
  )) {
    const sourcePath = sourcePaths[0];
    if (!sourcePath) continue;

    if (importPath.includes("*") && sourcePath.includes("*")) {
      aliases.push({
        find: new RegExp(`^${escapeRegex(importPath).replace("\\*", "(.+)")}$`),
        replacement: path.resolve(repoRoot, sourcePath).replace("*", "$1"),
      });
    } else {
      aliases.push({ find: importPath, replacement: path.resolve(repoRoot, sourcePath) });
    }
  }

  return aliases;
}
