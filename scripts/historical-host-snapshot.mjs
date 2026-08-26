#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import semver from "semver";

export const HISTORICAL_HOST_MARKER = "workspace-host.json";

export function semverMajor(version) {
  if (!semver.valid(version)) throw new Error(`Invalid Vibestudio application SemVer: ${version}`);
  return semver.major(version);
}

export function defaultCentralDataPath(env = process.env, platform = process.platform) {
  const instanceRoot = env["VIBESTUDIO_INSTANCE_ROOT"]?.trim();
  if (instanceRoot) return path.resolve(instanceRoot);
  const home = os.homedir();
  if (platform === "win32") {
    return path.join(env["APPDATA"] ?? path.join(home, "AppData", "Roaming"), "vibestudio");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "vibestudio");
  }
  return path.join(env["XDG_CONFIG_HOME"] ?? path.join(home, ".config"), "vibestudio");
}

export function artifactRootFromModuleUrl(moduleUrl = import.meta.url) {
  return path.resolve(fileURLToPath(new URL("..", moduleUrl)));
}

function relativeInside(root, target, label) {
  const relative = path.relative(root, target);
  if (!relative || relative === ".") return ".";
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside the retained artifact root`);
  }
  return relative;
}

function pathIsInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validateContainedSymlinks(source, excludedRoots) {
  const pending = [source];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const resolved = path.resolve(entryPath);
      if (
        excludedRoots.some(
          (excluded) => resolved === excluded || resolved.startsWith(`${excluded}${path.sep}`)
        )
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      const target = fs.realpathSync(entryPath);
      if (!pathIsInside(source, target)) {
        throw new Error(`Retained host symlink escapes its artifact root: ${entryPath}`);
      }
    }
  }
}

function copyArtifactTree(source, destination, excludedRoots) {
  validateContainedSymlinks(source, excludedRoots);
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    filter: (entry) => {
      const resolved = path.resolve(entry);
      if (
        excludedRoots.some(
          (excluded) => resolved === excluded || resolved.startsWith(`${excluded}${path.sep}`)
        )
      ) {
        return false;
      }
      const relative = path.relative(source, entry);
      const first = relative.split(path.sep)[0];
      return first !== ".git" && first !== ".cache" && first !== "dist-packages";
    },
  });
}

function bundledElectronExecutable(artifactRoot, platform) {
  if (platform !== "darwin") return null;
  const electronRoot = path.join(artifactRoot, "node_modules", "electron");
  const pathFile = path.join(electronRoot, "path.txt");
  if (!fs.existsSync(pathFile)) return null;
  const relative = fs.readFileSync(pathFile, "utf8").trim();
  if (!relative) throw new Error(`Bundled Electron path is empty: ${pathFile}`);
  const executable = path.resolve(electronRoot, "dist", relative);
  if (!pathIsInside(path.join(electronRoot, "dist"), executable) || !fs.existsSync(executable)) {
    throw new Error(`Bundled Electron executable is invalid: ${relative}`);
  }
  return fs.realpathSync(executable);
}

function enclosingMacApp(executable) {
  for (let cursor = executable; path.dirname(cursor) !== cursor; cursor = path.dirname(cursor)) {
    if (cursor.endsWith(".app")) return cursor;
  }
  return null;
}

function verifyRetainedRuntime(executable, runtimeMode) {
  const result = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...(runtimeMode === "electron-node" ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    },
    timeout: 30_000,
  });
  if (result.error || result.status !== 0 || result.signal) {
    const detail = result.error?.message ?? result.stderr?.trim() ?? `status ${result.status}`;
    throw new Error(`Retained host runtime is not executable: ${detail}`);
  }
}

/**
 * Publish one deliberately simple, self-contained historical launch set.
 * The application tree and runtime executable are copied; retained markers
 * never point back into a mutable install or source checkout.
 */
export function publishHistoricalHostSnapshot(input) {
  const artifactRoot = fs.realpathSync(input.artifactRoot);
  const appRoot = fs.realpathSync(input.appRoot);
  const serverEntry = fs.realpathSync(input.serverEntry);
  const platform = input.platform ?? process.platform;
  const executable = fs.realpathSync(input.executable);
  const systemEpoch = semverMajor(input.appVersion);
  relativeInside(artifactRoot, appRoot, "Application root");
  relativeInside(artifactRoot, serverEntry, "Server entry");

  const versionsRoot = path.join(path.resolve(input.centralDataPath), "host-versions");
  fs.mkdirSync(versionsRoot, { recursive: true, mode: 0o700 });
  const destination = path.join(versionsRoot, String(systemEpoch));
  const staging = fs.mkdtempSync(path.join(versionsRoot, `.${systemEpoch}.staging-`));
  const backup = path.join(versionsRoot, `.${systemEpoch}.previous`);
  try {
    const retainedApp = path.join(staging, "app");
    copyArtifactTree(artifactRoot, retainedApp, [path.resolve(input.centralDataPath), staging]);
    const electronExecutable = bundledElectronExecutable(artifactRoot, platform);
    let retainedExecutable;
    let runtimeMode = "node";
    if (electronExecutable) {
      retainedExecutable = path.join(
        retainedApp,
        relativeInside(artifactRoot, electronExecutable, "Bundled Electron executable")
      );
      runtimeMode = "electron-node";
    } else if (platform === "darwin") {
      const sourceBundle = enclosingMacApp(executable);
      if (!sourceBundle) {
        throw new Error(
          "A macOS historical host requires the bundled Electron runtime or a complete .app runtime bundle"
        );
      }
      const retainedBundle = path.join(staging, "runtime", path.basename(sourceBundle));
      copyArtifactTree(sourceBundle, retainedBundle, []);
      retainedExecutable = path.join(
        retainedBundle,
        relativeInside(sourceBundle, executable, "macOS runtime executable")
      );
      runtimeMode = "electron-node";
    } else {
      const executableName = platform === "win32" ? "host.exe" : "host";
      retainedExecutable = path.join(staging, "runtime", executableName);
      fs.mkdirSync(path.dirname(retainedExecutable), { recursive: true });
      fs.copyFileSync(executable, retainedExecutable);
      fs.chmodSync(retainedExecutable, 0o500);
    }

    const marker = {
      version: 2,
      systemEpoch,
      appVersion: input.appVersion,
      executable: path.relative(staging, retainedExecutable),
      runtimeMode,
      serverEntry: path.join("app", relativeInside(artifactRoot, serverEntry, "Server entry")),
      appRoot: path.join("app", relativeInside(artifactRoot, appRoot, "Application root")),
    };
    for (const relative of [marker.executable, marker.serverEntry, marker.appRoot]) {
      if (!fs.existsSync(path.join(staging, relative))) {
        throw new Error(`Retained host is incomplete: ${relative}`);
      }
    }
    verifyRetainedRuntime(retainedExecutable, runtimeMode);
    fs.writeFileSync(
      path.join(staging, HISTORICAL_HOST_MARKER),
      `${JSON.stringify(marker, null, 2)}\n`,
      {
        mode: 0o600,
        flag: "wx",
      }
    );

    // A replacement is staged completely before the old compatible patch is
    // moved aside. If interrupted in the small rename gap, the previous copy
    // remains recoverable at the fixed sibling path.
    fs.rmSync(backup, { recursive: true, force: true });
    if (fs.existsSync(destination)) fs.renameSync(destination, backup);
    try {
      fs.renameSync(staging, destination);
    } catch (error) {
      if (fs.existsSync(backup) && !fs.existsSync(destination)) fs.renameSync(backup, destination);
      throw error;
    }
    fs.rmSync(backup, { recursive: true, force: true });
    return { destination, marker };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value) throw new Error("Snapshot options require values");
    options[name.slice(2)] = value;
  }
  return options;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const options = parseCli(process.argv.slice(2));
  const repositoryRoot = path.resolve(options["artifact-root"] ?? artifactRootFromModuleUrl());
  const manifest = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
  const result = publishHistoricalHostSnapshot({
    centralDataPath: path.resolve(options["central-data"] ?? defaultCentralDataPath()),
    artifactRoot: repositoryRoot,
    appRoot: path.resolve(options["app-root"] ?? repositoryRoot),
    serverEntry: path.resolve(
      options["server-entry"] ?? path.join(repositoryRoot, "dist", "server.mjs")
    ),
    executable: path.resolve(options.executable ?? process.execPath),
    appVersion: manifest.version,
  });
  console.log(`Retained Vibestudio ${manifest.version} host at ${result.destination}`);
}
