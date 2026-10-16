import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  HOST_BRAND_RUNTIME_ARTIFACTS,
  NATIVE_WORKSPACE_ENTRIES,
  SOURCE_SERVER_PREREQUISITE_ARTIFACTS,
} from "./server-runtime-artifacts.mjs";

const NON_COMPILER_ENTRIES = new Set([
  "node",
  "mxc",
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
    ...Object.values(NATIVE_WORKSPACE_ENTRIES),
    "dependency-content-maintenance.cjs",
    "internal-do-programs.json",
    "host-build-fingerprint.json",
    "headless-host",
    "workerd-programs",
    ...HOST_BRAND_RUNTIME_ARTIFACTS.map((entry) => entry.slice("dist/".length)),
  ],
};
const COMPLETION_RECEIPT = "host-build-fingerprint.json";
export const HOST_PREPARATION_RECIPES = "host-preparation-recipes.json";
// Created by the publication lifecycle, not by the executable payload producer.
const PUBLICATION_RECORDS = new Set([COMPLETION_RECEIPT, HOST_PREPARATION_RECIPES]);
const PREPARATION_ENTRIES = ["prepare-workspace-templates.mjs", "prepare-workspace-templates.cjs"];

/** Capture executable recipe bytes at publication, never at consumer startup. */
function preparationRecipes(root) {
  const entries = {};
  for (const entry of PREPARATION_ENTRIES) {
    const file = path.join(root, entry);
    if (fs.existsSync(file))
      entries[entry] = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }
  if (!entries[PREPARATION_ENTRIES[0]])
    throw new Error("Host preparation publication is missing its standalone entry");
  return { format: "vibestudio-host-preparation-recipes/1", entries };
}

