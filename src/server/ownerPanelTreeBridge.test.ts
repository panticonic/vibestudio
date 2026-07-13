import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOwnerPanelSeedStore,
  createOwnerSeedingPanelTreeBridge,
  createServerPanelTreeBridge,
  panelHostCommandAssignmentError,
  seedPanelTreeIfEmpty,
  snapshotBrowserPanelFromCdpBridge,
} from "./ownerPanelTreeBridge.js";
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
  const entity = {
    id: slot.current_entity_id,
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
    if (service === "workspace-state" && method === "slot.get") {
      return args[0] === slot.slot_id ? slot : null;
    }
    if (service === "workspace-state" && method === "slot.history") return [history];
    if (service === "workspace-state" && method === "entity.resolveActive") return entity;
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
    sendHostCommand: vi.fn(async (_panelId: string, action: string) =>
      action === "domSnapshot"
        ? { kind: "synth", text: "Target", structure: { role: "heading", name: "Target" } }
        : nodes
    ),
  };
  const callTarget = options?.callTarget ?? vi.fn(async () => ({ kind: "agent" }));
  const ensureDefaultCdpHostForSlot =
    options?.ensureDefaultCdpHostForSlot ??
    vi.fn(() => ({ assigned: true, lease: { holderLabel: "Desktop" } }));
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
    eventService: { emit: vi.fn() },
  } as never);
  return { bridge, callTarget, cdpBridge, ensureDefaultCdpHostForSlot, slot };
}

