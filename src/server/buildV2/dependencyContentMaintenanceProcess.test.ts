import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { deserializeRpcFailure, type RpcFailure } from "@vibestudio/rpc";

const execute = promisify(execFile);

it("maintains build and native extension dependency trees through the real child owner", async () => {
  const scratch = path.join(process.cwd(), ".cache/dependency-maintenance-tests");
  await fs.mkdir(scratch, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(scratch, "run-"));
  try {
    const caches = [
      path.join(fixture, "external-deps/1111111111111111"),
      path.join(fixture, "extension-runtime-deps/2222222222222222-darwin-arm64-node24.21.0"),
    ];
    for (const cache of caches) {
      await fs.mkdir(path.join(cache, "node_modules/example"), { recursive: true });
      await fs.writeFile(
        path.join(cache, "node_modules/example/index.js"),
        "export const value = 42;\n"
      );
      await fs.writeFile(path.join(cache, ".ready"), "ready");
    }
    await execute(
      process.execPath,
      ["--import", "tsx", "src/server/buildV2/dependencyContentMaintenanceProcess.ts", ...caches],
      { env: { ...process.env, VIBESTUDIO_SHARED_DERIVED_CACHE_DIR: fixture } }
    );
    const stats = await Promise.all(
      caches.map((cache) => fs.stat(path.join(cache, "node_modules/example/index.js")))
    );
    expect(stats[0]!.ino).toBe(stats[1]!.ino);
    expect(stats[0]!.dev).toBe(stats[1]!.dev);
    expect(stats[0]!.nlink).toBeGreaterThanOrEqual(3);
    const outside = path.join(fixture, "unowned/3333333333333333");
    await expect(
      execute(
        process.execPath,
        ["--import", "tsx", "src/server/buildV2/dependencyContentMaintenanceProcess.ts", outside],
        { env: { ...process.env, VIBESTUDIO_SHARED_DERIVED_CACHE_DIR: fixture } }
      )
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Refusing invalid dependency cache directory"),
    });
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

it("transfers the original maintenance failure graph to its process owner", async () => {
  const scratch = path.join(process.cwd(), ".cache/dependency-maintenance-tests");
  await fs.mkdir(scratch, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(scratch, "failure-"));
  try {
    const outside = path.join(fixture, "unowned/3333333333333333");
    const child = fork("src/server/buildV2/dependencyContentMaintenanceProcess.ts", [outside], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { ...process.env, VIBESTUDIO_SHARED_DERIVED_CACHE_DIR: fixture },
    });
    let failure: unknown;
    const stderr: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("message", (message: unknown) => {
      if (
        message &&
        typeof message === "object" &&
        (message as { type?: unknown }).type === "dependency-maintenance-failure"
      )
        failure = deserializeRpcFailure((message as { failure: RpcFailure }).failure);
    });
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
      child.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
    });
    expect(code).toBe(1);
    expect(signal).toBeNull();
    expect(failure).toMatchObject({
      message: expect.stringContaining("Refusing invalid dependency cache directory"),
    });
    expect(Buffer.concat(stderr).toString()).toContain(
      "Refusing invalid dependency cache directory"
    );
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
