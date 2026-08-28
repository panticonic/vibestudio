import * as fs from "fs";
import * as path from "path";

export interface RuntimeLayout {
  appRoot: string;
  appUnpackedRoot: string;
  resourcesRoot: string;
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of paths) {
    const resolved = path.resolve(p);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(p);
  }
  return result;
}

export function createRuntimeLayout(appRoot: string): RuntimeLayout {
  const appUnpackedRoot = appRoot.replace(/\.asar$/, ".asar.unpacked");
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const resourcesRoot = appRoot.endsWith(".asar")
    ? typeof resourcesPath === "string"
      ? resourcesPath
      : path.dirname(appRoot)
    : appRoot;

  return {
    appRoot,
    appUnpackedRoot,
    resourcesRoot,
  };
}

export function getPhysicalAppPath(appRoot: string, relativePath: string): string {
  return path.join(createRuntimeLayout(appRoot).appUnpackedRoot, relativePath);
}

export function getPhysicalPathForAsarPath(filePath: string): string {
  return filePath.replace(/\.asar([/\\])/, ".asar.unpacked$1");
}

export function getExistingAppNodeModulesRoots(appRoot: string): string[] {
  const layout = createRuntimeLayout(appRoot);
  const candidates = [
    path.join(layout.appUnpackedRoot, "node_modules"),
    path.join(layout.appRoot, "node_modules"),
  ];
  // An npm package may use the node_modules directory that directly contains
  // it. That directory is part of the package installation, so include it, but
  // stop there. Walking beyond this boundary lets an unrelated node_modules in
  // a user's home directory silently become part of a published server's build
  // environment. Besides violating install ownership, that makes identical
  // Vibestudio installs compile different renderer code.
  let dir = layout.appRoot;
  while (true) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    if (path.basename(parent) === "node_modules") {
      candidates.push(parent);
      break;
    }
    dir = parent;
  }
  return dedupePaths(candidates).filter((p) => fs.existsSync(p));
}

export function getPlatformPackageBinaryPath(
  appRoot: string,
  packageName: string,
  binaryName: string
): string {
  return getPhysicalAppPath(
    appRoot,
    path.join("node_modules", ...packageName.split("/"), "bin", binaryName)
  );
}
