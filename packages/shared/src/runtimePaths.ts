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

/** Installed MXC release payload; never resolve enforcement from guest PATH. */
export function getMxcExecutable(
  appRoot: string,
  platform: string = process.platform,
  arch: string = process.arch
): string {
  if (
    !(
      (platform === "linux" && (arch === "x64" || arch === "arm64")) ||
      (platform === "darwin" && arch === "arm64") ||
      (platform === "win32" && arch === "x64")
    )
  )
    throw new Error(`Unsupported MXC product target: ${platform}-${arch}`);
  const binary =
    platform === "linux" ? "lxc-exec" : platform === "darwin" ? "mxc-exec-mac" : "wxc-exec.exe";
  return getPhysicalAppPath(appRoot, `dist/mxc/${platform}-${arch}/${binary}`);
}

/** Resolve the directory closure of trusted installed executables/libraries.
 *
 * MXC mounts runtime directories, preserving their loader-visible symlink names.
 * Admitting individual library aliases can collide with a symlink already in a
 * system mount. Admitting only realpaths loses aliases embedded in ELF loaders
 * and rpaths. Keep each link target's containing directory as well as its
 * physical directory. This deliberately grants directory-level runtime reads;
 * callers must never pass arbitrary workspace files or permission requests.
 */
export function collectInstalledRuntimeReadRoots(
  files: readonly string[],
  platform: NodeJS.Platform = process.platform
): string[] {
  const roots = new Set<string>();
  const addRoot = (root: string) => {
    if (root === path.parse(root).root) {
      throw new Error("An installed runtime cannot acquire the host filesystem root");
    }
    roots.add(root);
  };
  for (const file of files) {
    if (!path.isAbsolute(file) || file.includes("\0")) {
      throw new Error("Installed runtime files must be absolute paths");
    }
    let current = path.normalize(file);
    const visited = new Set<string>();
    for (;;) {
      if (visited.has(current)) throw new Error(`Installed runtime symlink cycle: ${file}`);
      visited.add(current);
      let info: fs.Stats;
      try {
        info = fs.lstatSync(current);
      } catch (error) {
        // macOS reports dyld shared-cache image install names, which need not
        // exist as standalone files. These protected OS libraries are supplied
        // by MXC's stock platform profile, not additional application grants.
        // Never ignore absent third-party images or missing files on Linux.
        if (
          platform === "darwin" &&
          (error as NodeJS.ErrnoException).code === "ENOENT" &&
          (current.startsWith("/System/Library/") || current.startsWith("/usr/lib/"))
        )
          break;
        throw error;
      }
      addRoot(path.dirname(current));
      if (info.isSymbolicLink()) {
        current = path.resolve(path.dirname(current), fs.readlinkSync(current));
        continue;
      }
      if (!info.isFile()) throw new Error(`Installed runtime resource is not a file: ${file}`);
      addRoot(path.dirname(fs.realpathSync(current)));
      break;
    }
  }
  // Resolve containing directory aliases as well as leaf links. The lexical
  // directories above must remain: binaries can name either spelling.
  for (const root of [...roots]) addRoot(fs.realpathSync(root));
  return [...roots]
    .filter(
      (root) => ![...roots].some((parent) => parent !== root && root.startsWith(parent + path.sep))
    )
    .sort();
}
