import * as path from "node:path";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createProcessAdapter, type ProcessAdapter } from "@vibestudio/process-adapter";
import { describe, expect, it, vi } from "vitest";

import {
  ExtensionProcessManager,
  extensionRuntimeExecArgv,
  resolveChildRuntimePath,
} from "./processManager.js";

vi.mock("@vibestudio/process-adapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vibestudio/process-adapter")>()),
  createProcessAdapter: vi.fn(),
}));

describe("ExtensionProcessManager runtime resolution", () => {
  it("uses the installed built runtime even when the host is loaded from source", () => {
    expect(path.basename(resolveChildRuntimePath())).toBe("childRuntime.js");
    expect(path.basename(path.dirname(resolveChildRuntimePath()))).toBe("dist");
  });

  it("resolves the built artifact under the actual source-host loader", () => {
    const module = fileURLToPath(new URL("./processManager.ts", import.meta.url));
    const script = `import {resolveChildRuntimePath} from ${JSON.stringify(module)}; process.stdout.write(resolveChildRuntimePath());`;
    const resolved = execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { encoding: "utf8" }
    );
    expect(resolved).toBe(resolveChildRuntimePath());
  });

  it("does not inherit host loaders or other parent exec argv", () => {
    const previous = process.env["VIBESTUDIO_PROD"];
    process.env["VIBESTUDIO_PROD"] = "1";
    try {
      expect(extensionRuntimeExecArgv()).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env["VIBESTUDIO_PROD"];
      else process.env["VIBESTUDIO_PROD"] = previous;
    }
  });

  it("ignores a stale exit after a replacement generation owns the name", () => {
    const onStatus = vi.fn();
    const manager = new ExtensionProcessManager({
      launch: (environment) => createProcessAdapter(resolveChildRuntimePath(), environment),
      attachProcess: vi.fn(() => vi.fn()),
      onStatus,
      onHealth: vi.fn(),
      onLog: vi.fn(),
    });
    const state = {
      name: "@workspace-extensions/shell",
      version: "1.0.0",
      bundlePath: "/build/bundle.js",
      storageDir: "/state",
      gatewayUrl: "http://localhost",
      rpcToken: "token",
    };
    const makeGeneration = () => ({
      state,
      proc: {},
      ready: true,
      methods: ["open"],
      hasFetch: false,
      pending: new Map(),
      lastStartedAt: Date.now(),
      stopping: false,
      health: null,
      inspectorUrl: null,
      stderrTail: [],
      exitHandler: vi.fn(),
    });
    const stale = makeGeneration();
    const replacement = makeGeneration();
    const internals = manager as unknown as {
      running: Map<string, unknown>;
      handleExit(generation: unknown, code: number | null): void;
    };
    internals.running.set(state.name, replacement);

    internals.handleExit(stale, 1);

    expect(internals.running.get(state.name)).toBe(replacement);
    expect(onStatus).not.toHaveBeenCalled();
  });
});

