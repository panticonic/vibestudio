import { copyFileSync, chmodSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { Arch } from "electron-builder";
import {
  nativeIsolationTarget,
  nativeIsolationBinaryDigest,
  assertNativeIsolationArtifacts,
} from "./native-isolation-artifacts.mjs";

/** electron-builder's requested architecture is independent of its build host. */
function electronNativeArtifacts(context) {
  const architecture = Arch[context.arch];
  if (typeof architecture !== "string") throw new Error("Unknown Electron packaging architecture");
  const target = nativeIsolationTarget(context.electronPlatformName, architecture);
  const appRoot = context.packager.projectDir;
  const artifactRoot = path.join(appRoot, "native/isolation/artifacts");
  return assertNativeIsolationArtifacts(appRoot, artifactRoot, [target]);
}

export default function stageElectronNativeIsolation(context) {
  for (const { source, artifact } of electronNativeArtifacts(context)) {
    const appRoot = context.packager.projectDir;
    const destination = path.join(appRoot, artifact);
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    if (!artifact.endsWith(".json") && !artifact.endsWith(".exe")) chmodSync(destination, 0o755);
  }
}

/** afterPack runs before signing changes the executable bytes. */
export function assertPackagedNativeIsolation(resources, context) {
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
