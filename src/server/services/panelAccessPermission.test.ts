import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { contextBoundaryResourceKey } from "./contextBoundary.js";
import {
  panelAccessTargetFromDetail,
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
  controlsLifecycleContext: async () => false,
  resolveSubjectCaller: () => null,
  ...overrides,
});

describe("preparePanelAccessAuthority", () => {
  it("projects the semantic panel title instead of its stable tree address", () => {
    expect(
      panelAccessTargetFromDetail("panel:tree/root/browser~example", {
        slot: { current_entity_title: "Example dashboard" },
        currentHistory: { source: "browser:https://example.com", context_id: "ctx-target" },
        entity: { id: "panel:runtime" },
      })
    ).toEqual({
      id: "panel:tree/root/browser~example",
      title: "Example dashboard",
      source: "browser:https://example.com",
      kind: "browser",
      runtimeEntityId: "panel:runtime",
      contextId: "ctx-target",
    });
  });

  it("uses the presented source while a semantic panel title is unavailable", () => {
    expect(
      panelAccessTargetFromDetail("panel:tree/root/panels~chat", {
        slot: { current_entity_title: null },
        currentHistory: { source: "panels/chat", context_id: "ctx-target" },
        entity: { id: "panel:runtime" },
      }).title
    ).toBe("panels/chat");
  });

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

  it("keeps lifecycle-child panel operations inside the supervising caller's authority", async () => {
    const controlsLifecycleContext = vi.fn(async () => true);
    await expect(
      preparePanelAccessAuthority(deps({ controlsLifecycleContext }), ctx, "openPanel", {
        id: "parent-panel",
        requestedContextId: "ctx-subagent",
      })
    ).resolves.toEqual([]);
    expect(controlsLifecycleContext).toHaveBeenCalledWith(
      "panel:requester",
      "ctx-caller",
      "ctx-subagent"
    );
  });

  it("keeps a collection agent's same-context subtree operations prompt-free", async () => {
    const collectionAgent = createVerifiedCaller(
      "do:collection-conductor",
      "agent",
      {
        callerId: "do:collection-conductor",
        callerKind: "do",
        repoPath: "workers/agent-worker",
        effectiveVersion: "v1",
      },
      {
        entityId: "panel:collection",
        contextId: "ctx-collection",
        channelId: "collection-channel",
        agentId: "agent:collection-conductor",
      }
    );
    const agentContext: ServiceContext = { caller: collectionAgent };
    const collectionDeps = deps({
      resolveCallerContext: async () => null,
      resolveEntityContext: () => "ctx-collection",
    });

    await expect(
      preparePanelAccessAuthority(collectionDeps, agentContext, "updatePanelState", {
        id: "nested-collection",
        contextId: "ctx-collection",
      })
    ).resolves.toEqual([]);
    await expect(
      preparePanelAccessAuthority(collectionDeps, agentContext, "movePanel", {
        id: "imported-browser-panel",
        contextId: "ctx-collection",
      })
    ).resolves.toEqual([]);
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
