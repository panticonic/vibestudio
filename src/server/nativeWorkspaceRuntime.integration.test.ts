import { expect, it, vi } from "vitest";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { waitForNativeJob } from "./nativeWorkspaceJob.js";
import { startNativeWorkspaceRuntime } from "./nativeWorkspaceRuntime.js";

it("runs the production disk receiver under its platform execution contract", async () => {
  // An Electron-hosted invocation still launches the installed standalone Node
  // runtime used by the production disk receiver.
  if (process.env["ELECTRON_RUN_AS_NODE"] === "1")
    expect(process.versions["electron"]).toBeTruthy();
  const root = await mkdtemp(path.join(tmpdir(), "native-workspace-receiver-"));
  const statePath = path.join(root, "state");
  const sourceRoot = path.join(statePath, "source");
  const scratchRoot = path.join(statePath, "scratch", "contexts");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(path.join(root, "host-canary"), "host secret");
  await writeFile(path.join(sourceRoot, "source.txt"), "immutable source");
  const checkout = path.join(root, "local-template");
  await mkdir(checkout);
  await writeFile(path.join(checkout, "template.txt"), "local candidate");
  const pin = {
    url: "git+https://example.test/examples.git",
    ref: "refs/heads/main",
    commit: "a".repeat(40),
    snapshot: `v1-sha256:${"b".repeat(64)}`,
  };
  vi.stubEnv("VIBESTUDIO_DEV_TEMPLATE_SOURCES", JSON.stringify([{ pin, checkout }]));
  vi.stubEnv("VIBESTUDIO_DEV_TEMPLATE_SOURCES_ENABLED", "1");
  const probe = path.join(sourceRoot, "template-probe.cjs");
  await writeFile(
    probe,
    `
    const assert = require('node:assert/strict');
    const fs = require('node:fs/promises');
    (async () => {
      const [source] = JSON.parse(process.env.VIBESTUDIO_DEV_TEMPLATE_SOURCES);
      assert.deepEqual(source.pin, ${JSON.stringify(pin)});
      assert.equal(process.env.VIBESTUDIO_DEV_TEMPLATE_SOURCES_ENABLED, '1');
      const destination = process.env.HOME + '/template-copy';
      await fs.cp(source.checkout, destination, { recursive: true });
      assert.equal(await fs.readFile(destination + '/template.txt', 'utf8'), 'local candidate');
      if (process.platform !== 'win32') {
        await assert.rejects(fs.writeFile(source.checkout + '/template.txt', 'changed'));
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `
  );
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
    await waitForNativeJob(runtime.fork(probe, {}));
    const scope = { root: scratchRoot, panelId: "fixture", exposeHostPaths: false };
    await runtime.disk.call(scope, "writeFile", ["note.txt", "private scratch"]);
    expect(await runtime.disk.call(scope, "readFile", ["note.txt", "utf8"])).toBe(
      "private scratch"
    );
    expect(
      await runtime.disk.call({ ...scope, root: sourceRoot }, "readFile", ["source.txt", "utf8"])
    ).toBe("immutable source");
    if (process.platform === "win32") {
      // This platform deliberately runs workspace code as the normal host user.
      await runtime.disk.call({ ...scope, root: sourceRoot }, "writeFile", [
        "source.txt",
        "modified",
      ]);
      expect(await runtime.disk.call({ ...scope, root }, "readFile", ["host-canary", "utf8"])).toBe(
        "host secret"
      );
      await runtime.disk.call({ ...scope, root }, "writeFile", ["host-canary", "host write"]);
      expect(await readFile(path.join(root, "host-canary"), "utf8")).toBe("host write");
    } else {
      await expect(
        runtime.disk.call({ ...scope, root: sourceRoot }, "writeFile", ["source.txt", "modified"])
      ).rejects.toThrow();
      // Even a forged scope cannot make the worker perform a host disk read.
      await expect(
        runtime.disk.call({ ...scope, root }, "readFile", ["host-canary", "utf8"])
      ).rejects.toThrow();
    }
  } finally {
    vi.unstubAllEnvs();
    const stopped = await runtime?.stop();
    if (stopped) expect(stopped.launcherExited).toBe(true);
    await runtime?.retireStorage();
    await rm(root, { recursive: true, force: true });
  }
});
