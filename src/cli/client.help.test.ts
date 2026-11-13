import { afterEach, describe, expect, it, vi } from "vitest";
import { commandRegistry, groupCommands, main } from "./client.js";
import { GROUP_ORDER } from "./commandGroups.js";

describe("top-level CLI help", () => {
  afterEach(() => vi.restoreAllMocks());

  it("advertises only groups that have commands", () => {
    const empty = GROUP_ORDER.filter((group) => groupCommands(commandRegistry, group).length === 0);
    expect(empty).toEqual([]);
  });

  it("treats -h like --help", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(main(["-h"])).resolves.toBe(0);
    expect(errors).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("Getting started:"));
  });

  it("rejects flags before a group's command with a usage error", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(main(["storage", "--plain"])).resolves.toBe(2);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("name a command before --plain"));
  });

  it("rejects an argument a command does not take", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(main(["remote", "select", "a", "b"])).resolves.toBe(2);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("Unexpected argument"));
  });
});
