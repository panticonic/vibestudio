import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startNativeWorkspaceRuntime } from "../nativeWorkspaceRuntime.js";
import type { RunNativeWorkspaceJob } from "../nativeWorkspaceJob.js";

/** Real isolated execution for builder fixtures; never a host execution fallback. */
export const runIsolatedBuildJob: RunNativeWorkspaceJob = async (input) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "isolated-build-job-"));
  let runtime: Awaited<ReturnType<typeof startNativeWorkspaceRuntime>> | undefined;
  try {
    runtime = await startNativeWorkspaceRuntime({
      workspaceId: "build-fixture",
      statePath: root,
      sourceRoot: path.join(root, "source"),
      scratchRoot: path.join(root, "scratch/contexts"),
      buildsRoot: path.join(root, "builds"),
      appRoot: process.cwd(),
    });
    await runtime.runJob(input);
  } finally {
    const stopped = await runtime?.stop();
    if (!stopped || stopped.launcherExited) {
      await runtime?.retireStorage();
      await rm(root, { recursive: true, force: true });
    }
  }
};