describe("ExtensionProcessManager session retirement", () => {
  function fixture() {
    const retire = vi.fn();
    const proc = Object.assign(new EventEmitter(), {
      stdout: null,
      stderr: null,
      postMessage: vi.fn(),
      kill: vi.fn(() => true),
    });
    const manager = new ExtensionProcessManager({
      launch: () => proc as unknown as ProcessAdapter,
      attachProcess: () => retire,
      onStatus: vi.fn(),
      onHealth: vi.fn(),
      onLog: vi.fn(),
    });
    const name = "@workspace-extensions/fixture";
    const starting = manager.start({
      name,
      version: "1",
      bundlePath: "/fixture.js",
      storageDir: "/state",
      gatewayUrl: "http://localhost",
      rpcToken: "fixture-token",
    });
    return { manager, proc, retire, name, starting };
  }
  async function ready(value: ReturnType<typeof fixture>) {
    await Promise.resolve();
    await Promise.resolve();
    value.manager.markReady(value.name, { methods: [], hasFetch: false });
    await value.starting;
  }
  function request(proc: ReturnType<typeof fixture>["proc"]) {
    return vi.mocked(proc.postMessage).mock.calls.at(-1)![0] as { type: string; requestId: string };
  }
  it("retains the authenticated cleanup route until acknowledged shutdown and exact physical exit", async () => {
    const value = fixture();
    await ready(value);
    let completed = false;
    const closing = value.manager.stop(value.name).then(() => {
      completed = true;
    });
    const sent = request(value.proc);
    expect(sent.type).toBe("shutdown");
    expect(value.retire).not.toHaveBeenCalled();
    value.proc.emit("message", { type: "shutdown-result", requestId: sent.requestId, ok: true });
    await Promise.resolve();
    expect(completed).toBe(false);
    expect(value.manager.isActive(value.name)).toBe(true);
    expect(value.proc.kill).not.toHaveBeenCalled();
    value.proc.emit("exit", 0);
    await closing;
    expect(value.retire).toHaveBeenCalledOnce();
    expect(value.manager.isActive(value.name)).toBe(false);
  });
  it("retains failed cleanup for explicit retry and preserves structured original failures", async () => {
    const value = fixture();
    await ready(value);
    const closing = value.manager.stop(value.name);
    const sent = request(value.proc);
    value.proc.emit("message", {
      type: "shutdown-result",
      requestId: sent.requestId,
      ok: false,
      error: {
        name: "AggregateError",
        message: "cleanup failed",
        cause: { name: "Error", message: "original stop failure" },
        errors: [
          { name: "Error", message: "original stop failure" },
          { name: "Error", message: "second cleanup failure" },
        ],
      },
    });
    await expect(closing).rejects.toMatchObject({
      cause: { message: "original stop failure" },
      errors: [{ message: "original stop failure" }, { message: "second cleanup failure" }],
    });
    expect(value.retire).not.toHaveBeenCalled();
    expect(value.manager.isActive(value.name)).toBe(true);
    const retry = value.manager.stop(value.name);
    const resent = request(value.proc);
    expect(resent.requestId).not.toBe(sent.requestId);
    value.proc.emit("message", { type: "shutdown-result", requestId: resent.requestId, ok: true });
    value.proc.emit("exit", 0);
    await retry;
  });
  it("propagates authoritative exit without cleanup acknowledgement instead of reporting success", async () => {
    const value = fixture();
    await ready(value);
    const closing = value.manager.stop(value.name);
    const readiness = value.manager.whenRunning(value.name);
    const readinessResult = readiness.catch((error) => error);
    value.proc.emit("exit", 1);
    await expect(closing).rejects.toThrow("exited without completing shutdown");
    expect(await readinessResult).toBe(await closing.catch((error) => error));
    expect(value.manager.isActive(value.name)).toBe(false);
  });

  it("settles replacement readiness with the original cleanup failure and allows an explicit retry", async () => {
    const value = fixture();
    await ready(value);
    const replacement = value.manager.start({
      name: value.name,
      version: "2",
      bundlePath: "/replacement.js",
      storageDir: "/state",
      gatewayUrl: "http://localhost",
      rpcToken: "replacement-token",
    });
    const readinessResult = value.manager.whenRunning(value.name).catch((error) => error);
    const sent = request(value.proc);
    value.proc.emit("message", {
      type: "shutdown-result",
      requestId: sent.requestId,
      ok: false,
      error: { name: "Error", message: "original cleanup failure" },
    });
    const failure = await replacement.catch((error) => error);
    expect(failure).toMatchObject({ message: "original cleanup failure" });
    expect(await readinessResult).toBe(failure);
    expect(value.retire).not.toHaveBeenCalled();

    const retry = value.manager.stop(value.name);
    const resent = request(value.proc);
    value.proc.emit("message", { type: "shutdown-result", requestId: resent.requestId, ok: true });
    value.proc.emit("exit", 0);
    await retry;
    expect(value.retire).toHaveBeenCalledOnce();
  });

  it("preserves an abnormal physical exit even after cleanup was acknowledged", async () => {
    const value = fixture();
    await ready(value);
    const closing = value.manager.stop(value.name);
    const sent = request(value.proc);
    value.proc.emit("message", { type: "shutdown-result", requestId: sent.requestId, ok: true });
    value.proc.emit("exit", 1);
    await expect(closing).rejects.toThrow("failed after shutdown acknowledgement");
    expect(value.manager.isActive(value.name)).toBe(false);
  });
});
