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

export function hostBuildGenerationRoot(cwd, kind, fingerprint) {
  return path.join(path.resolve(cwd, "dist/host-generations"), `${kind}-${fingerprint}`);
}

export function publishHostBuildGeneration(cwd, build) {
  const dist = path.resolve(cwd, "dist");
  const generations = path.join(dist, "host-generations");
  if (!(build.kind in REQUIRED)) throw new Error(`Unknown host generation kind: ${build.kind}`);
  for (const artifact of REQUIRED[build.kind]) {
    if (!fs.existsSync(path.join(dist, artifact))) {
      throw new Error(
        `Cannot publish incomplete ${build.kind} host generation: missing ${artifact}`
      );
    }
  }
  const target = hostBuildGenerationRoot(cwd, build.kind, build.fingerprint);
  fs.mkdirSync(generations, { recursive: true });
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
      fs.symlinkSync(path.resolve(cwd, "node_modules"), path.join(staging, "node_modules"), "dir");
      fs.renameSync(staging, target);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }
  const current = path.join(generations, `current-${build.kind}.json`);
  const temporary = `${current}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, ...build, root: target })}\n`);
  fs.renameSync(temporary, current);
  return target;
}

export function readCurrentHostBuildGeneration(cwd = process.cwd(), kind) {
  if (kind !== "source" && kind !== "desktop") throw new Error("Host generation kind is required");
  const record = JSON.parse(
    fs.readFileSync(path.resolve(cwd, `dist/host-generations/current-${kind}.json`), "utf8")
  );
  if (record?.version !== 1 || record.kind !== kind || typeof record.root !== "string") {
    throw new Error("Current host build generation is invalid");
  }
  return fs.realpathSync(record.root);
}

/**
 * The build generation a server entry runs from.
 *
 * A host refuses to start without this coordinate, so every launcher must
 * supply it — and each one that derived it independently was a launcher that
 * could forget. A compiled entry names its own directory; a live source entry
 * names the current source generation, because compiled artifacts must come
 * from exactly one of them.
 *
 * Packaged launchers are the exception and name their own root: an installed
 * app resolves it from the archive it was installed as, not from a checkout.
 */
export function hostArtifactRootForServerEntry(repoRoot, serverEntry) {
  if (serverEntry !== "src/server/index.ts") {
    return path.dirname(path.resolve(repoRoot, serverEntry));
  }
  return readCurrentHostBuildGeneration(repoRoot, "source");
}
