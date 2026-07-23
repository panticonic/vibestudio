import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  ExtensionProcessManager,
  extensionRuntimeExecArgv,
  resolveChildRuntimePath,
} from "./processManager.js";

describe("ExtensionProcessManager runtime resolution", () => {
  it("falls back to the TypeScript child runtime when running from source", () => {
    expect(path.basename(resolveChildRuntimePath())).toBe("childRuntime.ts");
  });

  it("preserves parent exec argv when inspector injection is disabled", () => {
    const previous = process.env["VIBESTUDIO_PROD"];
    process.env["VIBESTUDIO_PROD"] = "1";
    try {
      expect(extensionRuntimeExecArgv()).toEqual(
        process.execArgv.length > 0 ? process.execArgv : undefined
      );
    } finally {
      if (previous === undefined) delete process.env["VIBESTUDIO_PROD"];
      else process.env["VIBESTUDIO_PROD"] = previous;
    }
  });

  it("ignores a stale exit after a replacement generation owns the name", () => {
    const onStatus = vi.fn();
    const manager = new ExtensionProcessManager({
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
