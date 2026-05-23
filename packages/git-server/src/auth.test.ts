import { describe, expect, it } from "vitest";
import { GitAuthManager } from "./auth.js";

describe("GitAuthManager", () => {
  it("allows shell callers to push", () => {
    const auth = new GitAuthManager();

    expect(auth.canAccess("shell:1", "shell", "panels/example", "push")).toEqual({ allowed: true });
  });

  it.each([
    ["panel", "panel:chat"],
    ["worker", "worker:agent"],
    ["do", "do:workspace"],
  ])("lets %s callers reach the approval gate for normal workspace repos", (kind, callerId) => {
    const auth = new GitAuthManager();

    expect(auth.canAccess(callerId, kind, "panels/terminal", "push")).toEqual({
      allowed: true,
    });
  });

  it.each([
    ["panel", "panel:chat"],
    ["worker", "worker:agent"],
    ["do", "do:workspace"],
  ])("lets %s callers reach approval for protected repo paths", (kind, callerId) => {
    const auth = new GitAuthManager(() => "workers/agent-worker");

    expect(auth.canAccess(callerId, kind, "tree/panels/terminal", "push")).toEqual({
      allowed: true,
    });
  });

  it("allows fetches for authenticated callers", () => {
    const auth = new GitAuthManager();

    expect(auth.canAccess("panel:chat", "panel", "tree/panels/chat", "fetch")).toEqual({
      allowed: true,
    });
  });

  it("rejects malformed repo paths before git routing", () => {
    const auth = new GitAuthManager();

    expect(auth.canAccess("panel:chat", "panel", "../panels/chat", "push")).toEqual({
      allowed: false,
      reason: expect.stringContaining("Invalid repo path segment"),
    });
  });
});
