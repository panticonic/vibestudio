import {
  stageNodeRuntime,
  stageNodeRuntimePayload,
  nodeRuntimeTarget,
  assertSelectedNodeRuntimeArtifacts,
  assertNodeRuntimePayload,
  nodeRuntimeTargetName,
  nodeRuntimeIdentity,
} from "./node-runtime-artifacts.mjs";
import {
  copyFileSync,
  chmodSync,
  mkdirSync,
  readdirSync,
  statSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { Arch } from "electron-builder";
import { prepareNativeDependencyFiles } from "./native-host-dependencies.mjs";
import {
  nativeIsolationTarget,
  nativeIsolationBinaryDigest,
  assertNativeIsolationArtifacts,
} from "./native-isolation-artifacts.mjs";

/** electron-builder's requested architecture is independent of its build host. */
function electronNativeArtifacts(context) {
  if (context.electronPlatformName === "win32") return [];
  const architecture = Arch[context.arch];
  if (typeof architecture !== "string") throw new Error("Unknown Electron packaging architecture");
  const target = nativeIsolationTarget(context.electronPlatformName, architecture);
  const appRoot = context.packager.projectDir;
  const artifactRoot = path.join(appRoot, "native/isolation/artifacts");
  return assertNativeIsolationArtifacts(appRoot, artifactRoot, [target]);
}

/** Publish a complete native payload without overwriting an inode a live host executes. */
export function publishNativeArtifact(source, destination, executable) {
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    copyFileSync(source, temporary);
    if (executable) chmodSync(temporary, 0o755);
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export default async function stageElectronNativeIsolation(context) {
  if (typeof Arch[context.arch] !== "string")
    throw new Error("Unknown Electron packaging architecture");
  const target = nodeRuntimeTarget(context.electronPlatformName, Arch[context.arch]);
  await stageNodeRuntime(context.packager.projectDir, target);
  await stageNodeRuntimePayload(context.packager.projectDir, target);
  await assertNodeRuntimePayload(context.packager.projectDir, target);
  prepareNativeDependencyFiles({
    cwd: context.packager.projectDir,
    platform: context.electronPlatformName,
    arch: Arch[context.arch],
  });
  for (const { source, artifact } of electronNativeArtifacts(context)) {
    const appRoot = context.packager.projectDir;
    const destination = path.join(appRoot, artifact);
    publishNativeArtifact(
      source,
      destination,
      !artifact.endsWith(".json") && !artifact.endsWith(".exe")
    );
  }
}

/** afterPack runs before signing changes the executable bytes. */
export async function assertPackagedNativeIsolation(resources, context) {
  const target = nodeRuntimeTarget(context.electronPlatformName, Arch[context.arch]);
  const installedRoot = path.join(resources, "app.asar.unpacked");
  await assertSelectedNodeRuntimeArtifacts(installedRoot, target);
  const nodeRoot = path.join(installedRoot, "dist", "node");
  const selectedPlatforms = readdirSync(path.join(nodeRoot, "releases"));
  if (selectedPlatforms.length !== 1 || selectedPlatforms[0] !== nodeRuntimeTargetName(target))
    throw new Error("Packaged application contains an unselected Node runtime target");
  const selectedVersions = readdirSync(
    path.join(nodeRoot, "releases", nodeRuntimeTargetName(target))
  );
  if (selectedVersions.length !== 1 || selectedVersions[0] !== nodeRuntimeIdentity(target))
    throw new Error("Packaged application contains an unselected Node runtime release");
  const selectedManifests = readdirSync(path.join(nodeRoot, "selected"));
  if (selectedManifests.length !== 1 || selectedManifests[0] !== `${nodeRuntimeTargetName(target)}.json`)
    throw new Error("Packaged application contains an unselected Node runtime selector");
  if (context.electronPlatformName === "win32") {
    const require = createRequire(path.join(context.packager.projectDir, "package.json"));
    const source = `${require.resolve("@cloudflare/workerd-windows-64/bin/workerd.exe")}.manifest`;
    const installed = path.join(
      resources,
      "app.asar.unpacked/node_modules/@cloudflare/workerd-windows-64/bin/workerd.exe.manifest"
    );
    if (!readFileSync(installed).equals(readFileSync(source)))
      throw new Error("Packaged Windows workerd manifest differs from release input");
  }
  for (const { source, artifact } of electronNativeArtifacts(context)) {
    const installed = path.join(resources, "app.asar.unpacked", artifact);
    if (nativeIsolationBinaryDigest(installed) !== nativeIsolationBinaryDigest(source)) {
      throw new Error(`Packaged native isolation artifact differs from release input: ${artifact}`);
    }
    if (
      context.electronPlatformName !== "win32" &&
      !artifact.endsWith(".json") &&
      (statSync(installed).mode & 0o111) === 0
    ) {
      throw new Error(`Packaged native isolation helper is not executable: ${artifact}`);
    }
  }
}
