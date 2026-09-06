import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { getCACertificates } from "node:tls";
import { collectInstalledRuntimeReadRoots } from "@vibestudio/shared/runtimePaths";

export const NATIVE_RUNTIME_CERTIFICATES = "ca-certificates.pem";

/** Materialize installed runtime resources under a caller-owned immutable root.
 * The caller must keep this root outside any tree the child may delete, and owns
 * its lifetime. No workspace-authored path is traversed or copied here. */
export function prepareNativeRuntime(input: {
  runtimeRoot: string;
  platform?: "linux" | "darwin" | "win32";
}): { executable: string; readPaths: string[]; environment: Record<string, string> } {
  const platform = input.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32") {
    throw new Error(`Unsupported native runtime platform: ${platform}`);
  }
  const runtimeRoot = input.runtimeRoot;
  if (
    !path.isAbsolute(runtimeRoot) ||
    !lstatSync(runtimeRoot).isDirectory() ||
    realpathSync(runtimeRoot) !== runtimeRoot
  ) {
    throw new Error("Native runtime root must be a canonical directory owned by its caller");
  }
  const installedExecutable = realpathSync(process.execPath);
  let executable = installedExecutable;
  const report = process.report.getReport() as unknown as { sharedObjects?: unknown };
  const sharedObjects = Array.isArray(report.sharedObjects)
    ? report.sharedObjects.filter(
        (value): value is string => typeof value === "string" && path.isAbsolute(value)
      )
    : [];
  const read = [runtimeRoot];
  const environment: Record<string, string> = process.versions["electron"]
    ? { ELECTRON_RUN_AS_NODE: "1" }
    : {};
  const assets = ["icudtl.dat", "v8_context_snapshot.bin", "snapshot_blob.bin"];
  if (platform === "win32") {
    const systemRoot = process.env["SystemRoot"];
    if (!systemRoot || !path.win32.isAbsolute(systemRoot))
      throw new Error("Windows native runtime requires the host SystemRoot");
    environment["SystemRoot"] = systemRoot;
    const nodeRoot = path.join(runtimeRoot, "node");
    mkdirSync(nodeRoot);
    const systemPrefix = path.normalize(systemRoot).toLowerCase() + path.sep;
    const installedFiles = new Set([
      installedExecutable,
      ...sharedObjects
        .filter((file) => !path.normalize(file).toLowerCase().startsWith(systemPrefix))
        .map((file) => realpathSync(file)),
    ]);
    for (const name of assets) {
      const asset = path.join(path.dirname(installedExecutable), name);
      try {
        if (statSync(asset).isFile()) installedFiles.add(realpathSync(asset));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    // Copy, never hardlink: sandbox ACL changes must not touch installed files.
    // Exclusive creation also rejects colliding DLL basenames instead of silently
    // replacing one runtime dependency with another.
    for (const file of installedFiles)
      copyFileSync(file, path.join(nodeRoot, path.basename(file)), constants.COPYFILE_EXCL);
    executable = path.join(nodeRoot, path.basename(installedExecutable));
  } else {
    read.push(...collectInstalledRuntimeReadRoots([installedExecutable, ...sharedObjects]));
    const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (process.versions["electron"] && resources) read.push(realpathSync(resources));
    for (const name of assets) {
      const asset = path.join(path.dirname(installedExecutable), name);
      try {
        if (statSync(asset).isFile()) read.push(realpathSync(asset));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  // TLS trust is an installed runtime dependency too. Capture the owner's
  // effective roots through Node's public API (available before our 22.19
  // minimum), rather than guessing an OpenSSL/distro certificate-store path.
  // NODE_EXTRA_CA_CERTS loads this immutable snapshot when each child starts.
  const certificates = [...new Set(getCACertificates("default"))].join("\n") + "\n";
  if (Buffer.byteLength(certificates) > 8 * 1024 * 1024)
    throw new Error("Installed TLS trust roots exceed the 8 MiB runtime resource limit");
  const certificatesPath = path.join(runtimeRoot, NATIVE_RUNTIME_CERTIFICATES);
  writeFileSync(certificatesPath, certificates, { mode: 0o600, flag: "wx" });
  environment["NODE_EXTRA_CA_CERTS"] = certificatesPath;
  // Preserve loader-visible aliases as well as physical resources. MXC owns
  // platform layout; a realpath-only list breaks non-system Node installations.
  const readPaths = [
    ...new Set([
      ...read.map((file) => path.normalize(file)),
      ...read.map((file) => realpathSync(file)),
    ]),
  ].filter(
    (file, _, all) => !all.some((parent) => parent !== file && file.startsWith(parent + path.sep))
  );
  return { executable, readPaths, environment };
}
