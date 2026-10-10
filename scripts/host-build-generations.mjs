import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { SOURCE_SERVER_PREREQUISITE_ARTIFACTS } from "./server-runtime-artifacts.mjs";

const NON_COMPILER_ENTRIES = new Set([
  "node",
  "mxc",
  "baked-app",
  "source-server-prerequisites.lock",
  "host-build.lock",
  "host-generations",
]);

const REQUIRED = {
  source: SOURCE_SERVER_PREREQUISITE_ARTIFACTS.map((entry) => entry.slice("dist/".length)),
  desktop: [
    "main.cjs",
    "adblock-engine-worker.cjs",
    "server-electron.cjs",
    "panelPreload.cjs",
    "browserPrivacyPreload.cjs",
    "browserTransport.js",
    "fs-disk-worker.cjs",
    "dependency-content-maintenance.cjs",
    "internal-do.bundle.mjs",
    "host-build-fingerprint.json",
    "headless-host",
    "workerd-programs",
    "assets",
  ],
};

const heldGenerations = new Map();
let exitCleanupInstalled = false;

function withGenerationLock(generations, action) {
  fs.mkdirSync(generations, { recursive: true });
  const lock = path.join(generations, ".lock");
  for (;;) {
    try {
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, "owner"), String(process.pid));
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let owner;
      try {
        owner = Number(fs.readFileSync(path.join(lock, "owner"), "utf8"));
      } catch (readError) {
        if (readError?.code !== "ENOENT") throw readError;
      }
      let alive = false;
      if (Number.isSafeInteger(owner) && owner > 0) {
        try {
          process.kill(owner, 0);
          alive = true;
        } catch (probeError) {
          if (probeError?.code !== "ESRCH") alive = true;
        }
      }
      if (!alive) {
        let modifiedAt;
        try {
          modifiedAt = fs.statSync(lock).mtimeMs;
        } catch (statError) {
          // Another contender released or reclaimed the lock between the
          // owner probe and stat. Retry acquisition from the new state.
          if (statError?.code === "ENOENT") continue;
          throw statError;
        }
        if (Date.now() - modifiedAt > 1_000) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try {
    return action();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function currentRoots(generations) {
  const roots = new Set();
  for (const kind of ["source", "desktop"]) {
    try {
      const record = JSON.parse(
        fs.readFileSync(path.join(generations, `current-${kind}.json`), "utf8")
      );
      if (typeof record.root === "string") roots.add(path.resolve(record.root));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return roots;
}

function collectHostBuildGenerationsLocked(generations) {
  const current = currentRoots(generations);
  const leases = path.join(generations, ".leases");
  for (const entry of fs.readdirSync(generations, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(".garbage-")) {
      fs.rmSync(path.join(generations, entry.name), { recursive: true, force: true });
      continue;
    }
    if (!entry.isDirectory() || !/^(source|desktop)-[a-f0-9]{64}$/u.test(entry.name)) continue;
    const root = path.join(generations, entry.name);
    if (current.has(root)) continue;
    const leaseDir = path.join(leases, entry.name);
    let inUse = false;
    try {
      for (const lease of fs.readdirSync(leaseDir)) {
        const pid = Number(lease.split("-")[0]);
        try {
          process.kill(pid, 0);
          inUse = true;
        } catch (error) {
          if (error?.code !== "ESRCH") inUse = true;
          else fs.rmSync(path.join(leaseDir, lease), { force: true });
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (inUse) continue;
    const garbage = path.join(generations, `.garbage-${randomUUID()}`);
    fs.renameSync(root, garbage);
    fs.rmSync(garbage, { recursive: true, force: true });
    fs.rmSync(leaseDir, { recursive: true, force: true });
  }
}

export function collectHostBuildGenerations(cwd = process.cwd()) {
  const generations = path.resolve(cwd, "dist/host-generations");
  if (!fs.existsSync(generations)) return;
  withGenerationLock(generations, () => collectHostBuildGenerationsLocked(generations));
}

function retainGeneration(generations, root) {
  if (heldGenerations.has(root)) return;
  const leaseDir = path.join(generations, ".leases", path.basename(root));
  fs.mkdirSync(leaseDir, { recursive: true });
  const lease = path.join(leaseDir, `${process.pid}-${randomUUID()}`);
  fs.writeFileSync(lease, "", { flag: "wx" });
  heldGenerations.set(root, { generations, lease });
  if (!exitCleanupInstalled) {
    exitCleanupInstalled = true;
    process.on("exit", () => {
      for (const heldRoot of [...heldGenerations.keys()]) releaseHostBuildGeneration(heldRoot);
    });
  }
}

export function releaseHostBuildGeneration(root) {
  const held = heldGenerations.get(root);
  if (!held) return;
  heldGenerations.delete(root);
  if (!fs.existsSync(held.generations)) return;
  withGenerationLock(held.generations, () => {
    fs.rmSync(held.lease, { force: true });
    collectHostBuildGenerationsLocked(held.generations);
  });
}

export function hostBuildGenerationRoot(cwd, kind, fingerprint) {
  return path.join(path.resolve(cwd, "dist/host-generations"), `${kind}-${fingerprint}`);
}

export function publishHostBuildGeneration(cwd, build) {
  const dist = path.resolve(cwd, "dist");
  const generations = path.join(dist, "host-generations");
  if (!(build.kind in REQUIRED)) throw new Error(`Unknown host generation kind: ${build.kind}`);
  if (!/^[a-f0-9]{64}$/u.test(build.fingerprint)) throw new Error("Invalid host build fingerprint");
  for (const artifact of REQUIRED[build.kind]) {
    if (!fs.existsSync(path.join(dist, artifact))) {
      throw new Error(
        `Cannot publish incomplete ${build.kind} host generation: missing ${artifact}`
      );
    }
  }
  return withGenerationLock(generations, () => {
    const target = hostBuildGenerationRoot(cwd, build.kind, build.fingerprint);
    if (!fs.existsSync(target)) {
      const staging = path.join(generations, `.staging-${randomUUID()}`);
      fs.mkdirSync(staging, { recursive: true });
      try {
        const entries =
          build.kind === "source"
            ? REQUIRED.source
            : fs.readdirSync(dist).filter((entry) => !NON_COMPILER_ENTRIES.has(entry));
        for (const entry of entries) {
          fs.cpSync(path.join(dist, entry), path.join(staging, entry), {
            recursive: true,
          });
        }
        const product = JSON.parse(fs.readFileSync(path.resolve(cwd, "package.json"), "utf8"));
        fs.writeFileSync(
          path.join(staging, "package.json"),
          `${JSON.stringify({
            ...product,
            ...(build.kind === "desktop" ? { main: "main.cjs" } : {}),
          })}\n`
        );
        fs.symlinkSync(
          path.resolve(cwd, "node_modules"),
          path.join(staging, "node_modules"),
          "dir"
        );
        fs.renameSync(staging, target);
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
      }
    }
    const current = path.join(generations, `current-${build.kind}.json`);
    const temporary = `${current}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, ...build, root: target })}\n`);
    fs.renameSync(temporary, current);
    collectHostBuildGenerationsLocked(generations);
    return target;
  });
}

export function readCurrentHostBuildGeneration(cwd = process.cwd(), kind) {
  if (kind !== "source" && kind !== "desktop") throw new Error("Host generation kind is required");
  const generations = path.resolve(cwd, "dist/host-generations");
  return withGenerationLock(generations, () => {
    const record = JSON.parse(
      fs.readFileSync(path.join(generations, `current-${kind}.json`), "utf8")
    );
    if (record?.version !== 1 || record.kind !== kind || typeof record.root !== "string") {
      throw new Error("Current host build generation is invalid");
    }
    const root = fs.realpathSync(record.root);
    if (path.dirname(root) !== generations || !path.basename(root).startsWith(`${kind}-`)) {
      throw new Error("Current host build generation root is invalid");
    }
    retainGeneration(generations, root);
    return root;
  });
}

/**
 * The build generation a server entry runs from.
 *
 * A host refuses to start without this coordinate, so every launcher must
 * supply it — and each one that derived it independently was a launcher that
 * could forget. Every server entry is compiled and names the directory of
 * its exact generation.
 *
 * Packaged launchers are the exception and name their own root: an installed
 * app resolves it from the archive it was installed as, not from a checkout.
 */
export function hostArtifactRootForServerEntry(repoRoot, serverEntry) {
  return path.dirname(path.resolve(repoRoot, serverEntry));
}
