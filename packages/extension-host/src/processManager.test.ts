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
  it("retires RPC before best-effort cancellation of a child that never exits", async () => {
    vi.useFakeTimers();
    try {
      const retire = vi.fn();
      const proc = Object.assign(new EventEmitter(), {
        stdout: null,
        stderr: null,
        postMessage: vi.fn(),
        kill: vi.fn(() => {
          expect(retire).toHaveBeenCalledOnce();
          return true;
        }),
      }) as unknown as ProcessAdapter;
      vi.mocked(createProcessAdapter).mockReturnValue(proc);
      const manager = new ExtensionProcessManager({
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
        rpcToken: "synthetic-fixture-token",
      });
      await vi.advanceTimersByTimeAsync(0);
      manager.markReady(name, { methods: [], hasFetch: false });
      await starting;
      const stopping = manager.stop(name);
      expect(retire).toHaveBeenCalledOnce();
      expect(proc.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2500);
      await stopping;
      expect(proc.kill).toHaveBeenCalledOnce();
      expect(manager.isActive(name)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
