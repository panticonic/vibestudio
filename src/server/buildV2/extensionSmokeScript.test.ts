import { expect, it } from "vitest";
import { generateExtensionSmokeScript } from "./extensionSmokeScript.js";
import { runIsolatedBuildJob } from "./nativeJobTestFixture.js";
import { writeNativeApprovalModelProvider } from "../../../tests/fixtures/nativeApprovalModelProvider.js";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startNativeWorkspaceRuntime } from "../nativeWorkspaceRuntime.js";

it("joins the real approval provider's HTTP server disposal before the smoke child exits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "approval-smoke-source-"));
  try {
    const source = writeNativeApprovalModelProvider(root);
    await runIsolatedBuildJob({
      script: generateExtensionSmokeScript([]),
      bundle: await readFile(path.join(root, source, "index.js"), "utf8"),
      dependencies: "",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("joins every resource after failed activation and preserves the original failure", async () => {
  await expect(
    runIsolatedBuildJob({
      script: generateExtensionSmokeScript([]),
      bundle: `
      import { createServer } from 'node:http';
      export async function activate(ctx) {
        const server = createServer();
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        ctx.subscriptions.push({dispose: () => new Promise((resolve, reject) =>
          server.close(error => error ? reject(error) : resolve()))});
        ctx.subscriptions.push({dispose() { throw new Error('disposer failed'); }});
        throw new Error('original activation failure');
      }
      export function deactivate() { throw new Error('deactivation failed'); }
    `,
      dependencies: "",
    })
  ).rejects.toThrow(
    /Extension activation smoke and shutdown failed[\s\S]*original activation failure[\s\S]*deactivation failed[\s\S]*disposer failed/u
  );
});

it("reports disposal failure after otherwise successful activation", async () => {
  await expect(
    runIsolatedBuildJob({
      script: generateExtensionSmokeScript([]),
      bundle: `export async function activate(ctx) {
      ctx.subscriptions.push({async dispose() { throw new Error('owned cleanup failed'); }});
      return {};
    }`,
      dependencies: "",
    })
  ).rejects.toThrow("owned cleanup failed");
});

it("keeps the native policy home as cwd for a long nested smoke-job path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "native-smoke-long-cwd-"));
  let statePath = root;
  while (statePath.length < 170) {
    statePath = path.join(statePath, "nested-workspace-root");
  }
  const sourceRoot = path.join(statePath, "source");
  const scratchRoot = path.join(statePath, "scratch", "contexts");
  await mkdir(sourceRoot, { recursive: true });
  const pathSepCount = 4;
  const anticipatedJobPathLength =
    statePath.length + pathSepCount + "native-runtime".length + 36 + "jobs".length + 36;
  expect(anticipatedJobPathLength).toBeGreaterThan(260);

  let runtime: Awaited<ReturnType<typeof startNativeWorkspaceRuntime>> | undefined;
  let primaryFailure: unknown;
  let hasPrimaryFailure = false;
  try {
    runtime = await startNativeWorkspaceRuntime({
      workspaceId: "long-smoke-job-fixture",
      statePath,
      sourceRoot,
      scratchRoot,
      buildsRoot: path.join(statePath, "builds"),
      appRoot: process.cwd(),
    });
    await runtime.runJob({
      script: generateExtensionSmokeScript([]),
      bundle: `
        import path from "node:path";
        let activated = false;
        export async function activate() {
          const bundlePath = process.env.VIBESTUDIO_EXTENSION_SMOKE_BUNDLE;
          if (!bundlePath || path.dirname(bundlePath).length <= 260) {
            throw new Error("Smoke bundle did not use the long nested job path");
          }
          if (path.basename(process.cwd()) !== "home" || path.basename(path.dirname(process.cwd())) !== "scratch") {
            throw new Error("Smoke child did not retain its native runtime policy home as cwd");
          }
          activated = true;
          return {};
        }
        export async function deactivate() {
          if (!activated) throw new Error("Smoke activation did not complete before shutdown");
        }
      `,
      dependencies: "",
    });
  } catch (error) {
    hasPrimaryFailure = true;
    primaryFailure = error;
  }

  let cleanupFailure: unknown;
  let hasCleanupFailure = false;
  try {
    const stopped = await runtime?.stop();
    if (runtime && !stopped?.launcherExited) {
      throw new Error("Long-path smoke runtime still owns its storage");
    }
    await runtime?.retireStorage();
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    hasCleanupFailure = true;
    cleanupFailure = error;
  }

  if (hasPrimaryFailure && hasCleanupFailure) {
    throw new AggregateError(
      [primaryFailure, cleanupFailure],
      "Long-path smoke job and owned runtime cleanup failed",
      { cause: primaryFailure }
    );
  }
  if (hasPrimaryFailure) throw primaryFailure;
  if (hasCleanupFailure) throw cleanupFailure;
});
