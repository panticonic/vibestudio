import extractZip from "extract-zip";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  lstat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const distribution = JSON.parse(
  await readFile(new URL("../native/node/distribution.json", import.meta.url), "utf8")
);
export const NODE_RUNTIME_VERSION = distribution.version;
export const NODE_RUNTIME_TARGETS = Object.freeze(distribution.targets);
if ((await readFile(new URL("../.nvmrc", import.meta.url), "utf8")).trim() !== NODE_RUNTIME_VERSION)
  throw new Error("The installed Node distribution and .nvmrc must pin the same exact version");
export function nodeRuntimeTarget(platform = process.platform, arch = process.arch) {
  const target = NODE_RUNTIME_TARGETS.find(
    (entry) => entry.platform === platform && entry.arch === arch
  );
  if (!target) throw new Error(`Unsupported installed Node target: ${platform}-${arch}`);
  return target;
}
export function nodeRuntimeExecutable(target) {
  return target.platform === "win32" ? "node.exe" : "bin/node";
}
export function nodeRuntimeTargetName(target) {
  return `${target.platform}-${target.arch}`;
}
export function nodeRuntimeIdentity(target) {
  if (!/^[a-f0-9]{64}$/u.test(target.sha256))
    throw new Error(`Node runtime target has an invalid archive digest: ${target.archive}`);
  return `${NODE_RUNTIME_VERSION}-${target.sha256}`;
}
export function nodeRuntimeDirectory(appRoot, target) {
  return path.join(
    appRoot,
    "dist",
    "node",
    "releases",
    nodeRuntimeTargetName(target),
    nodeRuntimeIdentity(target)
  );
}
export function nodeRuntimeSelectionPath(appRoot, target) {
  return path.join(appRoot, "dist", "node", "selected", `${nodeRuntimeTargetName(target)}.json`);
}
export function nodeRuntimePayloadDirectory(appRoot, target) {
  return path.join(
    appRoot,
    "dist",
    "node-payload",
    "releases",
    nodeRuntimeTargetName(target),
    nodeRuntimeIdentity(target)
  );
}
export function nodeRuntimePayloadSelectionPath(appRoot, target) {
  return path.join(
    appRoot,
    "dist",
    "node-payload",
    "selected",
    `${nodeRuntimeTargetName(target)}.json`
  );
}
function selectionFor(target) {
  return {
    version: 1,
    platform: target.platform,
    arch: target.arch,
    nodeVersion: NODE_RUNTIME_VERSION,
    archive: target.archive,
    archiveSha256: target.sha256,
    directory: nodeRuntimeIdentity(target),
  };
}
async function publishSelection(file, selection) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(selection)}\n`, { flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
export function verifyNodeRuntimeArchive(bytes, target) {
  if (createHash("sha256").update(bytes).digest("hex") !== target.sha256)
    throw new Error(`Official Node archive checksum mismatch: ${target.archive}`);
}
async function inventory(root, relative = "") {
  const entries = {};
  for (const name of (await readdir(path.join(root, relative))).sort()) {
    if (!relative && name === "vibestudio-runtime.json") continue;
    const key = relative ? `${relative}/${name}` : name;
    const file = path.join(root, key);
    const info = await lstat(file);
    if (info.isSymbolicLink()) entries[key] = { link: await readlink(file) };
    else if (info.isDirectory()) Object.assign(entries, await inventory(root, key));
    else if (info.isFile())
      entries[key] = {
        sha256: createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
      };
    else throw new Error(`Unexpected installed Node resource: ${file}`);
  }
  return entries;
}
async function assertRuntimeDirectory(root, target) {
  const receipt = JSON.parse(await readFile(path.join(root, "vibestudio-runtime.json"), "utf8"));
  if (
    receipt.version !== 1 ||
    receipt.nodeVersion !== NODE_RUNTIME_VERSION ||
    receipt.archive !== target.archive ||
    receipt.archiveSha256 !== target.sha256
  )
    throw new Error(
      `Installed Node runtime differs from its verified distribution: ${target.platform}-${target.arch}`
    );
  const actual = await inventory(root);
  const expected = receipt.files ?? {};
  const differences = [...new Set([...Object.keys(expected), ...Object.keys(actual)])]
    .sort()
    .filter((file) => JSON.stringify(expected[file]) !== JSON.stringify(actual[file]));
  if (differences.length) {
    const details = differences
      .slice(0, 20)
      .map(
        (file) =>
          `${!Object.hasOwn(actual, file) ? "missing" : !Object.hasOwn(expected, file) ? "unexpected" : "changed"}: ${file}`
      );
    throw new Error(
      `Installed Node runtime differs from its verified distribution: ${target.platform}-${target.arch}; ` +
        `${differences.length} file(s): ${details.join("; ")}`
    );
  }
  const executable = path.join(root, nodeRuntimeExecutable(target));
  if (!(await lstat(executable)).isFile())
    throw new Error(`Installed Node executable is missing: ${executable}`);
  return { root, executable };
}
export async function assertNodeRuntimeArtifacts(appRoot, target = nodeRuntimeTarget()) {
  return assertRuntimeDirectory(nodeRuntimeDirectory(appRoot, target), target);
}
export async function assertSelectedNodeRuntimeArtifacts(
  appRoot,
  target = nodeRuntimeTarget()
) {
  const selection = JSON.parse(await readFile(nodeRuntimeSelectionPath(appRoot, target), "utf8"));
  const expected = selectionFor(target);
  if (JSON.stringify(selection) !== JSON.stringify(expected))
    throw new Error(`Selected Node runtime differs from its verified distribution: ${nodeRuntimeTargetName(target)}`);
  return { ...(await assertNodeRuntimeArtifacts(appRoot, target)), selection };
}
async function stageNodeRuntimePayloadImpl(appRoot, target) {
  const selected = await assertSelectedNodeRuntimeArtifacts(appRoot, target);
  const targetRoot = path.join(appRoot, "dist", "node-payload", "releases", nodeRuntimeTargetName(target));
  const payload = nodeRuntimePayloadDirectory(appRoot, target);
  const payloadSelection = nodeRuntimePayloadSelectionPath(appRoot, target);
  await mkdir(targetRoot, { recursive: true });
  const identity = nodeRuntimeIdentity(target);
  const temporary = path.join(targetRoot, `.${identity}-${randomUUID()}.tmp`);
  try {
    const existing = await readdir(targetRoot);
    const releases = existing.filter((name) => !(name.startsWith(".") && name.endsWith(".tmp")));
    if (releases.some((name) => name !== identity))
      throw new Error(`Node runtime payload contains an older release: ${nodeRuntimeTargetName(target)}`);
    if (!releases.includes(identity)) {
      await cp(selected.root, temporary, {
        recursive: true,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true,
      });
      try {
        await rename(temporary, payload);
      } catch (error) {
        if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
      }
    }
    await assertRuntimeDirectory(payload, target);
    await publishSelection(payloadSelection, selected.selection);
    return { root: payload, executable: path.join(payload, nodeRuntimeExecutable(target)) };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function assertNodeRuntimePayload(appRoot, target = nodeRuntimeTarget()) {
  const file = nodeRuntimePayloadSelectionPath(appRoot, target);
  const selection = JSON.parse(await readFile(file, "utf8"));
  const expected = selectionFor(target);
  if (JSON.stringify(selection) !== JSON.stringify(expected))
    throw new Error(`Node runtime payload selection is invalid: ${nodeRuntimeTargetName(target)}`);
  const payload = nodeRuntimePayloadDirectory(appRoot, target);
  const artifacts = await assertRuntimeDirectory(payload, target);
  const targetRoot = path.join(appRoot, "dist", "node-payload", "releases", nodeRuntimeTargetName(target));
  const names = (await readdir(targetRoot)).sort();
  if (names.length !== 1 || names[0] !== nodeRuntimeIdentity(target))
    throw new Error(`Node runtime payload contains unselected releases: ${nodeRuntimeTargetName(target)}`);
  if (payload !== artifacts.root) throw new Error("Node runtime payload path does not match its selection");
  return artifacts;
}
async function downloadArchive(file, target) {
  const controller = new AbortController();
  let idleTimer;
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => controller.abort(new Error("Node distribution download stalled for 120 seconds")),
      120_000
    );
  };
  try {
    resetIdleTimer();
    const response = await fetch(
      `https://nodejs.org/dist/v${NODE_RUNTIME_VERSION}/${target.archive}`,
      { signal: controller.signal, redirect: "error" }
    );
    if (!response.ok || !response.body)
      throw new Error(`Node distribution download failed: HTTP ${response.status}`);
    let size = 0;
    const limit = new Transform({
      transform(chunk, _encoding, callback) {
        resetIdleTimer();
        size += chunk.length;
        callback(
          size > 256 * 1024 * 1024 ? new Error("Node distribution exceeds 256 MiB") : null,
          chunk
        );
      },
    });
    await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(file, { flags: "wx" }));
    verifyNodeRuntimeArchive(await readFile(file), target);
  } finally {
    clearTimeout(idleTimer);
  }
}
/** Stage an official, checksum-pinned distribution. No system Node discovery,
 * aliases or Electron runtime conversion participate in installed execution. */
