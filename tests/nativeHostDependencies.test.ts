import { describe, expect, it, vi } from "vitest";
import type {
  SpawnSyncOptionsWithStringEncoding,
  SpawnSyncReturns,
} from "node:child_process";
import {
  assertHostNativeDependencies,
  ensureHostNativeDependencies,
  inspectHostNativeDependencies,
} from "../scripts/native-host-dependencies.mjs";

function result(status: number, stderr = ""): SpawnSyncReturns<string> {
  return {
    pid: process.pid,
    output: ["", "", ""],
    status,
    signal: null,
    stderr,
    stdout: "",
  };
}

describe("host native dependency contracts", () => {
  it("checks every runtime dependency without mutating the install", () => {
    const run = vi.fn(
      (_command: string, _args: readonly string[], _options: SpawnSyncOptionsWithStringEncoding) =>
        result(0)
    );

    expect(inspectHostNativeDependencies({ run })).toEqual([
      { packageName: "@number0/iroh", ok: true },
      { packageName: "node-pty", ok: true },
      { packageName: "@vscode/ripgrep", ok: true },
    ]);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls.every((call) => call[0] === process.execPath)).toBe(true);
  });

  it("reports all unavailable dependencies and the exact repair command", () => {
    const run = vi
      .fn(
        (_command: string, _args: readonly string[], _options: SpawnSyncOptionsWithStringEncoding) =>
          result(0)
      )
      .mockReturnValueOnce(result(1, "missing datachannel"))
      .mockReturnValueOnce(result(1, "missing pty"))
      .mockReturnValueOnce(result(0));

    expect(() => assertHostNativeDependencies({ run })).toThrow(
      /pnpm check:native-host-dependencies --repair/
    );
  });

  it("repairs only failed dependencies and verifies the repaired install", () => {
    const log = vi.fn();
    const run = vi
      .fn(
        (_command: string, _args: readonly string[], _options: SpawnSyncOptionsWithStringEncoding) =>
          result(0)
      )
      .mockReturnValueOnce(result(1, "missing datachannel"))
      .mockReturnValueOnce(result(0))
      .mockReturnValueOnce(result(0))
      .mockReturnValueOnce(result(0))
      .mockReturnValueOnce(result(0))
      .mockReturnValueOnce(result(0))
      .mockReturnValueOnce(result(0));

    ensureHostNativeDependencies({ run, log });

    expect(run.mock.calls[3]?.[1].slice(-2)).toEqual(["rebuild", "@number0/iroh"]);
    expect(log).toHaveBeenLastCalledWith(
      "[native-dependencies] Host runtime dependencies repaired and verified."
    );
  });
});
