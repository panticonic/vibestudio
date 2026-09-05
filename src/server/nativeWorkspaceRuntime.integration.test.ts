import { expect, it } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { startNativeWorkspaceRuntime } from "./nativeWorkspaceRuntime.js";

it("runs the production disk receiver inside the workspace resource boundary", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "native-workspace-receiver-"));
  const statePath = path.join(root, "state");
  const sourceRoot = path.join(statePath, "source");
  const scratchRoot = path.join(statePath, "scratch", "contexts");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(root, "host-canary"), "host secret");
  await writeFile(path.join(sourceRoot, "source.txt"), "immutable source");
  let runtime: Awaited<ReturnType<typeof startNativeWorkspaceRuntime>> | undefined;
  try {
    runtime = await startNativeWorkspaceRuntime({
      workspaceId: "fixture",
      statePath,
      sourceRoot,
      scratchRoot,
      buildsRoot: path.join(statePath, "builds"),
      appRoot: process.cwd(),
    });
    const scope = { root: scratchRoot, panelId: "fixture", exposeHostPaths: false };
    await runtime.disk.call(scope, "writeFile", ["note.txt", "private scratch"]);
    expect(await runtime.disk.call(scope, "readFile", ["note.txt", "utf8"])).toBe(
      "private scratch"
    );
    expect(
      await runtime.disk.call({ ...scope, root: sourceRoot }, "readFile", ["source.txt", "utf8"])
    ).toBe("immutable source");
    await expect(
      runtime.disk.call({ ...scope, root: sourceRoot }, "writeFile", ["source.txt", "modified"])
    ).rejects.toThrow();
    // Even a forged scope cannot make the worker perform a host disk read.
    await expect(
      runtime.disk.call({ ...scope, root }, "readFile", ["host-canary", "utf8"])
    ).rejects.toThrow();
  } finally {
    const stopped = await runtime?.stop();
    if (stopped) expect(stopped.launcherExited).toBe(true);
    await runtime?.retireStorage();
    await rm(root, { recursive: true, force: true });
  }
});
