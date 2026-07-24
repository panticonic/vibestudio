import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOwnerPanelSeedStore,
  createOwnerSeedingPanelTreeBridge,
  createServerPanelTreeBridge,
  PANEL_PARENT_RESOLUTION_TIMEOUT_MS,
  panelHostCommandAssignmentError,
  resolvePanelParentWithDeadline,
  seedPanelTreeIfEmpty,
  snapshotBrowserPanelFromCdpBridge,
} from "./ownerPanelTreeBridge.js";

function readyBoot(
  runtimeEntityId: string,
  buildKey: string,
  source = "panels/target",
  contextId = "ctx-target"
) {
  return {
    phase: "ready",
    runtimeEntityId,
    source,
    contextId,
    effectiveVersion: "ev-target",
    buildKey,
  };
}
import type { PanelTreeBridgeRequest } from "./services/panelTreeService.js";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";

describe("panelHostCommandAssignmentError", () => {
  it("classifies mobile-held structural host commands distinctly", () => {
    const error = panelHostCommandAssignmentError("slot-mobile", "mobile_held") as Error & {
      code?: string;
    };

    expect(error.message).toBe("Panel slot-mobile is held by a non-CDP host");
    expect(error.code).toBe("panel_host_command_unavailable_mobile_held");
  });

  it("classifies missing default CDP hosts without waiting for provider readiness", () => {
    const error = panelHostCommandAssignmentError(
      "panel:tree/slot-a",
      "no_default_cdp_host"
    ) as Error & {
      code?: string;
    };

    expect(error.message).toBe("No CDP-capable host is available for panel: panel:tree/slot-a");
    expect(error.code).toBe("panel_host_command_no_default_cdp_host");
  });

  it("does not fail when the slot is already held by a CDP-capable host", () => {
    expect(panelHostCommandAssignmentError("panel:tree/slot-a", "already_held")).toBeNull();
  });
});

