import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { installedPackageVersion } from "./installedPackageVersion.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

function query() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  vi.mocked(spawn).mockReturnValueOnce(child as never);
  return child;
}

describe("installed package version", () => {
  it.each([
    ["deb", "0.2.0-1", "0.2.0-1"],
    ["rpm", "0.2.0", "0.2.0"],
    ["pacman", "vibestudio 0.2.0-1\n", "0.2.0-1"],
    ["brew", "vibestudio 0.2.0\n", "0.2.0"],
  ] as const)("reads the installed version from %s", async (owner, output, expected) => {
    const child = query();
    const version = installedPackageVersion(owner);
    child.stdout.write(output);
    child.emit("close", 0);
    expect(await version).toBe(expected);
  });

  it("preserves database failures instead of declaring success", async () => {
    const child = query();
    const version = installedPackageVersion("rpm");
    child.stderr.write("package vibestudio is not installed");
    child.emit("close", 1);
    await expect(version).rejects.toThrow("package vibestudio is not installed");
  });

  it("propagates the original launch failure", async () => {
    const child = query();
    const version = installedPackageVersion("deb");
    const error = new Error("dpkg-query could not be launched");
    child.emit("error", error);
    await expect(version).rejects.toBe(error);
  });
});