const stageQueues = new Map();
const payloadStageQueues = new Map();
async function stageNodeRuntimeImpl(appRoot, target) {
  let installed = false;
  try {
    await assertNodeRuntimeArtifacts(appRoot, target);
    installed = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!installed) {
    const cacheRoot = path.join(appRoot, ".cache", "node-distributions");
    await mkdir(cacheRoot, { recursive: true });
    const archive = path.join(cacheRoot, target.archive);
    try {
      verifyNodeRuntimeArchive(await readFile(archive), target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const download = `${archive}.${randomUUID()}.download`;
      try {
        await downloadArchive(download, target);
        await rename(download, archive);
      } finally {
        await rm(download, { force: true });
      }
    }
    const output = nodeRuntimeDirectory(appRoot, target);
    await mkdir(path.dirname(output), { recursive: true });
    const staging = await mkdtemp(path.join(path.dirname(output), ".stage-"));
    try {
      // Extract only a verified official archive into a fresh build-owned root.
      // ZIP needs an explicit portable reader: GNU tar cannot consume it.
      if (target.archive.endsWith(".zip")) await extractZip(archive, { dir: staging });
      else
        await execute("tar", ["-xf", archive, "-C", staging], {
          timeout: 120_000,
          maxBuffer: 1_048_576,
        });
      const archiveRoot = path.join(staging, target.archive.replace(/\.(?:tar\.gz|zip)$/, ""));
      const executable = path.join(archiveRoot, nodeRuntimeExecutable(target));
      if (target.platform !== "win32") await chmod(executable, 0o755);
      await writeFile(
        path.join(archiveRoot, "runtime.json"),
        JSON.stringify({
          version: NODE_RUNTIME_VERSION,
          platform: target.platform,
          arch: target.arch,
        }) + "\n",
        { flag: "wx" }
      );
      await writeFile(
        path.join(archiveRoot, "vibestudio-runtime.json"),
        JSON.stringify({
          version: 1,
          nodeVersion: NODE_RUNTIME_VERSION,
          archive: target.archive,
          archiveSha256: target.sha256,
          files: await inventory(archiveRoot),
        }) + "\n",
        { flag: "wx" }
      );
      try {
        await rename(archiveRoot, output);
      } catch (error) {
        // This version+archive digest path is immutable. A concurrent publisher
        // may win, but its complete tree must pass the same receipt check.
        if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  const verified = await assertNodeRuntimeArtifacts(appRoot, target);
  await publishSelection(nodeRuntimeSelectionPath(appRoot, target), selectionFor(target));
  return verified;
}
export function stageNodeRuntime(appRoot = repositoryRoot, target = nodeRuntimeTarget()) {
  const key = `${path.resolve(appRoot)}\0${nodeRuntimeTargetName(target)}`;
  const previous = stageQueues.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(() => stageNodeRuntimeImpl(appRoot, target));
  stageQueues.set(key, operation);
  return operation.finally(() => {
    if (stageQueues.get(key) === operation) stageQueues.delete(key);
  });
}
export function stageNodeRuntimePayload(appRoot = repositoryRoot, target = nodeRuntimeTarget()) {
  const key = `${path.resolve(appRoot)}\0${nodeRuntimeTargetName(target)}`;
  const previous = payloadStageQueues.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(() => stageNodeRuntimePayloadImpl(appRoot, target));
  payloadStageQueues.set(key, operation);
  return operation.finally(() => {
    if (payloadStageQueues.get(key) === operation) payloadStageQueues.delete(key);
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = nodeRuntimeTarget(process.argv[2], process.argv[3]);
  const result = await stageNodeRuntime(repositoryRoot, target);
  console.log(`Installed Node ${NODE_RUNTIME_VERSION}: ${result.executable}`);
}
