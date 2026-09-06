import { constants, copyFileSync, cpSync, lstatSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getCACertificates } from "node:tls";
import {
  collectInstalledRuntimeReadRoots,
  getInstalledNodeRuntime,
} from "@vibestudio/shared/runtimePaths";
import { windowsEnvironmentValue } from "@vibestudio/process-adapter/mxc";

export const NATIVE_RUNTIME_CERTIFICATES = "ca-certificates.pem";

/** Materialize installed runtime resources under a caller-owned immutable root.
 * The caller must keep this root outside any tree the child may delete, and owns
 * its lifetime. No workspace-authored path is traversed or copied here. */
export function prepareNativeRuntime(input: {
  appRoot: string;
  runtimeRoot: string;
  platform?: "linux" | "darwin" | "win32";
}): {
  executable: string;
  npmCli: string;
  readPaths: string[];
  environment: Record<string, string>;
} {
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
  const installed = getInstalledNodeRuntime(input.appRoot, platform);
  const installedRoot = realpathSync(installed.root);
  const installedExecutable = realpathSync(installed.executable);
  const sharedObjects = installedNodeLibraries(installedExecutable, installed.version, platform);
  let executable = installedExecutable;
  let npmCli = realpathSync(installed.npmCli);
  const read = [runtimeRoot];
  const environment: Record<string, string> = {};
  if (platform === "win32") {
    const systemRoot = windowsEnvironmentValue(process.env, "SystemRoot");
    if (!systemRoot || !path.win32.isAbsolute(systemRoot))
      throw new Error("Windows native runtime requires the host SystemRoot");
    environment["SystemRoot"] = systemRoot;
    const nodeRoot = path.join(runtimeRoot, "node");
    // MXC applies Windows ACLs to admitted resources. Copy the complete real
    // Node/npm distribution so these grants cannot change the installed app.
    cpSync(installedRoot, nodeRoot, { recursive: true, errorOnExist: true, force: false });
    const systemPrefix = path.normalize(systemRoot).toLowerCase() + path.sep;
    for (const file of sharedObjects) {
      const resource = realpathSync(file);
      if (
        resource.toLowerCase().startsWith(systemPrefix) ||
        resource.toLowerCase().startsWith(installedRoot.toLowerCase() + path.sep)
      )
        continue;
      copyFileSync(resource, path.join(nodeRoot, path.basename(resource)), constants.COPYFILE_EXCL);
    }
    executable = path.join(nodeRoot, path.relative(installedRoot, installedExecutable));
    npmCli = path.join(nodeRoot, path.relative(installedRoot, npmCli));
  } else {
    read.push(
      installedRoot,
      ...collectInstalledRuntimeReadRoots([installedExecutable, ...sharedObjects], platform)
    );
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
  return { executable, npmCli, readPaths, environment };
}

const libraryReports = new Map<string, string[]>();

/** Read-only installed Node resources for an already-owned native launch. */
export function installedNodeReadPaths(appRoot: string): string[] {
  const installed = getInstalledNodeRuntime(appRoot);
  const executable = realpathSync(installed.executable);
  return [
    ...new Set([
      realpathSync(installed.root),
      ...collectInstalledRuntimeReadRoots([
        executable,
        ...installedNodeLibraries(executable, installed.version, process.platform),
      ]),
    ]),
  ];
}

/** Probe installed Node itself, never the Electron host's loaded libraries. */
function installedNodeLibraries(executable: string, version: string, platform: string): string[] {
  const key = `${executable}\0${version}`;
  const cached = libraryReports.get(key);
  if (cached) return cached;
  const systemRoot = windowsEnvironmentValue(process.env, "SystemRoot");
  const report = JSON.parse(
    execFileSync(
      executable,
      [
        "-e",
        "process.stdout.write(JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch,sharedObjects:process.report.getReport().sharedObjects}))",
      ],
      {
        env: platform === "win32" && systemRoot ? { SystemRoot: systemRoot } : {},
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      }
    )
  ) as { version?: unknown; platform?: unknown; arch?: unknown; sharedObjects?: unknown };
  if (
    report.version !== version ||
    report.platform !== platform ||
    report.arch !== process.arch ||
    !Array.isArray(report.sharedObjects) ||
    !report.sharedObjects.every((file): file is string => typeof file === "string")
  )
    throw new Error("Installed Node runtime probe does not match its verified distribution");
  // Reports also name kernel-provided virtual images such as the Linux vDSO;
  // only filesystem-backed images need resource grants.
  const libraries = (report.sharedObjects as string[]).filter((file) => path.isAbsolute(file));
  libraryReports.set(key, libraries);
  return libraries;
}
