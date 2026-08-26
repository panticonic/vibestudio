#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
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

function relativeInside(root, target, label) {
  const relative = path.relative(root, target);
  if (!relative || relative === ".") return ".";
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} must be inside the retained artifact root`);
  }
  return relative;
}

function copyArtifactTree(source, destination, excludedRoots) {
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: true,
    preserveTimestamps: true,
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

/**
 * Publish one deliberately simple, self-contained historical launch set.
 * The application tree and runtime executable are copied; retained markers
 * never point back into a mutable install or source checkout.
 */
export function publishHistoricalHostSnapshot(input) {
  const artifactRoot = fs.realpathSync(input.artifactRoot);
  const appRoot = fs.realpathSync(input.appRoot);
  const serverEntry = fs.realpathSync(input.serverEntry);
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
    const executableName = process.platform === "win32" ? "host.exe" : "host";
    const retainedExecutable = path.join(staging, "runtime", executableName);
    fs.mkdirSync(path.dirname(retainedExecutable), { recursive: true });
    fs.copyFileSync(executable, retainedExecutable);
    fs.chmodSync(retainedExecutable, 0o500);

    const marker = {
      version: 1,
      systemEpoch,
      appVersion: input.appVersion,
      executable: path.relative(staging, retainedExecutable),
      serverEntry: path.join("app", relativeInside(artifactRoot, serverEntry, "Server entry")),
      appRoot: path.join("app", relativeInside(artifactRoot, appRoot, "Application root")),
    };
    for (const relative of [marker.executable, marker.serverEntry, marker.appRoot]) {
      if (!fs.existsSync(path.join(staging, relative))) {
        throw new Error(`Retained host is incomplete: ${relative}`);
      }
    }
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
  const repositoryRoot = path.resolve(
    options["artifact-root"] ?? new URL("..", import.meta.url).pathname
  );
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
