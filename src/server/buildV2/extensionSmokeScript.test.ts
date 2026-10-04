import { expect, it } from "vitest";
import { generateExtensionSmokeScript } from "./extensionSmokeScript.js";
import { runIsolatedBuildJob } from "./nativeJobTestFixture.js";
import { writeNativeApprovalModelProvider } from "../../../tests/fixtures/nativeApprovalModelProvider.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

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
