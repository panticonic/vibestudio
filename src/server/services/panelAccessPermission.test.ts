import { describe, expect, it, vi } from "vitest";
import {
  createVerifiedCaller,
  type ServiceContext,
  type VerifiedCaller,
} from "@vibestudio/shared/serviceDispatcher";
import { contextBoundaryResourceKey } from "./contextBoundary.js";
import {
  preparePanelAccessAuthority,
  type PanelAccessPermissionDeps,
} from "./panelAccessPermission.js";

function panelCaller(id: string, repoPath = "panels/requester"): VerifiedCaller {
  return createVerifiedCaller(id, "panel", {
    callerId: id,
    callerKind: "panel",
    repoPath,
    executionDigest: "a".repeat(64),
    delegations: [],
    requested: [],
  });
}

function ctx(caller: VerifiedCaller, panelHosting = false): ServiceContext {
  return {
    caller,
    authority: {
      allows: vi.fn(async ({ capability }) => capability === "panel-hosting" && panelHosting),
      assert: vi.fn(),
    },
  };
}

function deps(overrides: Partial<PanelAccessPermissionDeps> = {}): PanelAccessPermissionDeps {
  return {
    contextExists: vi.fn(() => true),
    resolveContextOwnerLabel: vi.fn(() => "owner"),
    resolveCallerContext: vi.fn(async () => "ctx-caller"),
    resolveEntityContext: vi.fn(() => "ctx-target"),
    resolveSubjectCaller: vi.fn((id: string) => panelCaller(id, "panels/anchor")),
    ...overrides,
  };
}

describe("preparePanelAccessAuthority", () => {
  it("selects no leaf for open, same-context, fresh-context, or panel-hosting actions", async () => {
    const target = { id: "target", contextId: "ctx-target" };
    await expect(
      preparePanelAccessAuthority(deps(), ctx(panelCaller("panel:one")), "read", target)
    ).resolves.toEqual([]);
    await expect(
      preparePanelAccessAuthority(
        deps({ resolveCallerContext: vi.fn(async () => "ctx-target") }),
        ctx(panelCaller("panel:one")),
        "cdp",
        target
      )
    ).resolves.toEqual([]);
    await expect(
      preparePanelAccessAuthority(
        deps({ contextExists: vi.fn(() => false) }),
        ctx(panelCaller("panel:one")),
        "cdp",
        target
      )
    ).resolves.toEqual([]);
    await expect(
      preparePanelAccessAuthority(deps(), ctx(panelCaller("panel:one"), true), "cdp", target)
    ).resolves.toEqual([]);
  });

  it("selects an exact subject/context leaf for a foreign existing target", async () => {
    const [selection] = await preparePanelAccessAuthority(
      deps(),
      ctx(panelCaller("panel:one")),
      "cdp",
      { id: "target", title: "Target", contextId: "ctx-target" }
    );
    expect(selection).toMatchObject({
      capability: "context.boundary",
      resourceKey: contextBoundaryResourceKey("ctx-target", "panel:one"),
      authorizingCaller: { runtime: { id: "panel:one", kind: "panel" } },
      challenge: {
        operation: { kind: "panel", verb: "Automate panel in" },
      },
    });
  });

  it("attributes host-mediated work to its anchor entity", async () => {
    const resolveSubjectCaller = vi.fn(() => panelCaller("panel:anchor", "panels/anchor"));
    const resolveCallerContext = vi.fn(async () => "ctx-anchor");
    const [selection] = await preparePanelAccessAuthority(
      deps({ resolveSubjectCaller, resolveCallerContext }),
      ctx(createVerifiedCaller("server", "server")),
      "close",
      { id: "target", contextId: "ctx-target", runtimeEntityId: "panel:anchor" }
    );
    expect(resolveSubjectCaller).toHaveBeenCalledWith("panel:anchor");
    expect(resolveCallerContext).toHaveBeenCalledWith("panel:anchor");
    expect(selection?.authorizingCaller?.runtime.id).toBe("panel:anchor");
  });

  it("treats unanchored host work as a genuine system action", async () => {
    await expect(
      preparePanelAccessAuthority(deps(), ctx(createVerifiedCaller("server", "server")), "close", {
        id: "target",
        contextId: "ctx-target",
      })
    ).resolves.toEqual([]);
  });

  it("denies a bound agent crossing out of its own existing context", async () => {
    const agent = createVerifiedCaller("agent:one", "agent", null, {
      entityId: "entity:one",
      contextId: "ctx-agent",
      channelId: "channel:one",
      agentId: "agent:one",
      userId: "user:one",
    });
    await expect(
      preparePanelAccessAuthority(deps(), ctx(agent), "cdp", {
        id: "target",
        contextId: "ctx-target",
      })
    ).rejects.toMatchObject({ code: "EACCES" });
  });

  it("carries severe review copy for privileged targets", async () => {
    const [selection] = await preparePanelAccessAuthority(
      deps(),
      ctx(panelCaller("panel:one")),
      "cdp",
      { id: "shell", contextId: "ctx-target", privileged: true }
    );
    expect(selection?.challenge?.severity).toBe("severe");
  });
});