describe("resolvePanelParentWithDeadline", () => {
  it("returns a finite diagnostic when lineage storage does not settle", async () => {
    vi.useFakeTimers();
    try {
      const resolution = resolvePanelParentWithDeadline(
        "do:eval",
        {
          isOpenSlot: () => false,
          resolveOpenSlotForEntity: async () => await new Promise(() => {}),
          resolveParentId: async () => undefined,
        },
        25
      );
      const rejected = expect(resolution).rejects.toMatchObject({
        code: "parent_resolution_timeout",
        errorData: { startId: "do:eval", timeoutMs: 25 },
      });
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      expect(PANEL_PARENT_RESOLUTION_TIMEOUT_MS).toBe(5_000);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("snapshotBrowserPanelFromCdpBridge", () => {
  it("serves browser panel snapshots through the bounded host DOM command", async () => {
    const dom = { kind: "synth", text: "Example\nSubmit", structure: { tag: "body" } };
    const cdpBridge = {
      isTargetRegistered: () => true,
      sendHostCommand: vi.fn(async () => dom),
    };

    const snapshot = await snapshotBrowserPanelFromCdpBridge(cdpBridge, "browser-slot");

    expect(snapshot).toEqual({
      kind: "synth",
      text: "Example\nSubmit",
      structure: { tag: "body" },
    });
    expect(cdpBridge.sendHostCommand).toHaveBeenCalledWith("browser-slot", "domSnapshot", []);
  });

  it("does not auto-load browser targets for snapshots", async () => {
    const cdpBridge = {
      isTargetRegistered: () => false,
      sendHostCommand: vi.fn(),
    };

    await expect(snapshotBrowserPanelFromCdpBridge(cdpBridge, "browser-slot")).rejects.toThrow(
      "target-not-loaded: browser-slot"
    );
    expect(cdpBridge.sendHostCommand).not.toHaveBeenCalled();
  });

  it("fails loudly when the host violates the DOM snapshot contract", async () => {
    const cdpBridge = {
      isTargetRegistered: () => true,
      sendHostCommand: vi.fn(async () => []),
    };

    await expect(snapshotBrowserPanelFromCdpBridge(cdpBridge, "browser-slot")).rejects.toThrow(
      "host returned an invalid DOM snapshot"
    );
    expect(cdpBridge.sendHostCommand).toHaveBeenCalledTimes(1);
  });
});

async function createSinglePanelBridge(options?: {
  callTarget?: ReturnType<typeof vi.fn>;
  ensureDefaultCdpHostForSlot?: ReturnType<typeof vi.fn>;
  activeExecution?: {
    buildKey: string;
    digest: string;
    authority: {
      requests: Array<{
        capability: string;
        resource: { kind: "exact"; key: string };
      }>;
    };
  };
  corruptExecution?: boolean;
  hostObservation?: Record<string, unknown>;
}) {
  const now = Date.now();
  const slot = {
    slot_id: "panel:tree/slot-a",
    parent_slot_id: null,
    current_entity_id: "panel:entry-a",
    current_entity_title: "Target",
    current_entry_key: "entry-a",
    position_id: "root",
    created_at: now,
    closed_at: null,
  };
  const history = {
    slot_id: slot.slot_id,
    cursor: 0,
    entry_key: "entry-a",
    entity_id: slot.current_entity_id,
    source: "panels/target",
    context_id: "ctx-target",
    state_args: null,
    recorded_at: now,
  };
  const activeExecution =
    options?.activeExecution ??
    (options?.corruptExecution
      ? undefined
      : {
          buildKey: "b".repeat(64),
          digest: "e".repeat(64),
          authority: { requests: [] },
        });
  const entity = {
    id: slot.current_entity_id,
    kind: "panel",
    source: { repoPath: "panels/target", effectiveVersion: "ev-target" },
    ...(activeExecution
      ? {
          activeBuildKey: activeExecution.buildKey,
          activeExecutionDigest: activeExecution.digest,
          activeAuthority: activeExecution.authority,
        }
      : {}),
    contextId: "ctx-target",
    key: "entry-a",
    createdAt: now,
    status: "active",
    cleanupComplete: false,
  };
  const dispatch = vi.fn(async (_ctx, service: string, method: string, args: unknown[]) => {
    if (service === "workspace-state" && method === "slot.list") return [slot];
    if (service === "workspace-state" && method === "slot.get") {
      return args[0] === slot.slot_id ? slot : null;
    }
    if (service === "workspace-state" && method === "slot.history") return [history];
    if (
      service === "workspace-state" &&
      (method === "entity.resolveActive" || method === "entity.resolve")
    )
      return entity;
    if (service === "workspace-state" && method === "panel.search") return [];
    if (service === "build" && method === "getPanelMetadata") return { title: "Target" };
    if (service === "presence" && method === "markPanelActive") return undefined;
    throw new Error(`Unexpected dispatch: ${service}.${method}`);
  });
  const nodes = [{ role: { value: "heading" }, name: { value: "Target" } }];
  const cdpBridge = {
    isProviderConnected: vi.fn(() => true),
    isTargetRegisteredForHost: vi.fn(() => true),
    isTargetRegistered: vi.fn(() => true),
    sendHostCommand: vi.fn(async (_panelId: string, action: string) => {
      if (action === "domSnapshot") {
        return { kind: "synth", text: "Target", structure: { role: "heading", name: "Target" } };
      }
      if (action === "panelObservation") {
        return (
          options?.hostObservation ?? {
            holderLabel: "Desktop",
            platform: "desktop",
            supportsInspection: true,
            view: { exists: true, url: "http://localhost/panels/target", loading: false },
            boot: {
              ...readyBoot(slot.current_entity_id, activeExecution!.buildKey),
              updatedAt: now,
            },
          }
        );
      }
      return nodes;
    }),
  };
  const callTarget = options?.callTarget ?? vi.fn(async () => ({ kind: "agent" }));
  const ensureDefaultCdpHostForSlot =
    options?.ensureDefaultCdpHostForSlot ??
    vi.fn(() => ({ assigned: true, lease: { holderLabel: "Desktop" } }));
  const eventService = { emit: vi.fn() };
  const bridge = await createServerPanelTreeBridge({
    container: {
      get: vi.fn((name: string) => (name === "rpcServer" ? { server: { callTarget } } : cdpBridge)),
    },
    dispatcher: { dispatch },
    workspace: {},
    workspacePath: "/tmp/workspace",
    workspaceConfig: {},
    adminToken: "admin-token",
    centralData: null,
    hostConfig: { gatewayPort: 0, externalHost: "localhost", protocol: "http" },
    isIpcMode: false,
    panelRuntimeCoordinator: {
      resolveHostForSlot: vi.fn(() => ({
        hostConnectionId: "desktop-host",
        supportsCdp: true,
      })),
      ensureDefaultCdpHostForSlot,
    },
    eventService,
  } as never);
  return {
    bridge,
    callTarget,
    cdpBridge,
    ensureDefaultCdpHostForSlot,
    slot,
    dispatch,
    eventService,
  };
}

describe("createServerPanelTreeBridge ergonomic panel lifecycle", () => {
  it("hydrates panel authority from the durable runtime incarnation", async () => {
    const activeExecution = {
      buildKey: "b".repeat(64),
      digest: "a".repeat(64),
      authority: {
        requests: [
          {
            capability: "service:panel.getInfo",
            resource: { kind: "exact" as const, key: "panel:getInfo" },
          },
        ],
      },
    };
    const { bridge } = await createSinglePanelBridge({ activeExecution });

    await expect(
      bridge({ callerId: "server", callerKind: "server", method: "list", args: [] })
    ).resolves.toEqual([
      expect.objectContaining({
        buildKey: activeExecution.buildKey,
        executionDigest: activeExecution.digest,
        authorityRequests: activeExecution.authority.requests,
      }),
    ]);
  });

  it("publishes corrupt panels with incomplete execution identity as unavailable", async () => {
    const { bridge } = await createSinglePanelBridge({ corruptExecution: true });

    await expect(
      bridge({ callerId: "server", callerKind: "server", method: "getTreeSnapshot", args: [] })
    ).resolves.toMatchObject({
      forest: [
        {
          rootPanels: [
            {
              buildKey: null,
              executionDigest: null,
              artifacts: {
                buildState: "error",
                error: expect.stringContaining("incompatible or corrupt"),
              },
            },
          ],
        },
      ],
    });
  });

  it("loads a panel before reporting focus", async () => {
    const { bridge, ensureDefaultCdpHostForSlot, slot } = await createSinglePanelBridge();

    await expect(
      bridge({ callerId: "server", callerKind: "server", method: "focus", args: [slot.slot_id] })
    ).resolves.toMatchObject({
      panelId: slot.slot_id,
      phase: "ready",
    });
    expect(ensureDefaultCdpHostForSlot).toHaveBeenCalled();
  });

  it("reports the shell's build failure instead of accepting a registered blank target", async () => {
    const { bridge, slot } = await createSinglePanelBridge({
      hostObservation: {
        view: { exists: true, url: "about:blank", loading: false },
        boot: { phase: "unavailable" },
        failure: {
          code: "unit_not_found",
          stage: "resolve",
          message: "Unknown build unit: panels/target",
        },
      },
    });

    await expect(
      bridge({ callerId: "server", callerKind: "server", method: "observe", args: [slot.slot_id] })
    ).resolves.toMatchObject({
      phase: "failed",
      failure: {
        code: "unit_not_found",
        stage: "resolve",
        provenance: {
          panelId: slot.slot_id,
          source: "panels/target",
          buildKey: "b".repeat(64),
        },
      },
    });
  });

  it("does not accept a ready document from a superseded runtime attempt", async () => {
    const { bridge, slot } = await createSinglePanelBridge({
      hostObservation: {
        view: { exists: true, url: "http://localhost/panels/target", loading: false },
        boot: readyBoot("panel:nav-old", "a".repeat(64)),
      },
    });

    await expect(
      bridge({ callerId: "server", callerKind: "server", method: "observe", args: [slot.slot_id] })
    ).resolves.toMatchObject({
      runtimeEntityId: slot.current_entity_id,
      buildKey: "b".repeat(64),
      phase: "booting",
    });
  });

  it("publishes an agent-requested presentation hint after focusing the panel", async () => {
    const { bridge, eventService, slot } = await createSinglePanelBridge();

    await bridge({
      callerId: "server",
      callerKind: "server",
      method: "focus",
      args: [
        slot.slot_id,
        {
          anchorPanelId: "panel:tree/anchor",
          placement: { disposition: "side", preferredWidth: 640 },
        },
      ],
    });

    expect(eventService.emit).toHaveBeenCalledWith(
      "navigate-to-panel",
      expect.objectContaining({
        panelId: slot.slot_id,
        anchorPanelId: "panel:tree/anchor",
        hint: { disposition: "side", preferredWidth: 640 },
        intentId: expect.stringMatching(/^focus:/),
      })
    );
  });

  it("uses the hosted DOM snapshot when a panel has no agent snapshot API", async () => {
    const callTarget = vi.fn(async () => {
      throw new Error("Target not reachable");
    });
    const { bridge, cdpBridge, slot } = await createSinglePanelBridge({ callTarget });

    await expect(
      bridge({ callerId: "server", callerKind: "server", method: "snapshot", args: [slot.slot_id] })
    ).resolves.toEqual({
      panelId: slot.slot_id,
      attemptId: `${slot.current_entity_id}@${"b".repeat(64)}`,
      runtimeEntityId: slot.current_entity_id,
      buildKey: "b".repeat(64),
      capturedAt: expect.any(Number),
      document: {
        kind: "synth",
        text: "Target",
        structure: { role: "heading", name: "Target" },
      },
    });
    expect(callTarget).not.toHaveBeenCalled();
    expect(cdpBridge.sendHostCommand).toHaveBeenCalledWith(slot.slot_id, "domSnapshot", []);
  });

  it("falls back to the hosted DOM tree when a panel has no in-process agent tree API", async () => {
    const callTarget = vi.fn(async () => {
      throw new Error('Method "_agent.tree" is not exposed by this endpoint');
    });
    const { bridge, cdpBridge, slot } = await createSinglePanelBridge({ callTarget });

    await expect(
      bridge({
        callerId: "server",
        callerKind: "server",
        method: "callAgent",
        args: [slot.slot_id, "_agent.tree", []],
      })
    ).resolves.toEqual({ role: "heading", name: "Target" });
    expect(cdpBridge.sendHostCommand).toHaveBeenCalledWith(slot.slot_id, "domSnapshot", []);
  });
});

describe("createServerPanelTreeBridge reload", () => {
  it("reloads the target view without unloading the panel runtime lease", async () => {
    const now = Date.now();
    const slot = {
      slot_id: "panel:tree/slot-a",
      parent_slot_id: null,
      current_entity_id: "panel:entry-a",
      current_entity_title: "Target",
      current_entry_key: "entry-a",
      position_id: "root",
      created_at: now,
      closed_at: null,
    };
    const history = {
      slot_id: "panel:tree/slot-a",
      cursor: 0,
      entry_key: "entry-a",
      entity_id: "panel:entry-a",
      source: "panels/target",
      context_id: "ctx-target",
      state_args: null,
      recorded_at: now,
    };
    const entity = {
      id: "panel:entry-a",
      kind: "panel",
      source: { repoPath: "panels/target", effectiveVersion: "ev-target" },
      contextId: "ctx-target",
      key: "entry-a",
      createdAt: now,
      status: "active",
      cleanupComplete: false,
      activeBuildKey: "b".repeat(64),
      activeExecutionDigest: "e".repeat(64),
      activeAuthority: { requests: [] },
    };
    const dispatch = vi.fn(async (_ctx, service: string, method: string, args: unknown[]) => {
      if (service === "workspace-state" && method === "slot.list") return [slot];
      if (service === "workspace-state" && method === "slot.get")
        return args[0] === "panel:tree/slot-a" ? slot : null;
      if (service === "workspace-state" && method === "slot.history") return [history];
      if (
        service === "workspace-state" &&
        (method === "entity.resolveActive" || method === "entity.resolve")
      )
        return entity;
      if (service === "workspace-state" && method === "panel.search") return [];
      if (service === "build" && method === "getPanelMetadata") return { title: "Target" };
      if (service === "presence" && method === "markPanelActive") return undefined;
      throw new Error(`Unexpected dispatch: ${service}.${method}`);
    });
    const cdpBridge = {
      isProviderConnected: vi.fn(() => true),
      isTargetRegisteredForHost: vi.fn(() => true),
      sendHostCommand: vi.fn(async (_panelId: string, action: string) =>
        action === "panelObservation"
          ? {
              view: { exists: true, url: "http://localhost/panels/target", loading: false },
              boot: readyBoot("panel:entry-a", "b".repeat(64)),
            }
          : undefined
      ),
    };
    const unloadSlot = vi.fn();
    const bridge = await createServerPanelTreeBridge({
      container: { get: vi.fn(() => cdpBridge) },
      dispatcher: { dispatch },
      workspace: {},
      workspacePath: "/tmp/workspace",
      workspaceConfig: {},
      adminToken: "admin-token",
      hostConfig: { gatewayPort: 0, externalHost: "localhost", protocol: "http" },
      isIpcMode: false,
      panelRuntimeCoordinator: {
        resolveHostForSlot: vi.fn(() => ({ hostConnectionId: "desktop-host", supportsCdp: true })),
        unloadSlot,
      },
      eventService: { emit: vi.fn() },
    } as never);

    await expect(
      bridge({
        callerId: "panel:requester",
        callerKind: "panel",
        method: "reload",
        args: ["panel:tree/slot-a"],
      })
    ).resolves.toMatchObject({
      panelId: "panel:tree/slot-a",
      phase: "ready",
    });

    expect(unloadSlot).not.toHaveBeenCalled();
    expect(cdpBridge.sendHostCommand).toHaveBeenCalledWith("panel:tree/slot-a", "reloadPanel", []);
  });

  it("transactionally rebuilds into a new immutable attempt without unloading leases", async () => {
    const now = Date.now();
    const slot = {
      slot_id: "panel:tree/slot-a",
      parent_slot_id: null,
      current_entity_id: "panel:entry-a",
      current_entity_title: "Target",
      current_entry_key: "entry-a",
      position_id: "root",
      created_at: now,
      closed_at: null,
    };
    const history = {
      slot_id: "panel:tree/slot-a",
      cursor: 0,
      entry_key: "entry-a",
      entity_id: "panel:entry-a",
      source: "panels/target",
      context_id: "ctx-target",
      state_args: null,
      recorded_at: now,
    };
    let entity = {
      id: "panel:entry-a",
      kind: "panel",
      source: { repoPath: "panels/target", effectiveVersion: "ev-target" },
      contextId: "ctx-target",
      key: "entry-a",
      createdAt: now,
      status: "active",
      cleanupComplete: false,
      activeBuildKey: "b".repeat(64),
      activeExecutionDigest: "e".repeat(64),
      activeAuthority: { requests: [] },
    };
    const dispatch = vi.fn(async (_ctx, service: string, method: string, args: unknown[]) => {
      if (service === "workspace-state" && method === "slot.list") return [slot];
      if (service === "workspace-state" && method === "slot.get")
        return args[0] === "panel:tree/slot-a" ? slot : null;
      if (service === "workspace-state" && method === "slot.history") return [history];
      if (
        service === "workspace-state" &&
        (method === "entity.resolveActive" || method === "entity.resolve")
      )
        return entity;
      if (service === "workspace-state" && method === "panel.search") return [];
      if (service === "build" && method === "getPanelMetadata") return { title: "Target" };
      if (service === "presence" && method === "markPanelActive") return undefined;
      if (service === "runtime" && method === "createEntity") {
        const spec = args[0] as { key: string; source: string; contextId: string };
        entity = {
          ...entity,
          id: "panel:nav-entry-rebuilt",
          key: spec.key,
          source: { repoPath: spec.source, effectiveVersion: "ev-rebuilt" },
          contextId: spec.contextId,
          activeBuildKey: "c".repeat(64),
        };
        return {
          ...entity,
          targetId: entity.id,
          buildKey: entity.activeBuildKey,
          executionDigest: entity.activeExecutionDigest,
          authorityRequests: [],
        };
      }
      if (service === "workspace-state" && method === "slot.commitPreparedNavigation") {
        const input = args[0] as {
          mutation: { entry: { entityId: string; entryKey: string } };
        };
        const previousEntityId = slot.current_entity_id;
        slot.current_entity_id = input.mutation.entry.entityId;
        slot.current_entry_key = input.mutation.entry.entryKey;
        return {
          previousEntityId,
          currentEntityId: slot.current_entity_id,
          currentEntryKey: slot.current_entry_key,
          cursor: 0,
        };
      }
      if (service === "runtime" && method === "retireEntity") return undefined;
      throw new Error(`Unexpected dispatch: ${service}.${method}`);
    });
    const cdpBridge = {
      isProviderConnected: vi.fn(() => true),
      isTargetRegisteredForHost: vi.fn(() => true),
      sendHostCommand: vi.fn(async (_panelId: string, action: string) =>
        action === "panelObservation"
          ? {
              view: { exists: true, url: "http://localhost/panels/target", loading: false },
              boot: readyBoot("panel:nav-entry-rebuilt", "c".repeat(64)),
            }
          : undefined
      ),
    };
    const unloadSlot = vi.fn();
    const replaceRuntimeEntityForSlot = vi.fn();
    const bridge = await createServerPanelTreeBridge({
      container: { get: vi.fn(() => cdpBridge) },
      dispatcher: { dispatch },
      workspace: {},
      workspacePath: "/tmp/workspace",
      workspaceConfig: {},
      adminToken: "admin-token",
      hostConfig: { gatewayPort: 0, externalHost: "localhost", protocol: "http" },
      isIpcMode: false,
      panelRuntimeCoordinator: {
        resolveHostForSlot: vi.fn(() => ({ hostConnectionId: "desktop-host", supportsCdp: true })),
        ensureDefaultCdpHostForSlot: vi.fn(() => ({
          assigned: true,
          lease: { holderLabel: "Desktop" },
        })),
        replaceRuntimeEntityForSlot,
        unloadSlot,
      },
      eventService: { emit: vi.fn() },
    } as never);

    await expect(
      bridge({
        callerId: "panel:requester",
        callerKind: "panel",
        method: "rebuildPanel",
        args: ["panel:tree/slot-a"],
      })
    ).resolves.toMatchObject({
      panelId: "panel:tree/slot-a",
      runtimeEntityId: "panel:nav-entry-rebuilt",
      buildKey: "c".repeat(64),
      phase: "ready",
    });

    expect(unloadSlot).not.toHaveBeenCalled();
    expect(replaceRuntimeEntityForSlot).toHaveBeenCalledWith(
      "panel:tree/slot-a",
      "panel:entry-a",
      "panel:nav-entry-rebuilt"
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-state",
      "slot.commitPreparedNavigation",
      [expect.objectContaining({ mutation: expect.objectContaining({ kind: "replace" }) })]
    );
  });

  it("recovers an unavailable CDP host lease before reloading", async () => {
    const now = Date.now();
    const slot = {
      slot_id: "panel:tree/slot-a",
      parent_slot_id: null,
      current_entity_id: "panel:entry-a",
      current_entity_title: "Target",
      current_entry_key: "entry-a",
      position_id: "root",
      created_at: now,
      closed_at: null,
    };
    const history = {
      slot_id: "panel:tree/slot-a",
      cursor: 0,
      entry_key: "entry-a",
      entity_id: "panel:entry-a",
      source: "panels/target",
      context_id: "ctx-target",
      state_args: null,
      recorded_at: now,
    };
    const entity = {
      id: "panel:entry-a",
      kind: "panel",
      source: { repoPath: "panels/target", effectiveVersion: "ev-target" },
      contextId: "ctx-target",
      key: "entry-a",
      createdAt: now,
      status: "active",
      cleanupComplete: false,
      activeBuildKey: "b".repeat(64),
      activeExecutionDigest: "e".repeat(64),
      activeAuthority: { requests: [] },
    };
    const dispatch = vi.fn(async (_ctx, service: string, method: string, args: unknown[]) => {
      if (service === "workspace-state" && method === "slot.list") return [slot];
      if (service === "workspace-state" && method === "slot.get")
        return args[0] === "panel:tree/slot-a" ? slot : null;
      if (service === "workspace-state" && method === "slot.history") return [history];
      if (
        service === "workspace-state" &&
        (method === "entity.resolveActive" || method === "entity.resolve")
      )
        return entity;
      if (service === "workspace-state" && method === "panel.search") return [];
      if (service === "build" && method === "getPanelMetadata") return { title: "Target" };
      if (service === "presence" && method === "markPanelActive") return undefined;
      throw new Error(`Unexpected dispatch: ${service}.${method}`);
    });
    const cdpBridge = {
      isProviderConnected: vi.fn((hostConnectionId: string) => hostConnectionId === "desktop-new"),
      isTargetRegisteredForHost: vi.fn(
        (_panelId: string, hostConnectionId: string) => hostConnectionId === "desktop-new"
      ),
      sendHostCommand: vi.fn(async (_panelId: string, action: string) =>
        action === "panelObservation"
          ? {
              view: { exists: true, url: "http://localhost/panels/target", loading: false },
              boot: readyBoot("panel:entry-a", "b".repeat(64)),
            }
          : undefined
      ),
    };
    const resolveHostForSlot = vi
      .fn()
      .mockReturnValueOnce({ hostConnectionId: "desktop-old", supportsCdp: true })
      .mockReturnValue({ hostConnectionId: "desktop-new", supportsCdp: true });
    const ensureDefaultCdpHostForSlot = vi.fn(() => ({
      assigned: true,
      lease: { hostConnectionId: "desktop-new", supportsCdp: true },
    }));
    const bridge = await createServerPanelTreeBridge({
      container: { get: vi.fn(() => cdpBridge) },
      dispatcher: { dispatch },
      workspace: {},
      workspacePath: "/tmp/workspace",
      workspaceConfig: {},
      adminToken: "admin-token",
      hostConfig: { gatewayPort: 0, externalHost: "localhost", protocol: "http" },
      isIpcMode: false,
      panelRuntimeCoordinator: {
        resolveHostForSlot,
        ensureDefaultCdpHostForSlot,
      },
      eventService: { emit: vi.fn() },
    } as never);

    await expect(
      bridge({
        callerId: "panel:requester",
        callerKind: "panel",
        method: "reload",
        args: ["panel:tree/slot-a"],
      })
    ).resolves.toMatchObject({ phase: "ready" });

    expect(ensureDefaultCdpHostForSlot).toHaveBeenCalledWith(
      "panel:tree/slot-a",
      "panel:entry-a",
      expect.objectContaining({
        replaceUnavailableLease: true,
        isHostAvailable: expect.any(Function),
      })
    );
    expect(cdpBridge.sendHostCommand).toHaveBeenCalledWith("panel:tree/slot-a", "reloadPanel", []);
  });
});

describe("createServerPanelTreeBridge create (root, no wipe)", () => {
  it("commits a root immediately and prepares its exact renderer attempt asynchronously", async () => {
    // Stateful WorkspaceDO mock: slots/history/entities.
    const slots = new Map<string, Record<string, unknown>>();
    const histories = new Map<string, unknown[]>();
    const entities = new Map<string, Record<string, unknown>>();
    let entityCounter = 0;
    let releaseActivation!: () => void;
    const activationGate = new Promise<void>((resolve) => {
      releaseActivation = resolve;
    });

    // Seed an existing root panel so we can prove a new root doesn't replace it.
    slots.set("slot-existing", {
      slot_id: "slot-existing",
      parent_slot_id: null,
      current_entity_id: "panel:existing",
      current_entity_title: "Existing",
      current_entry_key: "entry-existing",
      position_id: "root",
      created_at: 1,
      closed_at: null,
    });
    histories.set("slot-existing", [
      {
        slot_id: "slot-existing",
        cursor: 0,
        entry_key: "entry-existing",
        entity_id: "panel:existing",
        source: "panels/existing",
        context_id: "ctx-existing",
        state_args: null,
        recorded_at: 1,
      },
    ]);
    entities.set("panel:existing", {
      id: "panel:existing",
      kind: "panel",
      source: { repoPath: "panels/existing", effectiveVersion: "ev" },
      contextId: "ctx-existing",
      key: "entry-existing",
      createdAt: 1,
      status: "active",
      cleanupComplete: false,
    });

    const dispatch = vi.fn(async (_ctx, service: string, method: string, args: unknown[]) => {
      if (service === "workspace-state") {
        switch (method) {
          case "slot.list":
            return [...slots.values()].filter((s) => s["closed_at"] == null);
          case "slot.get":
            return slots.get(args[0] as string) ?? null;
          case "slot.history":
            return histories.get(args[0] as string) ?? [];
          case "entity.resolveActive":
          case "entity.resolve":
            return entities.get(args[0] as string) ?? null;
          case "slot.resolveByEntity": {
            // Durable nav→slot: the open slot whose current entity matches, or null.
            const entityId = args[0] as string;
            for (const s of slots.values()) {
              if (s["current_entity_id"] === entityId && s["closed_at"] == null)
                return s["slot_id"];
            }
            return null;
          }
          case "panel.search":
            return [];
          case "panel.index":
            return null;
          case "slot.create": {
            const input = args[0] as {
              slotId: string;
              parentSlotId: string | null;
              positionId: string;
              initialEntry: {
                entryKey: string;
                entityId: string;
                source: string;
                contextId: string;
                stateArgs?: unknown;
              };
            };
            slots.set(input.slotId, {
              slot_id: input.slotId,
              parent_slot_id: input.parentSlotId ?? null,
              current_entity_id: input.initialEntry.entityId,
              current_entity_title: null,
              current_entry_key: input.initialEntry.entryKey,
              position_id: input.positionId,
              created_at: 2,
              closed_at: null,
            });
            histories.set(input.slotId, [
              {
                slot_id: input.slotId,
                cursor: 0,
                entry_key: input.initialEntry.entryKey,
                entity_id: input.initialEntry.entityId,
                source: input.initialEntry.source,
                context_id: input.initialEntry.contextId,
                state_args: input.initialEntry.stateArgs ?? null,
                recorded_at: 2,
              },
            ]);
            return;
          }
        }
      }
      if (service === "runtime" && method === "reservePanelEntity") {
        const spec = args[0] as { source: string; contextId?: string; key: string };
        const id = `panel:nav-new-${++entityCounter}`;
        const contextId = spec.contextId ?? `ctx-created-${entityCounter}`;
        const record = {
          id,
          kind: "panel",
          source: { repoPath: spec.source, effectiveVersion: "" },
          contextId,
          key: spec.key,
          createdAt: 2,
          status: "preparing",
          cleanupComplete: false,
        };
        entities.set(id, record);
        return {
          id,
          kind: "panel",
          source: record.source,
          contextId,
          targetId: id,
        };
      }
      if (service === "runtime" && method === "activatePanelEntity") {
        const spec = args[0] as { source: string; contextId: string; key: string };
        const record = [...entities.values()].find((candidate) => candidate["key"] === spec.key);
        if (!record) throw new Error("missing reserved panel");
        await activationGate;
        record["status"] = "active";
        record["source"] = { repoPath: spec.source, effectiveVersion: "ev" };
        record["activeBuildKey"] = "b".repeat(64);
        record["activeExecutionDigest"] = "e".repeat(64);
        record["activeAuthority"] = { requests: [] };
        return {
          id: record["id"],
          kind: "panel",
          source: record["source"],
          buildKey: record["activeBuildKey"],
          executionDigest: record["activeExecutionDigest"],
          authorityRequests: [],
          contextId: record["contextId"],
          targetId: record["id"],
        };
      }
      if (service === "build" && method === "getPanelMetadata") return { title: "Created" };
      if (service === "presence" && method === "markPanelActive") return undefined;
      if (service === "auth" && method === "grantConnection") return { token: "t" };
      throw new Error(`Unexpected dispatch: ${service}.${method}`);
    });

    const eventService = { emit: vi.fn() };
    const ensureDefaultCdpHostForSlot = vi.fn(() => ({
      assigned: true,
      lease: { holderLabel: "Desktop" },
    }));
    let targetReady = false;
    const cdpBridge = {
      isProviderConnected: vi.fn(() => true),
      isTargetRegisteredForHost: vi.fn(() => targetReady),
      isTargetRegistered: vi.fn(() => targetReady),
      sendHostCommand: vi.fn(async (_panelId: string, action: string) => {
        if (action !== "panelObservation") return undefined;
        const active = [...entities.values()].find(
          (record) =>
            (record["source"] as { repoPath?: string } | undefined)?.repoPath === "panels/new"
        )!;
        return {
          view: { exists: true, url: "http://localhost/panels/new", loading: false },
          boot: readyBoot(
            String(active["id"]),
            String(active["activeBuildKey"]),
            "panels/new",
            String(active["contextId"])
          ),
        };
      }),
    };
    const bridge = await createServerPanelTreeBridge({
      container: { get: vi.fn(() => cdpBridge) },
      dispatcher: { dispatch },
      workspace: {},
      workspacePath: "/tmp/workspace",
      workspaceConfig: {},
      adminToken: "admin-token",
      hostConfig: { gatewayPort: 0, externalHost: "localhost", protocol: "http" },
      isIpcMode: false,
      panelRuntimeCoordinator: {
        resolveHostForSlot: vi.fn(() => ({
          hostConnectionId: "desktop-host",
          supportsCdp: true,
        })),
        getLease: vi.fn(() => null),
        ensureDefaultCdpHostForSlot,
      },
      eventService,
      getGatewayPort: () => 0,
    } as never);

    // Slot creation settles independently of runtime activation/boot.
    const createPromise = bridge({
      callerId: "server",
      callerKind: "server",
      method: "create",
      args: ["panels/new", { focus: true }],
    });
    const rootResult = await createPromise;
    expect(rootResult).toMatchObject({
      parentId: null,
      contextId: expect.any(String),
      source: "panels/new",
      observation: { phase: "building" },
    });
    expect(ensureDefaultCdpHostForSlot).not.toHaveBeenCalled();

    releaseActivation();
    targetReady = true;
    await vi.waitFor(() => expect(ensureDefaultCdpHostForSlot).toHaveBeenCalled());

    // The broadcast tree must contain BOTH roots — the new root must not have
    // wiped the pre-existing one (the addAsRoot fix).
    const treeEmits = eventService.emit.mock.calls.filter((c) => c[0] === "panel-tree-updated");
    const lastTree = treeEmits.at(-1)?.[1] as {
      forest: Array<{ rootPanels: Array<{ id: string }> }>;
    };
    const roots = lastTree.forest.flatMap((group) => group.rootPanels);
    expect(roots).toHaveLength(2);
    expect(roots.map((p) => p.id)).toContain("slot-existing");
  });

  it("returns the resolved owning slot parent when a panel entity creates a child", async () => {
    const parentSlotId = "panel:tree/slot-existing";
    const parentEntityId = "panel:existing";
    const slots = new Map<string, Record<string, unknown>>();
    const histories = new Map<string, unknown[]>();
    const entities = new Map<string, Record<string, unknown>>();

    slots.set(parentSlotId, {
      slot_id: parentSlotId,
      parent_slot_id: null,
      current_entity_id: parentEntityId,
      current_entity_title: "Existing",
      current_entry_key: "entry-existing",
      position_id: "root",
      created_at: 1,
      closed_at: null,
    });
    histories.set(parentSlotId, [
      {
        slot_id: parentSlotId,
        cursor: 0,
        entry_key: "entry-existing",
        entity_id: parentEntityId,
        source: "panels/existing",
        context_id: "ctx-existing",
        state_args: null,
        recorded_at: 1,
      },
    ]);
    entities.set(parentEntityId, {
      id: parentEntityId,
      kind: "panel",
      source: { repoPath: "panels/existing", effectiveVersion: "ev-existing" },
      contextId: "ctx-existing",
      key: "entry-existing",
      createdAt: 1,
      status: "active",
      cleanupComplete: false,
    });

    let entityCounter = 0;
    const dispatch = vi.fn(
      async (ctx: ServiceContext, service: string, method: string, args: unknown[]) => {
        if (service === "workspace-state") {
          switch (method) {
            case "slot.list":
              return [...slots.values()].filter((s) => s["closed_at"] == null);
            case "slot.get":
              return slots.get(args[0] as string) ?? null;
            case "slot.history":
              return histories.get(args[0] as string) ?? [];
            case "entity.resolveActive":
            case "entity.resolve":
              return entities.get(args[0] as string) ?? null;
            case "slot.resolveByEntity": {
              const entityId = args[0] as string;
              for (const s of slots.values()) {
                if (s["current_entity_id"] === entityId && s["closed_at"] == null)
                  return s["slot_id"];
              }
              return null;
            }
            case "panel.search":
              return [];
            case "panel.index":
              return null;
            case "slot.create": {
              const input = args[0] as {
                slotId: string;
                parentSlotId: string | null;
                positionId: string;
                initialEntry: {
                  entryKey: string;
                  entityId: string;
                  source: string;
                  contextId: string;
                  stateArgs?: unknown;
                };
              };
              slots.set(input.slotId, {
                slot_id: input.slotId,
                parent_slot_id: input.parentSlotId ?? null,
                current_entity_id: input.initialEntry.entityId,
                current_entity_title: null,
                current_entry_key: input.initialEntry.entryKey,
                position_id: input.positionId,
                created_at: 2,
                closed_at: null,
              });
              histories.set(input.slotId, [
                {
                  slot_id: input.slotId,
                  cursor: 0,
                  entry_key: input.initialEntry.entryKey,
                  entity_id: input.initialEntry.entityId,
                  source: input.initialEntry.source,
                  context_id: input.initialEntry.contextId,
                  state_args: input.initialEntry.stateArgs ?? null,
                  recorded_at: 2,
                },
              ]);
              return;
            }
          }
        }
        if (service === "runtime" && method === "reservePanelEntity") {
          const spec = args[0] as { source: string; contextId?: string; key: string };
          const id = `panel:nav-new-${++entityCounter}`;
          const contextId = spec.contextId ?? `ctx-created-${entityCounter}`;
          const record = {
            id,
            kind: "panel",
            source: { repoPath: spec.source, effectiveVersion: "" },
            contextId,
            key: spec.key,
            parentId: ctx.caller.runtime.id,
            ownerUserId: ctx.caller.subject?.userId,
            createdAt: 2,
            status: "preparing",
            cleanupComplete: false,
          };
          entities.set(id, record);
          return {
            id,
            kind: "panel",
            source: record.source,
            contextId,
            targetId: id,
          };
        }
        if (service === "runtime" && method === "activatePanelEntity") {
          const spec = args[0] as { source: string; contextId: string; key: string };
          const record = [...entities.values()].find((candidate) => candidate["key"] === spec.key);
          if (!record) throw new Error("missing reserved panel");
          record["status"] = "active";
          record["source"] = { repoPath: spec.source, effectiveVersion: "ev-child" };
          record["activeBuildKey"] = "b".repeat(64);
          record["activeExecutionDigest"] = "e".repeat(64);
          record["activeAuthority"] = { requests: [] };
          return {
            id: record["id"],
            kind: "panel",
            source: record["source"],
            buildKey: record["activeBuildKey"],
            executionDigest: record["activeExecutionDigest"],
            authorityRequests: [],
            contextId: record["contextId"],
            targetId: record["id"],
          };
        }
        if (service === "build" && method === "getPanelMetadata") return { title: "Child" };
        if (service === "presence" && method === "markPanelActive") return undefined;
        if (service === "auth" && method === "grantConnection") return { token: "t" };
        throw new Error(`Unexpected dispatch: ${service}.${method}`);
      }
    );

    const cdpBridge = {
      isProviderConnected: vi.fn(() => true),
      isTargetRegisteredForHost: vi.fn(() => true),
      isTargetRegistered: vi.fn(() => true),
      sendHostCommand: vi.fn(async (_panelId: string, action: string) =>
        action === "panelObservation"
          ? (() => {
              const active = [...entities.values()].find(
                (record) =>
                  (record["source"] as { repoPath?: string } | undefined)?.repoPath ===
                  "panels/child"
              )!;
              return {
                view: { exists: true, url: "http://localhost/panels/child", loading: false },
                boot: readyBoot(
                  String(active["id"]),
                  String(active["activeBuildKey"]),
                  "panels/child",
                  String(active["contextId"])
                ),
              };
            })()
          : undefined
      ),
    };
    const bridge = await createServerPanelTreeBridge({
      container: { get: vi.fn(() => cdpBridge) },
      dispatcher: { dispatch },
      workspace: {},
      workspacePath: "/tmp/workspace",
      workspaceConfig: {},
      adminToken: "admin-token",
      hostConfig: { gatewayPort: 0, externalHost: "localhost", protocol: "http" },
      isIpcMode: false,
      panelRuntimeCoordinator: {
        resolveHostForSlot: vi.fn(() => ({
          hostConnectionId: "desktop-host",
          supportsCdp: true,
        })),
        getLease: vi.fn(() => null),
        ensureDefaultCdpHostForSlot: vi.fn(() => ({
          assigned: true,
          lease: { holderLabel: "Desktop" },
        })),
      },
      eventService: { emit: vi.fn() },
      getGatewayPort: () => 0,
    } as never);

    const result = await bridge({
      callerId: parentEntityId,
      callerKind: "panel",
      subject: { userId: "usr_alice", handle: "alice" },
      method: "create",
      args: ["panels/child", {}],
    });

    expect(result).toMatchObject({
      parentId: parentSlotId,
      contextId: expect.any(String),
      source: "panels/child",
      runtimeEntityId: expect.stringMatching(/^panel:nav-new-/),
    });
    const createdEntity = entities.get((result as { runtimeEntityId: string }).runtimeEntityId);
    expect(createdEntity).toMatchObject({
      parentId: parentEntityId,
      ownerUserId: "usr_alice",
    });
    const runtimeCreate = dispatch.mock.calls.find(
      ([, service, method]) => service === "runtime" && method === "reservePanelEntity"
    );
    expect(runtimeCreate?.[0].caller).toMatchObject({
      runtime: { id: parentEntityId, kind: "server" },
      subject: { userId: "usr_alice", handle: "alice" },
    });
    const slotCreate = dispatch.mock.calls.find(
      ([, service, method]) => service === "workspace-state" && method === "slot.create"
    );
    expect(slotCreate?.[0].caller).toMatchObject({
      runtime: { id: parentEntityId, kind: "server" },
      subject: { userId: "usr_alice", handle: "alice" },
      hostOriginated: true,
    });
  });
});

describe("createServerPanelTreeBridge self-heal", () => {
  it("forces a fresh authoritative read for startup tree snapshots after an early empty sync", async () => {
    const now = Date.now();
    const slot = {
      slot_id: "panel:tree/slot-a",
      parent_slot_id: null,
      current_entity_id: "panel:entry-a",
      current_entity_title: "Target",
      current_entry_key: "entry-a",
      position_id: "root",
      created_at: now,
      closed_at: null,
    };
    const history = {
      slot_id: "panel:tree/slot-a",
      cursor: 0,
      entry_key: "entry-a",
      entity_id: "panel:entry-a",
      source: "panels/target",
      context_id: "ctx-target",
      state_args: null,
      recorded_at: now,
    };
    const entity = {
      id: "panel:entry-a",
      kind: "panel",
      source: { repoPath: "panels/target", effectiveVersion: "ev-target" },
      contextId: "ctx-target",
      key: "entry-a",
      createdAt: now,
      status: "active",
      cleanupComplete: false,
    };
    let slotListCalls = 0;
    const dispatch = vi.fn(async (_ctx, service: string, method: string, args: unknown[]) => {
      if (service === "workspace-state" && method === "slot.list") {
        slotListCalls += 1;
        return slotListCalls === 1 ? [] : [slot];
      }
      if (service === "workspace-state" && method === "slot.get")
        return args[0] === "panel:tree/slot-a" ? slot : null;
      if (service === "workspace-state" && method === "slot.history") return [history];
      if (
        service === "workspace-state" &&
        (method === "entity.resolveActive" || method === "entity.resolve")
      )
        return entity;
      if (service === "workspace-state" && method === "panel.search") return [];
      if (service === "build" && method === "getPanelMetadata") return { title: "Target" };
      if (service === "presence" && method === "markPanelActive") return undefined;
      throw new Error(`Unexpected dispatch: ${service}.${method}`);
    });
    const bridge = await createServerPanelTreeBridge({
      container: { get: vi.fn(() => ({})) },
      dispatcher: { dispatch },
      workspace: {},
      workspacePath: "/tmp/workspace",
      workspaceConfig: {},
      adminToken: "admin-token",
      hostConfig: { gatewayPort: 0, externalHost: "localhost", protocol: "http" },
      isIpcMode: false,
      panelRuntimeCoordinator: { resolveHostForSlot: vi.fn(() => null) },
      eventService: { emit: vi.fn() },
    } as never);

    await expect(
      bridge({ callerId: "server", callerKind: "server", method: "roots", args: [] })
    ).resolves.toEqual([]);

    const snapshot = (await bridge({
      callerId: "server",
      callerKind: "server",
      method: "getTreeSnapshot",
      args: [],
    })) as { forest: Array<{ rootPanels: Array<{ id: string }> }> };

    const roots = snapshot.forest.flatMap((group) => group.rootPanels);
    expect(roots).toEqual([expect.objectContaining({ id: "panel:tree/slot-a" })]);
    expect(slotListCalls).toBe(2);
  });

  it("re-syncs the mirror and re-broadcasts (debounced) when the slot tree changes", async () => {
    const now = Date.now();
    const slot = {
      slot_id: "panel:tree/slot-a",
      parent_slot_id: null,
      current_entity_id: "panel:entry-a",
      current_entity_title: "Target",
      current_entry_key: "entry-a",
      position_id: "root",
      created_at: now,
      closed_at: null,
    };
    const history = {
      slot_id: "panel:tree/slot-a",
      cursor: 0,
      entry_key: "entry-a",
      entity_id: "panel:entry-a",
      source: "panels/target",
      context_id: "ctx-target",
      state_args: null,
      recorded_at: now,
    };
    const entity = {
      id: "panel:entry-a",
      kind: "panel",
      source: { repoPath: "panels/target", effectiveVersion: "ev-target" },
      contextId: "ctx-target",
      key: "entry-a",
      createdAt: now,
      status: "active",
      cleanupComplete: false,
    };
    const dispatch = vi.fn(async (_ctx, service: string, method: string, args: unknown[]) => {
      if (service === "workspace-state" && method === "slot.list") return [slot];
      if (service === "workspace-state" && method === "slot.get")
        return args[0] === "panel:tree/slot-a" ? slot : null;
      if (service === "workspace-state" && method === "slot.history") return [history];
      if (
        service === "workspace-state" &&
        (method === "entity.resolveActive" || method === "entity.resolve")
      )
        return entity;
      if (service === "workspace-state" && method === "panel.search") return [];
      if (service === "build" && method === "getPanelMetadata") return { title: "Target" };
      if (service === "presence" && method === "markPanelActive") return undefined;
      throw new Error(`Unexpected dispatch: ${service}.${method}`);
    });
    const eventService = { emit: vi.fn() };
    let slotListener: (() => void) | undefined;
    await createServerPanelTreeBridge({
      container: { get: vi.fn(() => ({})) },
      dispatcher: { dispatch },
      workspace: {},
      workspacePath: "/tmp/workspace",
      workspaceConfig: {},
      adminToken: "admin-token",
      hostConfig: { gatewayPort: 0, externalHost: "localhost", protocol: "http" },
      isIpcMode: false,
      panelRuntimeCoordinator: { resolveHostForSlot: vi.fn(() => null) },
      eventService,
      registerSlotStateListener: (listener: () => void) => {
        slotListener = listener;
        return () => {};
      },
    } as never);

    expect(slotListener).toBeDefined();

    vi.useFakeTimers();
    try {
      // Several slot writes for one logical mutation — debounce should coalesce.
      slotListener?.();
      slotListener?.();
      slotListener?.();
      await vi.advanceTimersByTimeAsync(50);
    } finally {
      vi.useRealTimers();
    }

    // Forced re-sync read the authoritative tree …
    expect(dispatch).toHaveBeenCalledWith(
      expect.anything(),
      "workspace-state",
      "slot.list",
      expect.anything()
    );
    // … and re-broadcast exactly once (debounced).
    const treeEmits = eventService.emit.mock.calls.filter((c) => c[0] === "panel-tree-updated");
    expect(treeEmits).toHaveLength(1);
  });
});

describe("seedPanelTreeIfEmpty", () => {
  const makeBridge = (
    roots: Array<{ id?: string; panelId?: string; source?: string; owner?: string }>,
    stateArgsByRoot: Record<string, Record<string, unknown>> = {}
  ) => {
    const calls: PanelTreeBridgeRequest[] = [];
    const bridge = async (request: PanelTreeBridgeRequest): Promise<unknown> => {
      calls.push(request);
      if (request.method === "roots") return roots;
      if (request.method === "getStateArgs") return stateArgsByRoot[String(request.args[0])] ?? {};
      return { id: `panel:${request.args[0]}` };
    };
    return { bridge, calls };
  };

  it("seeds each init panel as the server when the tree is empty", async () => {
    const { bridge, calls } = makeBridge([]);
    await seedPanelTreeIfEmpty(
      bridge,
      [{ source: "panels/chat" }, { source: "panels/notes", stateArgs: { folder: "inbox" } }],
      { userId: "alice", handle: "alice" }
    );
    const creates = calls.filter((c) => c.method === "create");
    expect(creates).toHaveLength(2);
    expect(creates.every((c) => c.callerId === "server" && c.callerKind === "server")).toBe(true);
    expect(creates[0]?.args).toEqual(["panels/chat", { stateArgs: undefined }]);
    expect(creates[1]?.args).toEqual(["panels/notes", { stateArgs: { folder: "inbox" } }]);
  });

  it("seeds missing init panels when a previous seed only partially completed", async () => {
    const { bridge, calls } = makeBridge(
      [{ panelId: "panel:tree/chat", source: "panels/chat", owner: "alice" }],
      { "panel:tree/chat": {} }
    );
    await seedPanelTreeIfEmpty(
      bridge,
      [{ source: "panels/chat" }, { source: "panels/notes", stateArgs: { folder: "inbox" } }],
      { userId: "alice", handle: "alice" }
    );

    const creates = calls.filter((c) => c.method === "create");
    expect(creates).toHaveLength(1);
    expect(creates[0]?.args).toEqual(["panels/notes", { stateArgs: { folder: "inbox" } }]);
  });

  it("reconciles only the attaching owner's roots and stamps every create", async () => {
    const { bridge, calls } = makeBridge(
      [
        { panelId: "panel:alice/chat", source: "panels/chat", owner: "alice" },
        { panelId: "panel:bob/chat", source: "panels/chat", owner: "bob" },
      ],
      {
        "panel:alice/chat": {},
        "panel:bob/chat": {},
      }
    );

    await seedPanelTreeIfEmpty(bridge, [{ source: "panels/chat" }, { source: "panels/notes" }], {
      userId: "alice",
      handle: "alice",
    });

    const creates = calls.filter((call) => call.method === "create");
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({
      subject: { userId: "alice", handle: "alice" },
      args: ["panels/notes", { stateArgs: undefined }],
    });
  });

  it("seeds once per authenticated owner and never seeds system requests", async () => {
    const roots: Array<{ panelId: string; source: string; owner: string }> = [];
    const calls: PanelTreeBridgeRequest[] = [];
    const bridge = vi.fn(async (request: PanelTreeBridgeRequest): Promise<unknown> => {
      calls.push(request);
      if (request.method === "roots") return roots;
      if (request.method === "create") {
        roots.push({
          panelId: `panel:${request.subject?.userId}`,
          source: String(request.args[0]),
          owner: String(request.subject?.userId),
        });
        return { id: roots.at(-1)?.panelId };
      }
      return [];
    });
    const wrapped = createOwnerSeedingPanelTreeBridge(bridge, [{ source: "panels/chat" }]);

    await Promise.all([
      wrapped({
        callerId: "panel:a",
        callerKind: "panel",
        subject: { userId: "alice", handle: "alice" },
        method: "getTreeSnapshot",
        args: [],
      }),
      wrapped({
        callerId: "panel:b",
        callerKind: "panel",
        subject: { userId: "alice", handle: "alice" },
        method: "roots",
        args: [],
      }),
    ]);
    await wrapped({
      callerId: "server",
      callerKind: "server",
      subject: { userId: "system", handle: "system" },
      method: "roots",
      args: [],
    });

    expect(calls.filter((call) => call.method === "create")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "create")[0]?.subject?.userId).toBe("alice");
  });

  it("persists first attach so archiving every default does not reseed after restart", async () => {
    const seededOwners = new Set<string>();
    const seedStore = {
      isSeeded: vi.fn(async (ownerUserId: string) => seededOwners.has(ownerUserId)),
      markSeeded: vi.fn(async (ownerUserId: string) => {
        seededOwners.add(ownerUserId);
      }),
    };
    const bridge = vi.fn(async (request: PanelTreeBridgeRequest): Promise<unknown> => {
      if (request.method === "roots") return [];
      return {};
    });
    const request: PanelTreeBridgeRequest = {
      callerId: "shell:alice",
      callerKind: "shell",
      subject: { userId: "alice", handle: "alice" },
      method: "getTreeSnapshot",
      args: [],
    };

    await createOwnerSeedingPanelTreeBridge(
      bridge,
      [{ source: "panels/chat" }],
      seedStore
    )(request);
    expect(bridge.mock.calls.filter(([call]) => call.method === "create")).toHaveLength(1);
    expect(seedStore.markSeeded).toHaveBeenCalledWith("alice");

    bridge.mockClear();
    await createOwnerSeedingPanelTreeBridge(
      bridge,
      [{ source: "panels/chat" }],
      seedStore
    )(request);
    expect(bridge.mock.calls.map(([call]) => call.method)).toEqual(["getTreeSnapshot"]);
  });

  it("stores first-attach markers durably in workspace state", async () => {
    const statePath = await mkdtemp(join(tmpdir(), "vibestudio-owner-seed-"));
    try {
      const firstProcess = createOwnerPanelSeedStore(statePath);
      expect(await firstProcess.isSeeded("alice")).toBe(false);
      await firstProcess.markSeeded("alice");

      const restartedProcess = createOwnerPanelSeedStore(statePath);
      expect(await restartedProcess.isSeeded("alice")).toBe(true);
      expect(await restartedProcess.isSeeded("bob")).toBe(false);
      await expect(restartedProcess.markSeeded("alice")).resolves.toBeUndefined();
    } finally {
      await rm(statePath, { recursive: true, force: true });
    }
  });

  it("is a no-op when the owner's tree already has unrelated roots", async () => {
    const { bridge, calls } = makeBridge([
      { panelId: "panel:existing", source: "panels/custom", owner: "alice" },
    ]);
    await seedPanelTreeIfEmpty(bridge, [{ source: "panels/chat" }], {
      userId: "alice",
      handle: "alice",
    });
    expect(calls.filter((c) => c.method === "create")).toHaveLength(0);
  });

  it("does nothing when there are no init panels configured", async () => {
    const { bridge, calls } = makeBridge([]);
    await seedPanelTreeIfEmpty(bridge, [], { userId: "alice", handle: "alice" });
    expect(calls).toHaveLength(0); // no probe, no create
  });

  it("propagates bridge failures instead of starting with a silently empty tree", async () => {
    const bridge = async (): Promise<unknown> => {
      throw new Error("bridge down");
    };
    await expect(
      seedPanelTreeIfEmpty(bridge, [{ source: "panels/chat" }], {
        userId: "alice",
        handle: "alice",
      })
    ).rejects.toThrow("bridge down");
  });
});