describe("createServerPanelTreeBridge ergonomic panel lifecycle", () => {
  it("loads a panel before reporting focus", async () => {
    const { bridge, ensureDefaultCdpHostForSlot, slot } = await createSinglePanelBridge();

    await expect(
      bridge({ callerId: "server", callerKind: "server", method: "focus", args: [slot.slot_id] })
    ).resolves.toMatchObject({
      panelId: slot.slot_id,
      status: "focused",
      focused: true,
      loaded: true,
    });
    expect(ensureDefaultCdpHostForSlot).toHaveBeenCalled();
  });

  it("uses the hosted DOM snapshot when a panel has no agent snapshot API", async () => {
    const callTarget = vi.fn(async () => {
      throw new Error("Target not reachable");
    });
    const { bridge, cdpBridge, slot } = await createSinglePanelBridge({ callTarget });

    await expect(
      bridge({ callerId: "server", callerKind: "server", method: "snapshot", args: [slot.slot_id] })
    ).resolves.toEqual({
      kind: "synth",
      text: "Target",
      structure: { role: "heading", name: "Target" },
    });
    expect(callTarget).toHaveBeenCalledWith(slot.current_entity_id, "_agent.snapshot");
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
    };
    const dispatch = vi.fn(async (_ctx, service: string, method: string, args: unknown[]) => {
      if (service === "workspace-state" && method === "slot.list") return [slot];
      if (service === "workspace-state" && method === "slot.get")
        return args[0] === "panel:tree/slot-a" ? slot : null;
      if (service === "workspace-state" && method === "slot.history") return [history];
      if (service === "workspace-state" && method === "entity.resolveActive") return entity;
      if (service === "workspace-state" && method === "panel.search") return [];
      if (service === "build" && method === "getPanelMetadata") return { title: "Target" };
      if (service === "presence" && method === "markPanelActive") return undefined;
      throw new Error(`Unexpected dispatch: ${service}.${method}`);
    });
    const cdpBridge = {
      isProviderConnected: vi.fn(() => true),
      isTargetRegisteredForHost: vi.fn(() => true),
      sendHostCommand: vi.fn(async () => ({
        panelId: "panel:tree/slot-a",
        operation: "reload",
        status: "reloaded",
        loaded: true,
        rebuilt: false,
        reloaded: true,
      })),
    };
    const unloadSlot = vi.fn();
    const bridge = await createServerPanelTreeBridge({
      container: { get: vi.fn(() => cdpBridge) },
      dispatcher: { dispatch },
      workspace: {},
      workspacePath: "/tmp/workspace",
      workspaceConfig: {},
      adminToken: "admin-token",
      workspaceCatalog: {} as never,
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
    ).resolves.toEqual({
      panelId: "panel:tree/slot-a",
      operation: "reload",
      status: "reloaded",
      loaded: true,
      rebuilt: false,
      reloaded: true,
    });

    expect(unloadSlot).not.toHaveBeenCalled();
    expect(cdpBridge.sendHostCommand).toHaveBeenCalledWith("panel:tree/slot-a", "reloadPanel", []);
  });

  it("delegates rebuild-and-reload to the active host without unloading leases", async () => {
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
      if (service === "workspace-state" && method === "entity.resolveActive") return entity;
      if (service === "workspace-state" && method === "panel.search") return [];
      if (service === "build" && method === "getPanelMetadata") return { title: "Target" };
      if (service === "presence" && method === "markPanelActive") return undefined;
      throw new Error(`Unexpected dispatch: ${service}.${method}`);
    });
    const hostResult = {
      panelId: "panel:tree/slot-a",
      operation: "rebuildAndReload",
      status: "rebuilt_and_reloaded",
      loaded: true,
      rebuilt: true,
      reloaded: true,
    };
    const cdpBridge = {
      isProviderConnected: vi.fn(() => true),
      isTargetRegisteredForHost: vi.fn(() => true),
      sendHostCommand: vi.fn(async () => hostResult),
    };
    const unloadSlot = vi.fn();
    const bridge = await createServerPanelTreeBridge({
      container: { get: vi.fn(() => cdpBridge) },
      dispatcher: { dispatch },
      workspace: {},
      workspacePath: "/tmp/workspace",
      workspaceConfig: {},
      adminToken: "admin-token",
      workspaceCatalog: {} as never,
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
        method: "rebuildAndReload",
        args: ["panel:tree/slot-a"],
      })
    ).resolves.toEqual(hostResult);

    expect(unloadSlot).not.toHaveBeenCalled();
    expect(cdpBridge.sendHostCommand).toHaveBeenCalledWith(
      "panel:tree/slot-a",
      "rebuildAndReload",
      []
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
    };
    const dispatch = vi.fn(async (_ctx, service: string, method: string, args: unknown[]) => {
      if (service === "workspace-state" && method === "slot.list") return [slot];
      if (service === "workspace-state" && method === "slot.get")
        return args[0] === "panel:tree/slot-a" ? slot : null;
      if (service === "workspace-state" && method === "slot.history") return [history];
      if (service === "workspace-state" && method === "entity.resolveActive") return entity;
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
      sendHostCommand: vi.fn(async () => ({
        panelId: "panel:tree/slot-a",
        operation: "reload",
        status: "reloaded",
        loaded: true,
        rebuilt: false,
        reloaded: true,
      })),
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
      workspaceCatalog: {} as never,
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
    ).resolves.toMatchObject({ status: "reloaded" });

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
  it("appends a new root panel without wiping existing roots", async () => {
    // Stateful WorkspaceDO mock: slots/history/entities.
    const slots = new Map<string, Record<string, unknown>>();
    const histories = new Map<string, unknown[]>();
    const entities = new Map<string, Record<string, unknown>>();
    let entityCounter = 0;

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
      if (service === "runtime" && method === "createEntity") {
        const spec = args[0] as { source: string; contextId: string; key: string };
        const id = `panel:nav-new-${++entityCounter}`;
        const record = {
          id,
          kind: "panel",
          source: { repoPath: spec.source, effectiveVersion: "ev" },
          contextId: spec.contextId,
          key: spec.key,
          createdAt: 2,
          status: "active",
          cleanupComplete: false,
        };
        entities.set(id, record);
        return {
          id,
          kind: "panel",
          source: record.source,
          contextId: spec.contextId,
          targetId: id,
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
    const bridge = await createServerPanelTreeBridge({
      container: { get: vi.fn(() => ({})) },
      dispatcher: { dispatch },
      workspace: {},
      workspacePath: "/tmp/workspace",
      workspaceConfig: {},
      adminToken: "admin-token",
      workspaceCatalog: {} as never,
      hostConfig: { gatewayPort: 0, externalHost: "localhost", protocol: "http" },
      isIpcMode: false,
      panelRuntimeCoordinator: {
        resolveHostForSlot: vi.fn(() => null),
        getLease: vi.fn(() => null),
        ensureDefaultCdpHostForSlot,
      },
      eventService,
      getGatewayPort: () => 0,
    } as never);

    // Create a NEW root panel (server caller ⇒ no implicit parent ⇒ root).
    const rootResult = await bridge({
      callerId: "server",
      callerKind: "server",
      method: "create",
      args: ["panels/new", { focus: true }],
    });
    expect(rootResult).toMatchObject({
      parentId: null,
      contextId: expect.any(String),
      source: "panels/new",
    });
    expect(ensureDefaultCdpHostForSlot).toHaveBeenCalled();

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
        if (service === "runtime" && method === "createEntity") {
          const spec = args[0] as { source: string; contextId: string; key: string };
          const id = `panel:nav-new-${++entityCounter}`;
          const record = {
            id,
            kind: "panel",
            source: { repoPath: spec.source, effectiveVersion: "ev-child" },
            contextId: spec.contextId,
            key: spec.key,
            parentId: ctx.caller.runtime.id,
            ownerUserId: ctx.caller.subject?.userId,
            createdAt: 2,
            status: "active",
            cleanupComplete: false,
          };
          entities.set(id, record);
          return {
            id,
            kind: "panel",
            source: record.source,
            contextId: spec.contextId,
            targetId: id,
          };
        }
        if (service === "build" && method === "getPanelMetadata") return { title: "Child" };
        if (service === "presence" && method === "markPanelActive") return undefined;
        if (service === "auth" && method === "grantConnection") return { token: "t" };
        throw new Error(`Unexpected dispatch: ${service}.${method}`);
      }
    );

    const bridge = await createServerPanelTreeBridge({
      container: { get: vi.fn(() => ({})) },
      dispatcher: { dispatch },
      workspace: {},
      workspacePath: "/tmp/workspace",
      workspaceConfig: {},
      adminToken: "admin-token",
      workspaceCatalog: {} as never,
      hostConfig: { gatewayPort: 0, externalHost: "localhost", protocol: "http" },
      isIpcMode: false,
      panelRuntimeCoordinator: {
        resolveHostForSlot: vi.fn(() => null),
        getLease: vi.fn(() => null),
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
      ([, service, method]) => service === "runtime" && method === "createEntity"
    );
    expect(runtimeCreate?.[0].caller).toMatchObject({
      runtime: { id: parentEntityId, kind: "server" },
      subject: { userId: "usr_alice", handle: "alice" },
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
      if (service === "workspace-state" && method === "entity.resolveActive") return entity;
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
      workspaceCatalog: {} as never,
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
      if (service === "workspace-state" && method === "entity.resolveActive") return entity;
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
      workspaceCatalog: {} as never,
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
