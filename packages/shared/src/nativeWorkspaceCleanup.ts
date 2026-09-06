import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { compileNativeLaunch } from "@vibestudio/process-adapter/native-launch";
import { getNativeExecutionInstallation } from "@vibestudio/shared/runtimePaths";
import { prepareNativeRuntime } from "@vibestudio/shared/nativeRuntimeResources";

// The write-granted directory is a mount root on Linux. Delete its children in
// confinement; only the owner can remove that now-empty anchor afterward.
const CLEANUP_SCRIPT = `
  const fs = require('node:fs');
  const path = require('node:path');
  const root = process.cwd();
  for (const name of fs.readdirSync(root)) {
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
  }
`;

function absent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** These are host-created, guest-readonly runtime distributions. The discarded
 * workspace itself is removed by the platform execution job below. */
function removeStagedRuntimes(trashRoot: string): void {
  for (const name of readdirSync(trashRoot)) {
    if (name.startsWith(".runtime-"))
      rmSync(path.join(trashRoot, name), { recursive: true, force: true });
  }
}

/** Catalog-owned effect. A surviving guest may race deletion, so recursive
 * traversal is confined by MXC on Unix. Windows uses normal host authority.
 * Failure retains the receipt and runtime staging for the existing retry path. */
export function nativeWorkspaceCleanup(appRoot: string): (target: string) => void {
  const platform = process.platform;
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32")
    throw new Error(`Unsupported workspace cleanup platform: ${platform}`);
  const installation = getNativeExecutionInstallation(appRoot);
  return (target) => {
    if (!path.isAbsolute(target) || !path.basename(target).startsWith(".delete-"))
      throw new Error("Expected owned workspace trash");
    let metadata: ReturnType<typeof lstatSync>;
    try {
      metadata = lstatSync(target);
    } catch (error) {
      if (absent(error)) return;
      throw error;
    }
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error("Trash anchor is not a directory");
    const trashRoot = realpathSync(target);
    const workspace = path.join(trashRoot, "workspace");
    let workspaceExists = true;
    try {
      const workspaceMetadata = lstatSync(workspace);
      if (!workspaceMetadata.isDirectory() || workspaceMetadata.isSymbolicLink())
        throw new Error("Discarded workspace anchor is not a directory");
    } catch (error) {
      if (!absent(error)) throw error;
      workspaceExists = false;
    }
    if (workspaceExists) {
      // The catalog-owned parent is not writable by either workspace. Keeping
      // runtime staging here also makes failed cleanup self-contained/retryable.
      const startedAt = Date.now();
      console.log("[NativeCleanup] Preparing installed deletion runtime");
      const runtimeRoot = mkdtempSync(path.join(trashRoot, ".runtime-"));
      const runtime = prepareNativeRuntime({ appRoot: appRoot, runtimeRoot, platform });
      console.log(`[NativeCleanup] Runtime prepared (${Date.now() - startedAt}ms)`);
      const launch = compileNativeLaunch({
        installation,
        containerId: `vibestudio-cleanup-${randomUUID()}`,
        argv: [runtime.executable, "-e", CLEANUP_SCRIPT],
        cwd: workspace,
        guestEnvironment: {
          ...runtime.environment,
          ...(platform === "win32"
            ? { LOCALAPPDATA: workspace, USERPROFILE: workspace, APPDATA: workspace }
            : {}),
        },
        readPaths: runtime.readPaths,
        writePaths: [workspace],
        network: "deny",
      });
      try {
        console.log("[NativeCleanup] Native deletion started");
        execFileSync(launch.command, launch.args, {
          cwd: launch.cwd,
          env: launch.environment,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          timeout: 10_000,
          killSignal: "SIGKILL",
          maxBuffer: 64 * 1024,
        });
        console.log(`[NativeCleanup] Native deletion completed (${Date.now() - startedAt}ms)`);
      } catch (error) {
        const failure = error as NodeJS.ErrnoException & {
          stderr?: Buffer;
          status?: number | null;
          signal?: string | null;
        };
        // Do not stringify execFile's command line or serialized policy.
        throw new Error(
          `Confined workspace cleanup failed (${failure.code ?? failure.signal ?? failure.status ?? "native error"}). ` +
            "Deletion remains queued for retry. " +
            (failure.code === "ENOENT" ? "Repair the installed MXC executor. " : "") +
            (failure.stderr?.toString().slice(-16_384).trim() ?? "")
        );
      }
      // Never recursively delete on the host: new guest entries make this fail
      // with ENOTEMPTY, retaining the receipt instead of following their paths.
      rmdirSync(workspace);
    }
    console.log("[NativeCleanup] Retiring owner runtime and receipt");
    removeStagedRuntimes(trashRoot);
    try {
      unlinkSync(path.join(trashRoot, "deletion.json"));
    } catch (error) {
      if (!absent(error)) throw error;
    }
    rmdirSync(trashRoot);
    console.log("[NativeCleanup] Retirement completed");
  };
}
