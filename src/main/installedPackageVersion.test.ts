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
    const version = installedPackageVersion(
      owner === "brew"
        ? { manager: "brew", name: "vibestudio", executable: "/opt/homebrew/bin/brew" }
        : { manager: owner, name: owner === "rpm" ? "Vibestudio" : "vibestudio" }
    );
    child.stdout.write(output);
    child.emit("close", 0);
    expect(await version).toBe(expected);
  });

  it("preserves database failures instead of declaring success", async () => {
    const child = query();
    const version = installedPackageVersion({ manager: "rpm", name: "Vibestudio" });
    child.stderr.write("package vibestudio is not installed");
    child.emit("close", 1);
    await expect(version).rejects.toThrow("package vibestudio is not installed");
  });

  it("queries the exact installed RPM identity", async () => {
    const child = query();
    const version = installedPackageVersion({ manager: "rpm", name: "Vibestudio" });
    expect(vi.mocked(spawn).mock.calls.at(-1)?.slice(0, 2)).toEqual([
      "rpm",
      ["-q", "--qf", "%{VERSION}", "Vibestudio"],
    ]);
    child.stdout.write("0.1.78");
    child.emit("close", 0);
    expect(await version).toBe("0.1.78");
  });

  it("propagates the original launch failure", async () => {
    const child = query();
    const version = installedPackageVersion({ manager: "deb", name: "vibestudio" });
    const error = new Error("dpkg-query could not be launched");
    child.emit("error", error);
    await expect(version).rejects.toBe(error);
  });
});
