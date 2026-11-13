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
import path from "node:path";
import { Arch } from "electron-builder";
import { prepareNativeDependencyFiles } from "./native-host-dependencies.mjs";
import {
  nativeIsolationTarget,
  nativeIsolationBinaryDigest,
  assertNativeIsolationArtifacts,
} from "./native-isolation-artifacts.mjs";
import {
  nativeCelldArtifact,
  nativeCelldDigest,
  nativeCelldTarget,
  readNativeCelldManifest,
  assertNativeCelldBinary,
} from "./native-celld-artifacts.mjs";
import {
  assertDarwinProcessObserver,
  darwinProcessObserverDigest,
  darwinProcessObserverPath,
} from "./owned-process-group-observer.mjs";
import { includeDesktopRuntimeScriptClosure } from "./lib/npm-runtime-script-closure.mjs";

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

/**
 * The celld runtime of the packaged target: a CI-built binary under
 * `native/celld/artifacts/<platform>-<arch>/`, verified against the manifest's
 * digest, staged where the application resolves it.
 */
function electronCelldArtifact(context) {
  const architecture = Arch[context.arch];
  if (typeof architecture !== "string") throw new Error("Unknown Electron packaging architecture");
  const target = nativeCelldTarget(
    context.electronPlatformName,
    architecture,
    readNativeCelldManifest(context.packager.projectDir)
  );
  const source = path.join(
    context.packager.projectDir,
    "native/celld/artifacts",
    `${target.platform}-${target.arch}`,
    target.binary
  );
  assertNativeCelldBinary(source, target);
  return { source, artifact: nativeCelldArtifact(target), target };
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
  includeElectronRuntimeScriptClosure(context);
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
  const celld = electronCelldArtifact(context);
  publishNativeArtifact(
    celld.source,
    path.join(context.packager.projectDir, celld.artifact),
    !celld.artifact.endsWith(".exe")
  );
}

export function includeElectronRuntimeScriptClosure(context) {
  return includeDesktopRuntimeScriptClosure(context.packager.projectDir, context.packager.config);
}

/** afterPack runs before signing changes the executable bytes. */
export async function assertPackagedNativeIsolation(resources, context) {
  const target = nodeRuntimeTarget(context.electronPlatformName, Arch[context.arch]);
  const installedRoot = path.join(resources, "app.asar.unpacked");
  if (context.electronPlatformName === "darwin") {
    const appRoot = context.packager.projectDir;
    const sourceObserver = darwinProcessObserverPath(appRoot, Arch[context.arch]);
    const installedObserver = path.join(resources, "..", "MacOS", "owned-process-group-observer");
    assertDarwinProcessObserver(installedObserver, {
      expectedArch: Arch[context.arch] === "x64" ? "x86_64" : Arch[context.arch],
    });
    if (
      darwinProcessObserverDigest(installedObserver) !== darwinProcessObserverDigest(sourceObserver)
    ) {
      throw new Error("Packaged Darwin process observer differs from the prepared native artifact");
    }
  }
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
  if (
    selectedManifests.length !== 1 ||
    selectedManifests[0] !== `${nodeRuntimeTargetName(target)}.json`
  )
    throw new Error("Packaged application contains an unselected Node runtime selector");
  const celld = electronCelldArtifact(context);
  const installedCelld = path.join(resources, "app.asar.unpacked", celld.artifact);
  if (nativeCelldDigest(installedCelld) !== celld.target.sha256) {
    throw new Error(`Packaged celld runtime differs from release input: ${celld.artifact}`);
  }
  if (!celld.artifact.endsWith(".exe") && (statSync(installedCelld).mode & 0o111) === 0) {
    throw new Error(`Packaged celld runtime is not executable: ${celld.artifact}`);
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
