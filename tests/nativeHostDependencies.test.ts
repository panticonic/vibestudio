import { describe, expect, it, vi } from "vitest";
import {
  assertHostNativeDependencies,
  ensureHostNativeDependencies,
  inspectHostNativeDependencies,
} from "../scripts/native-host-dependencies.mjs";

function result(status: number, stderr = "") {
  return { status, stderr, stdout: "", error: undefined };
}

describe("host native dependency contracts", () => {
  it("checks every runtime dependency without mutating the install", () => {
    const run = vi.fn(() => result(0));

    expect(inspectHostNativeDependencies({ run })).toEqual([
      { packageName: "node-datachannel", ok: true },
      { packageName: "node-pty", ok: true },
      { packageName: "@vscode/ripgrep", ok: true },
    ]);
    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls.every((call) => call[0] === process.execPath)).toBe(true);
  });

  it("reports all unavailable dependencies and the exact repair command", () => {
    const run = vi
      .fn()
      .mockReturnValueOnce(result(1, "missing datachannel"))
      .mockReturnValueOnce(result(1, "missing pty"))
      .mockReturnValueOnce(result(0));

    expect(() => assertHostNativeDependencies({ run })).toThrow(
      /pnpm rebuild node-datachannel node-pty/
    );
  });

  it("repairs only failed dependencies and verifies the repaired install", () => {
    const log = vi.fn();
    const run = vi
      .fn()
      .mockReturnValueOnce(result(1, "missing datachannel"))
      .mockReturnValueOnce(result(0))
      .mockReturnValueOnce(result(0))
      .mockReturnValueOnce(result(0))
      .mockReturnValueOnce(result(0))
      .mockReturnValueOnce(result(0))
      .mockReturnValueOnce(result(0));

    ensureHostNativeDependencies({ run, log });

    expect(run.mock.calls[3]?.[1]).toEqual(["rebuild", "node-datachannel"]);
    expect(log).toHaveBeenLastCalledWith(
      "[native-dependencies] Host runtime dependencies repaired and verified."
    );
  });
});
