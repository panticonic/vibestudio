import {
  stageNodeRuntime,
  nodeRuntimeTarget,
  assertNodeRuntimeArtifacts,
} from "./node-runtime-artifacts.mjs";
import { copyFileSync, chmodSync, mkdirSync, statSync, readFileSync } from "node:fs";
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

export default async function stageElectronNativeIsolation(context) {
  if (typeof Arch[context.arch] !== "string")
    throw new Error("Unknown Electron packaging architecture");
  await stageNodeRuntime(
    context.packager.projectDir,
    nodeRuntimeTarget(context.electronPlatformName, Arch[context.arch])
  );
  prepareNativeDependencyFiles({
    cwd: context.packager.projectDir,
    platform: context.electronPlatformName,
    arch: Arch[context.arch],
  });
  for (const { source, artifact } of electronNativeArtifacts(context)) {
    const appRoot = context.packager.projectDir;
    const destination = path.join(appRoot, artifact);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    if (!artifact.endsWith(".json") && !artifact.endsWith(".exe")) chmodSync(destination, 0o755);
  }
}

/** afterPack runs before signing changes the executable bytes. */
export async function assertPackagedNativeIsolation(resources, context) {
  await assertNodeRuntimeArtifacts(
    path.join(resources, "app.asar.unpacked"),
    nodeRuntimeTarget(context.electronPlatformName, Arch[context.arch])
  );
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
