import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CurrentHostDevelopmentClientExecutor } from "./currentHostDevelopmentClientExecutor.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("CurrentHostDevelopmentClientExecutor", () => {
  it("materializes verified chunks, strips ambient secrets, and removes the exact root after exit", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-client-executor-"));
    roots.push(root);
    const executable = path.join(root, "electron");
    fs.writeFileSync(executable, "reviewed-electron");
    const stateRoot = path.join(root, "clients");
    const requestId = `development-client-${"1".repeat(32)}`;
    const main = Buffer.from("module.exports = {};\n");
    const integrity = `sha256-${createHash("sha256").update(main).digest("hex")}`;
    const calls: Array<{ service: string; method: string; args: unknown[] }> = [];
    const client = {
      async call(service: string, method: string, args: unknown[]) {
        calls.push({ service, method, args });
        if (method === "claim") {
          return {
            requestId,
            runId: "run:one",
            mainEntryBuildId: integrity.slice("sha256-".length),
            executionDigest: "2".repeat(64),
            recipeId: "recipe:one",
            artifacts: [{ path: "dist/main.cjs", integrity, byteLength: main.byteLength }],
            pairingDeepLink: "vibestudio://connect?opaque",
            expiresAt: Date.now() + 60_000,
          };
        }
        if (method === "readArtifact") {
          const input = args[0] as { offset: number };
          return {
            base64: main.subarray(input.offset).toString("base64"),
            nextOffset: main.byteLength,
            eof: true,
          };
        }
        return { accepted: true };
      },
    };
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
    }) as unknown as ChildProcess;
    let spawnOptions: SpawnOptions | undefined;
    const executor = new CurrentHostDevelopmentClientExecutor({
      client: client as never,
      stateRoot,
      electronExecutable: executable,
      spawnProcess: ((_command: string, _args: readonly string[], options: SpawnOptions) => {
        spawnOptions = options;
        return child;
      }) as never,
      captureProcessIdentity: () => ({
        version: 1,
        platform: process.platform === "darwin" ? "darwin" : "linux",
        pid: 4242,
        processGroupId: 4242,
        startCoordinate: "test-start",
      }),
    });

    const priorSecret = process.env["VIBESTUDIO_TEST_SECRET"];
    process.env["VIBESTUDIO_TEST_SECRET"] = "must-not-cross";
    try {
      await executor.handleLaunchRequest({ requestId });
    } finally {
      if (priorSecret === undefined) delete process.env["VIBESTUDIO_TEST_SECRET"];
      else process.env["VIBESTUDIO_TEST_SECRET"] = priorSecret;
    }

    const ownedRoot = path.join(stateRoot, requestId);
    expect(fs.readFileSync(path.join(ownedRoot, "dist", "main.cjs"))).toEqual(main);
    expect(spawnOptions?.env).not.toHaveProperty("VIBESTUDIO_TEST_SECRET");
    expect(spawnOptions?.env).toMatchObject({
      VIBESTUDIO_DEVELOPMENT_LAUNCH_REQUEST: requestId,
      VIBESTUDIO_DEVELOPMENT_EXECUTION_DIGEST: "2".repeat(64),
    });
    expect(calls.some((call) => call.method === "launched")).toBe(true);

    Object.assign(child, { exitCode: 0 });
    child.emit("exit", 0, null);
    await vi.waitFor(() => {
      expect(calls.some((call) => call.method === "exited")).toBe(true);
      expect(fs.existsSync(ownedRoot)).toBe(false);
    });
    await executor.close();
  });
});