function writeGenerationRecord(destination, record, failureMessage) {
  const temporary = `${destination}.${randomUUID()}.publishing`;
  let handle;
  let owned = false;
  const failures = [];
  try {
    handle = fs.openSync(temporary, "wx", 0o600);
    owned = true;
    fs.writeFileSync(handle, `${JSON.stringify(record)}\n`);
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(temporary, destination);
  } catch (error) {
    failures.push(error);
  } finally {
    for (const cleanup of [
      () => {
        if (handle !== undefined) fs.closeSync(handle);
      },
      () => {
        if (owned) fs.rmSync(temporary, { force: true });
      },
    ]) {
      try {
        cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(failures, failureMessage, {
      cause: failures[0],
    });
}

function writePreparationRecipes(root, record) {
  writeGenerationRecord(
    path.join(root, HOST_PREPARATION_RECIPES),
    record,
    "Preparation recipe publication and retirement failed"
  );
}

export function readHostPreparationRecipe(root, entry) {
  if (!PREPARATION_ENTRIES.includes(entry))
    throw new Error(`Unknown host preparation entry: ${entry}`);
  const record = JSON.parse(fs.readFileSync(path.join(root, HOST_PREPARATION_RECIPES), "utf8"));
  if (
    record?.format !== "vibestudio-host-preparation-recipes/1" ||
    !record.entries ||
    typeof record.entries !== "object" ||
    Array.isArray(record.entries) ||
    Object.keys(record.entries).some((name) => !PREPARATION_ENTRIES.includes(name)) ||
    Object.values(record.entries).some(
      (value) => typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)
    ) ||
    !record.entries[entry]
  )
    throw new Error("Published host preparation recipe record is invalid");
  return record.entries[entry];
}

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

function parseCurrentGenerationRecord(generations, kind, { ignoreLegacy = false } = {}) {
  const record = JSON.parse(
    fs.readFileSync(path.join(generations, `current-${kind}.json`), "utf8")
  );
  // Version 1 stored an absolute checkout path. It is never a usable current
  // generation after this format change; collectors may ignore that pointer
  // while leases continue protecting generations already in use.
  if (ignoreLegacy && record?.version === 1) return null;
  const keys = Object.keys(record ?? {}).sort();
  if (
    record?.version !== 2 ||
    record.kind !== kind ||
    !["development", "production"].includes(record.mode) ||
    !/^[a-f0-9]{64}$/u.test(record.fingerprint) ||
    !Number.isSafeInteger(record.inputCount) ||
    record.inputCount < 1 ||
    record.root !== `${kind}-${record.fingerprint}` ||
    keys.join(",") !== "fingerprint,inputCount,kind,mode,root,version"
  ) {
    throw new Error("Current host build generation is invalid");
  }
  const root = path.resolve(generations, record.root);
  if (path.dirname(root) !== generations || path.basename(root) !== record.root) {
    throw new Error("Current host build generation root is invalid");
  }
  return { ...record, resolvedRoot: root };
}

function currentRoots(generations) {
  const roots = new Set();
  for (const kind of ["source", "desktop"]) {
    try {
      const record = parseCurrentGenerationRecord(generations, kind, { ignoreLegacy: true });
      if (record) roots.add(record.resolvedRoot);
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

export function assertHostBuildPayloadComplete(cwd, kind) {
  if (!(kind in REQUIRED)) throw new Error(`Unknown host generation kind: ${kind}`);
  const dist = path.resolve(cwd, "dist");
  for (const artifact of REQUIRED[kind]) {
    if (PUBLICATION_RECORDS.has(artifact)) continue;
    if (!fs.existsSync(path.join(dist, artifact))) {
      throw new Error(`Cannot publish incomplete ${kind} host generation: missing ${artifact}`);
    }
  }
}

function validateBuildIdentity(build) {
  if (!(build.kind in REQUIRED)) throw new Error(`Unknown host generation kind: ${build.kind}`);
  if (!["development", "production"].includes(build.mode))
    throw new Error("Invalid host build mode");
  if (!/^[a-f0-9]{64}$/u.test(build.fingerprint)) throw new Error("Invalid host build fingerprint");
  if (!Number.isSafeInteger(build.inputCount) || build.inputCount < 1)
    throw new Error("Invalid host build input count");
}

/** The publisher already proved executable bytes. Every consumer admits the
 * same finite identity/layout/recipe receipts, without rehashing payloads. */
function validatePublishedGeneration(cwd, root, build) {
  validateGenerationLayout(cwd, root);
  const receipt = JSON.parse(fs.readFileSync(path.join(root, COMPLETION_RECEIPT), "utf8"));
  if (
    Object.keys(receipt ?? {})
      .sort()
      .join(",") !== "fingerprint,inputCount,mode,version" ||
    receipt.version !== 1 ||
    receipt.mode !== build.mode ||
    receipt.fingerprint !== build.fingerprint ||
    receipt.inputCount !== build.inputCount
  )
    throw new Error("Published host build generation receipt does not match its identity");
  for (const entry of REQUIRED[build.kind]) {
    if (!fs.existsSync(path.join(root, entry)))
      throw new Error(`Published ${build.kind} host generation is incomplete: missing ${entry}`);
  }
  readHostPreparationRecipe(root, PREPARATION_ENTRIES[0]);
}

function currentGenerationOrNull(generations, kind) {
  try {
    return parseCurrentGenerationRecord(generations, kind, { ignoreLegacy: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function selectCurrentGeneration(generations, build, target, current) {
  if (current?.resolvedRoot === target) return;
  const pointer = path.join(generations, `current-${build.kind}.json`);
  writeGenerationRecord(
    pointer,
    {
      version: 2,
      kind: build.kind,
      mode: build.mode,
      fingerprint: build.fingerprint,
      inputCount: build.inputCount,
      root: path.basename(target),
    },
    "Host generation selection and retirement failed"
  );
  collectHostBuildGenerationsLocked(generations);
}

function admitPublishedGenerationLocked(cwd, build) {
  const generations = path.resolve(cwd, "dist/host-generations");
  const current = currentGenerationOrNull(generations, build.kind);
  const target = hostBuildGenerationRoot(cwd, build.kind, build.fingerprint);
  if (!fs.existsSync(target)) {
    if (current?.resolvedRoot === target) validatePublishedGeneration(cwd, target, build);
    return null;
  }
  validatePublishedGeneration(cwd, target, build);
  if (
    current?.resolvedRoot === target &&
    (current.mode !== build.mode || current.inputCount !== build.inputCount)
  )
    throw new Error("Published host build generation pointer does not match its identity");
  selectCurrentGeneration(generations, build, target, current);
  return target;
}

/** An absent publication permits the ordinary producer to run. A present
 * malformed/incomplete publication fails admission, never falls through. */
export function admitPublishedHostBuildGeneration(cwd, build) {
  validateBuildIdentity(build);
  const generations = path.resolve(cwd, "dist/host-generations");
  if (!fs.existsSync(generations)) return null;
  return withGenerationLock(generations, () => admitPublishedGenerationLocked(cwd, build));
}

export function publishHostBuildGeneration(cwd, build) {
  const dist = path.resolve(cwd, "dist");
  const generations = path.join(dist, "host-generations");
  validateBuildIdentity(build);
  const admitted = admitPublishedHostBuildGeneration(cwd, build);
  if (admitted) return admitted;
  assertHostBuildPayloadComplete(cwd, build.kind);
  if (!fs.existsSync(path.join(dist, COMPLETION_RECEIPT))) {
    throw new Error(
      `Cannot publish incomplete ${build.kind} host generation: missing ${COMPLETION_RECEIPT}`
    );
  }
  const recipes = preparationRecipes(dist);
  writePreparationRecipes(dist, recipes);
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
        const nodeModules = path.resolve(cwd, "node_modules");
        fs.symlinkSync(
          path.relative(staging, nodeModules),
          path.join(staging, "node_modules"),
          "dir"
        );
        writePreparationRecipes(staging, {
          ...recipes,
          entries: Object.fromEntries(
            Object.entries(recipes.entries).filter(([entry]) =>
              fs.existsSync(path.join(staging, entry))
            )
          ),
        });
        validatePublishedGeneration(cwd, staging, build);
        fs.renameSync(staging, target);
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
      }
    }
    return admitPublishedGenerationLocked(cwd, build);
  });
}

function validateGenerationLayout(cwd, root) {
  if (
    path.dirname(root) !== path.resolve(cwd, "dist/host-generations") ||
    fs.realpathSync(root) !== root
  ) {
    throw new Error("Host build generation root is invalid");
  }
  const nodeModules = path.join(root, "node_modules");
  const expected = path.resolve(cwd, "node_modules");
  const link = fs.readlinkSync(nodeModules);
  if (
    path.isAbsolute(link) ||
    path.resolve(root, link) !== expected ||
    !fs.statSync(nodeModules).isDirectory()
  ) {
    throw new Error(
      `Host build generation dependency link is invalid: ${link} resolves to ${path.resolve(root, link)}, expected ${expected}`
    );
  }
}

export function readCurrentHostBuildGeneration(cwd = process.cwd(), kind) {
  if (kind !== "source" && kind !== "desktop") throw new Error("Host generation kind is required");
  const generations = path.resolve(cwd, "dist/host-generations");
  return withGenerationLock(generations, () => {
    const record = parseCurrentGenerationRecord(generations, kind);
    const root = record.resolvedRoot;
    validatePublishedGeneration(cwd, root, record);
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
