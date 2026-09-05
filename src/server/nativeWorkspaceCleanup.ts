import { execFileSync } from "node:child_process";
import { nativeIsolationExecutable } from "./nativeIsolationExecutable.js";
import type { WorkspaceTrashRemoval } from "@vibestudio/workspace/loader";

/** Installed catalog-owner effect; never a guest-selected filesystem service. */
export function nativeWorkspaceCleanup(appRoot: string): WorkspaceTrashRemoval {
  const helper = nativeIsolationExecutable(appRoot);
  return (target) => {
    execFileSync(helper, ["--remove-workspace-trash", target], {
      env:
        process.platform === "win32"
          ? { SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows" }
          : {},
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
  };
}
