import { describe, expect, it, vi } from "vitest";
import { signalHubGracefully } from "../scripts/cli/lib/pair-server.mjs";

describe("pair-server process lifecycle", () => {
  it("sends graceful shutdown only to the hub that owns descendant ordering", () => {
    const directKill = vi.fn(() => true);

    expect(signalHubGracefully({ pid: 321, kill: directKill }, "SIGTERM")).toBe(true);
    expect(directKill).toHaveBeenCalledWith("SIGTERM");
  });

  it("delivers a repeated signal to the same hub pid without broadcasting it", () => {
    const directKill = vi.fn();
    const killProcess = vi.fn();

    expect(
      signalHubGracefully({ pid: 321, killed: true, kill: directKill }, "SIGINT", { killProcess })
    ).toBe(true);

    expect(killProcess).toHaveBeenCalledWith(321, "SIGINT");
    expect(killProcess).not.toHaveBeenCalledWith(-321, "SIGINT");
    expect(directKill).not.toHaveBeenCalled();
  });
});
