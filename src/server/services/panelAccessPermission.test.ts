import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { contextBoundaryResourceKey } from "./contextBoundary.js";
import {
  preparePanelAccessAuthority,
  type PanelAccessPermissionDeps,
} from "./panelAccessPermission.js";

const caller = createVerifiedCaller("panel:requester", "panel", {
  callerId: "panel:requester",
  callerKind: "panel",
  repoPath: "panels/requester",
  effectiveVersion: "v1",
});
const ctx: ServiceContext = { caller };
const deps = (overrides: Partial<PanelAccessPermissionDeps> = {}): PanelAccessPermissionDeps => ({
  contextExists: () => true,
  resolveCallerContext: async () => "ctx-caller",
  resolveEntityContext: () => "ctx-target",
  resolveSubjectCaller: () => null,
  ...overrides,
});

describe("preparePanelAccessAuthority", () => {
  it("leaves reads, same-context actions, and fresh destinations open", async () => {
    await expect(
      preparePanelAccessAuthority(deps(), ctx, "read", { id: "target", contextId: "ctx-target" })
    ).resolves.toEqual([]);
    await expect(
      preparePanelAccessAuthority(
        deps({ resolveCallerContext: async () => "ctx-target" }),
        ctx,
        "cdp",
        { id: "target", contextId: "ctx-target" }
      )
    ).resolves.toEqual([]);
    await expect(
      preparePanelAccessAuthority(deps({ contextExists: () => false }), ctx, "openPanel", {
        id: "parent",
        requestedContextId: "ctx-fresh",
      })
    ).resolves.toEqual([]);
  });

  it("selects a gated exact context leaf for ordinary foreign targets", async () => {
    await expect(
      preparePanelAccessAuthority(deps(), ctx, "cdp", {
        id: "target",
        title: "Target",
        contextId: "ctx-target",
      })
    ).resolves.toEqual([
      expect.objectContaining({
        resourceKey: contextBoundaryResourceKey("ctx-target", "panel:requester"),
        tier: "gated",
        challenge: expect.objectContaining({
          operation: expect.objectContaining({ verb: "Automate panel in" }),
        }),
      }),
    ]);
  });

  it("keeps creator-controlled panel operations inside the caller's authority", async () => {
    const isEntityControlledBy = vi.fn(() => true);
    await expect(
      preparePanelAccessAuthority(deps({ isEntityControlledBy }), ctx, "close", {
        id: "created-panel",
        runtimeEntityId: "panel:created-runtime",
        contextId: "ctx-created-panel",
      })
    ).resolves.toEqual([]);
    expect(isEntityControlledBy).toHaveBeenCalledWith("panel:created-runtime", "panel:requester");
  });

  it("selects critical for privileged targets and bypasses authorized chrome", async () => {
    await expect(
      preparePanelAccessAuthority(deps(), ctx, "close", {
        id: "shell",
        privileged: true,
        contextId: "ctx-target",
      })
    ).resolves.toEqual([expect.objectContaining({ tier: "critical" })]);
    const hasAppCapability = vi.fn(() => true);
    const appContext: ServiceContext = {
      caller: createVerifiedCaller("@workspace-apps/shell", "app", {
        callerId: "@workspace-apps/shell",
        callerKind: "app",
        repoPath: "apps/shell",
        effectiveVersion: "v1",
      }),
    };
    await expect(
      preparePanelAccessAuthority(deps({ hasAppCapability }), appContext, "close", {
        id: "target",
        contextId: "ctx-target",
      })
    ).resolves.toEqual([]);
    expect(hasAppCapability).toHaveBeenCalled();
  });
});
