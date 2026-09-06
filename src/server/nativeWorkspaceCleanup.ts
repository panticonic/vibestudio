import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { compileMxcLaunch } from "@vibestudio/process-adapter/mxc";
import { getMxcExecutable } from "@vibestudio/shared/runtimePaths";
import type { WorkspaceTrashRemoval } from "@vibestudio/workspace/loader";
import { prepareNativeRuntime } from "./nativeRuntimeResources.js";

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

/** These are exclusively host-created, guest-readonly runtime directories next
 * to the discarded workspace, never workspace contents. Use only unlink/rmdir
 * so even unexpected entries cannot cause a recursive host-side traversal. */
function removeStagedRuntimes(trashRoot: string): void {
  for (const name of readdirSync(trashRoot)) {
    if (!name.startsWith(".runtime-")) continue;
    const runtime = path.join(trashRoot, name);
    const node = path.join(runtime, "node");
    try {
      for (const file of readdirSync(node)) unlinkSync(path.join(node, file));
      rmdirSync(node);
    } catch (error) {
      if (!absent(error)) throw error;
    }
    rmdirSync(runtime);
  }
}

/** Catalog-owned effect. A surviving guest may race deletion, so recursive
 * traversal runs with MXC's restricted filesystem authority, never the host's.
 * Failure retains the receipt and runtime staging for the existing retry path. */
export function nativeWorkspaceCleanup(appRoot: string): WorkspaceTrashRemoval {
  const platform = process.platform;
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32")
    throw new Error(`Unsupported workspace cleanup platform: ${platform}`);
  const launcher = getMxcExecutable(appRoot);
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
      const runtimeRoot = mkdtempSync(path.join(trashRoot, ".runtime-"));
      const runtime = prepareNativeRuntime({ runtimeRoot, platform });
      const launch = compileMxcLaunch({
        platform,
        launcher,
        containerId: `vibestudio-cleanup-${randomUUID()}`,
        argv: [runtime.executable, "-e", CLEANUP_SCRIPT],
        cwd: workspace,
        guestEnvironment: runtime.environment,
        readPaths: runtime.readPaths,
        writePaths: [workspace],
        network: "deny",
      });
      try {
        execFileSync(launch.command, launch.args, {
          cwd: launch.cwd,
          env: launch.environment,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          timeout: 10_000,
          killSignal: "SIGKILL",
          maxBuffer: 64 * 1024,
        });
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
    removeStagedRuntimes(trashRoot);
    try {
      unlinkSync(path.join(trashRoot, "deletion.json"));
    } catch (error) {
      if (!absent(error)) throw error;
    }
    rmdirSync(trashRoot);
  };
}
