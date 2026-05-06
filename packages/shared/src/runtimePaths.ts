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
  const resourcesRoot =
    appRoot.endsWith(".asar")
      ? typeof process.resourcesPath === "string"
        ? process.resourcesPath
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
  return dedupePaths([
    path.join(layout.appUnpackedRoot, "node_modules"),
    path.join(layout.appRoot, "node_modules"),
  ]).filter((p) => fs.existsSync(p));
}

export function getWorkspaceTemplateCandidates(appRoot: string): string[] {
  const layout = createRuntimeLayout(appRoot);
  return dedupePaths([
    path.join(layout.resourcesRoot, "workspace-template"),
    path.join(layout.appRoot, "workspace"),
  ]);
}

export function getExistingWorkspaceTemplateDir(
  appRoot: string,
  configFile: string,
): string | null {
  for (const candidate of getWorkspaceTemplateCandidates(appRoot)) {
    if (fs.existsSync(path.join(candidate, configFile))) {
      return candidate;
    }
  }
  return null;
}

export function getPlatformPackageBinaryPath(
  appRoot: string,
  packageName: string,
  binaryName: string,
): string {
  return getPhysicalAppPath(
    appRoot,
    path.join("node_modules", ...packageName.split("/"), "bin", binaryName),
  );
}
