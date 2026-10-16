import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectLinuxPackageOwner } from "./linuxPackageOwner.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.resetAllMocks();
});

function answer(status: number, stdout = "") {
  return { status, stdout, stderr: "", pid: 1, signal: null, output: [] };
}

describe("installed Linux package ownership", () => {
  it.each([
    ["deb", "vibestudio:amd64: /opt/Vibestudio/vibestudio\n", "vibestudio:amd64", 0],
    ["rpm", "Vibestudio", "Vibestudio", 1],
    ["pacman", "Vibestudio\n", "Vibestudio", 2],
  ] as const)("retains the exact %s database identity", (manager, output, name, failures) => {
    Object.defineProperty(process, "platform", { value: "linux" });
    for (let index = 0; index < failures; index++) {
      vi.mocked(spawnSync).mockReturnValueOnce(answer(1));
    }
    vi.mocked(spawnSync).mockReturnValueOnce(answer(0, output));
    expect(detectLinuxPackageOwner("/opt/Vibestudio/vibestudio")).toEqual({ manager, name });
    expect(vi.mocked(spawnSync).mock.calls.at(-1)?.[1]).toContain("/opt/Vibestudio/vibestudio");
  });

  it("offers no identity when no database claims the executable", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.mocked(spawnSync).mockReturnValue(answer(1));
    expect(detectLinuxPackageOwner("/opt/Vibestudio/vibestudio")).toBeNull();
  });

  it("does not query Linux databases on another platform", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    expect(detectLinuxPackageOwner("/Applications/Vibestudio.app")).toBeNull();
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
