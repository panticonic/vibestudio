import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import { getCurrentSnapshot } from "@vibestudio/shared/panel/accessors";
import { PanelLifecycleAggregateError, PanelManager } from "./panelManager.js";
import { PanelNavigationCommitError } from "./panelNavigationTransaction.js";
import { canonicalEntityId, runtimeEntitySource } from "@vibestudio/shared/runtime/entitySpec";
import type { PanelEntityId, PanelSlotId } from "@vibestudio/shared/panel/ids";
import type { PanelSearchIndex } from "@vibestudio/shared/panelSearchTypes";
import type {
  EntityRecord,
  RuntimeEntityCreateSpec,
  RuntimeEntityHandle,
} from "@vibestudio/shared/runtime/entitySpec";
import type {
  RuntimeClient,
  SlotCommitPreparedNavigationInput,
  SlotCommitPreparedNavigationResult,
  SlotCreateInput,
  SlotHistoryRow,
  SlotRow,
  WorkspaceStateClient,
} from "./workspaceStateClient.js";

/**
 * Minimal in-memory simulator for the workspace-state and runtime services.
 * Tracks slots, slot_history, and entity rows just enough for the panel
 * manager's three-concept flow to round-trip locally.
 */
it("preserves every panel lifecycle failure without relying on AggregateError", () => {
  const failures = [new Error("primary"), new Error("cleanup")];
  const error = new PanelLifecycleAggregateError(failures, "panel lifecycle failed");

  expect(error).toMatchObject({
    name: "PanelLifecycleAggregateError",
    message: "panel lifecycle failed",
    errors: failures,
  });
});

function createWorkspaceMemory() {
  interface MemSlot {
    slot_id: PanelSlotId;
    parent_slot_id: PanelSlotId | null;
    sort_key: number;
    created_at: number;
    closed_at: number | null;
    current_entity_id: PanelEntityId | null;
    current_entry_key: string | null;
    owner_user_id: string | null;
  }
  interface MemHistoryEntry {
    entry_key: string;
    entity_id: PanelEntityId;
    source: string;
    context_id: string;
    state_args: string | null;
    options: string | null;
    recorded_at: number;
  }
  interface MemEntity {
    id: string;
    kind: "panel" | "app" | "worker" | "do" | "session";
    source: string;
    contextId: string;
    status: "preparing" | "active" | "retired";
    key: string;
    activeBuildKey: string;
    activeExecutionDigest: string;
    activeAuthority: { requests: []; provides: [] };
    displayTitle?: string | null;
  }

  const slots = new Map<PanelSlotId, MemSlot>();
  const history = new Map<PanelSlotId, MemHistoryEntry[]>();
  const entities = new Map<string, MemEntity>();
  const closeCleanup = new Map<
    PanelSlotId,
    {
      closeId: string;
      ownerUserId: string | null;
      slotId: PanelSlotId;
      entityId: PanelEntityId | null;
    }
  >();
  let revision = 0;

  const retired: string[] = [];
  const created: string[] = [];

  const stringifyStateArgs = (value: unknown): string | null => {
    if (value === undefined) return null;
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  };
  const slotRow = (slot: MemSlot): SlotRow => ({
    ...slot,
    current_entity_title: slot.current_entity_id
      ? (entities.get(slot.current_entity_id)?.displayTitle ?? null)
      : null,
  });
  const historyRows = (slotId: PanelSlotId): SlotHistoryRow[] =>
    (history.get(slotId) ?? []).map((row, cursor) => ({
      slot_id: slotId,
      cursor,
      entry_key: row.entry_key,
      entity_id: row.entity_id,
      source: row.source,
      context_id: row.context_id,
      state_args: row.state_args,
      options: row.options,
      recorded_at: row.recorded_at,
    }));
  const entityRecord = (entity: MemEntity): EntityRecord => ({
    id: entity.id,
    kind: entity.kind,
    source: {
      repoPath: entity.source,
      effectiveVersion: entity.status === "preparing" ? "" : "test",
    },
    contextId: entity.contextId,
    key: entity.key,
    ...(entity.activeBuildKey ? { activeBuildKey: entity.activeBuildKey } : {}),
    ...(entity.activeExecutionDigest
      ? { activeExecutionDigest: entity.activeExecutionDigest }
      : {}),
    ...(entity.status === "active" ? { activeAuthority: entity.activeAuthority } : {}),
    createdAt: Date.now(),
    status: entity.status,
    cleanupComplete: entity.status === "retired",
  });

  const workspaceState: WorkspaceStateClient & {
    commitPreparedNavigation(
      input: SlotCommitPreparedNavigationInput
    ): Promise<SlotCommitPreparedNavigationResult>;
  } = {
    async getPanelTreeRootGroups() {
      const owners = new Map<string | null, number>();
      for (const slot of slots.values()) {
        if (slot.closed_at === null && slot.parent_slot_id === null) {
          owners.set(slot.owner_user_id, (owners.get(slot.owner_user_id) ?? 0) + 1);
        }
      }
      return {
        revision,
        groups: [...owners].map(([ownerUserId, rootCount]) => ({ ownerUserId, rootCount })),
        nextCursor: null,
      };
    },
    async getPanelTreePage(input) {
      const limit = input.limit ?? 50;
      const cursor = input.cursor === undefined ? null : Number(input.cursor);
      const matching = [...slots.values()]
        .filter(
          (slot) =>
            slot.closed_at === null &&
            (cursor === null || slot.sort_key > cursor) &&
            (input.group.kind === "children"
              ? slot.parent_slot_id === input.group.parentSlotId
              : slot.parent_slot_id === null && slot.owner_user_id === input.group.ownerUserId)
        )
        .sort((a, b) => a.sort_key - b.sort_key);
      const visible = matching.slice(0, limit);
      const nodes = visible.map((slot) => ({
        slotId: slot.slot_id,
        parentSlotId: slot.parent_slot_id,
        ownerUserId: slot.owner_user_id,
        title: slotRow(slot).current_entity_title ?? slot.slot_id,
        source:
          historyRows(slot.slot_id).find((entry) => entry.entry_key === slot.current_entry_key)
            ?.source ?? "",
        createdAt: slot.created_at,
        childCount: [...slots.values()].filter(
          (child) => child.closed_at === null && child.parent_slot_id === slot.slot_id
        ).length,
      }));
      return {
        revision,
        group: input.group,
        nodes,
        nextCursor:
          matching.length > limit && visible.length > 0 ? String(visible.at(-1)!.sort_key) : null,
      };
    },
    async getPanelTreePath(slotId) {
      const path = [];
      let current = slots.get(slotId);
      while (current?.closed_at === null) {
        path.unshift({
          slotId: current.slot_id,
          parentSlotId: current.parent_slot_id,
          ownerUserId: current.owner_user_id,
          title: slotRow(current).current_entity_title ?? current.slot_id,
          createdAt: current.created_at,
          childCount: 0,
        });
        current = current.parent_slot_id ? slots.get(current.parent_slot_id) : undefined;
      }
      return path.length > 0 ? { revision, nodes: path } : null;
    },
    async getPanelDetail(slotId) {
      const slot = slots.get(slotId);
      const rows = historyRows(slotId);
      const currentHistory = rows.find((row) => row.entry_key === slot?.current_entry_key);
      const entity = slot?.current_entity_id ? entities.get(slot.current_entity_id) : undefined;
      return slot && currentHistory && entity
        ? { revision, slot: slotRow(slot), currentHistory, entity: entityRecord(entity) }
        : null;
    },
    async searchPanelTree() {
      return { revision, hits: [], nextCursor: null };
    },
    async getSlot(slotId): Promise<SlotRow | null> {
      const s = slots.get(slotId);
      return s ? slotRow(s) : null;
    },
    async getRelativeSlotHistory(slotId, delta): Promise<SlotHistoryRow | null> {
      const rows = historyRows(slotId);
      const slot = slots.get(slotId);
      const index = rows.findIndex((row) => row.entry_key === slot?.current_entry_key);
      return rows[index + delta] ?? null;
    },
    async resolveActiveEntity(id) {
      const e = entities.get(id);
      if (!e || e.status !== "active") return null;
      return entityRecord(e);
    },
    async resolveEntity(id) {
      const e = entities.get(id);
      if (!e) return null;
      return entityRecord(e);
    },
    async resolveSlotByEntity(entityId) {
      for (const s of slots.values()) {
        if (s.current_entity_id === entityId && s.closed_at == null) return s.slot_id;
      }
      return null;
    },
    async createSlot(input: SlotCreateInput) {
      slots.set(input.slotId, {
        slot_id: input.slotId,
        parent_slot_id: input.parentSlotId,
        sort_key: Math.min(0, ...[...slots.values()].map((slot) => slot.sort_key)) - 1,
        created_at: Date.now(),
        closed_at: null,
        current_entity_id: input.initialEntry?.entityId ?? null,
        current_entry_key: input.initialEntry?.entryKey ?? null,
        // The real server stamps this from its verified caller subject. This
        // in-memory transport has no authenticated subject.
        owner_user_id: null,
      });
      if (input.initialEntry) {
        history.set(input.slotId, [
          {
            entry_key: input.initialEntry.entryKey,
            entity_id: input.initialEntry.entityId,
            source: input.initialEntry.source,
            context_id: input.initialEntry.contextId,
            state_args: stringifyStateArgs(input.initialEntry.stateArgs),
            options: stringifyStateArgs(input.initialEntry.options),
            recorded_at: Date.now(),
          },
        ]);
      }
      revision += 1;
    },
    async commitPreparedNavigation(input) {
      const { slotId, expectedCurrentEntityId, mutation } = input;
      const slot = slots.get(slotId);
      const rows = history.get(slotId) ?? [];
      const nextRows = rows.slice();
      if (!slot || slot.current_entity_id !== expectedCurrentEntityId) {
        throw new Error(`Slot navigation conflict: ${slotId}`);
      }
      const previousEntityId = slot.current_entity_id;
      const currentCursor = rows.findIndex((row) => row.entry_key === slot.current_entry_key);
      if (currentCursor < 0) throw new Error(`Missing current history: ${slotId}`);
      let cursor: number;
      let row: MemHistoryEntry | undefined;
      if (mutation.kind === "select") {
        cursor = nextRows.findIndex((candidate) => candidate.entry_key === mutation.entryKey);
        row = nextRows[cursor];
      } else {
        const entry = mutation.entry;
        row = {
          entry_key: entry.entryKey,
          entity_id: entry.entityId,
          source: entry.source,
          context_id: entry.contextId,
          state_args: stringifyStateArgs(entry.stateArgs),
          options: stringifyStateArgs(entry.options),
          recorded_at: Date.now(),
        };
        if (mutation.kind === "append") {
          nextRows.splice(currentCursor + 1, nextRows.length, row);
          cursor = currentCursor + 1;
        } else {
          nextRows[currentCursor] = row;
          cursor = currentCursor;
        }
      }
      const entity = row && entities.get(row.entity_id);
      if (!row || !entity || entity.status !== "active") {
        throw new Error(`Prepared panel incarnation is not active and complete`);
      }
      slot.current_entity_id = row.entity_id;
      slot.current_entry_key = row.entry_key;
      history.set(slotId, nextRows);
      revision += 1;
      return {
        previousEntityId: previousEntityId as PanelEntityId,
        currentEntityId: row.entity_id,
        currentEntryKey: row.entry_key,
        cursor,
      };
    },
    async updateCurrentStateArgs(slotId, stateArgs) {
      const slot = slots.get(slotId);
      if (!slot?.current_entry_key) return;
      const rows = history.get(slotId) ?? [];
      const row = rows.find((r) => r.entry_key === slot.current_entry_key);
      if (row) row.state_args = stringifyStateArgs(stateArgs);
      revision += 1;
    },
    async moveSlot(slotId, parentSlotId) {
      const slot = slots.get(slotId);
      if (slot) {
        slot.parent_slot_id = parentSlotId;
      }
      revision += 1;
    },
    async closeSlot(slotId) {
      let closedCount = 0;
      const close = (id: PanelSlotId) => {
        for (const child of slots.values()) {
          if (child.closed_at === null && child.parent_slot_id === id) close(child.slot_id);
        }
        const slot = slots.get(id);
        if (!slot || slot.closed_at !== null) return;
        slot.closed_at = Date.now();
        closeCleanup.set(id, {
          closeId: slotId,
          ownerUserId: slot.owner_user_id,
          slotId: id,
          entityId: slot.current_entity_id,
        });
        closedCount += 1;
      };
      close(slotId);
      revision += 1;
      return { closeId: slotId, closedCount };
    },
    async getCloseCleanupPage(input) {
      const limit = input.limit ?? 200;
      const matching = [...closeCleanup.values()]
        .filter(
          (item) =>
            (!input.closeId || item.closeId === input.closeId) &&
            (!Object.prototype.hasOwnProperty.call(input, "ownerUserId") ||
              item.ownerUserId === input.ownerUserId) &&
            (!input.cursor || item.slotId > input.cursor)
        )
        .sort((a, b) => a.slotId.localeCompare(b.slotId));
      const items = matching.slice(0, limit);
      return {
        items: items.map(({ slotId, entityId }) => ({ slotId, entityId })),
        nextCursor: matching.length > limit && items.length > 0 ? items.at(-1)!.slotId : null,
      };
    },
    async acknowledgeCloseCleanup(slotIds) {
      for (const slotId of slotIds) closeCleanup.delete(slotId);
    },
  };

  const runtime: RuntimeClient = {
    async createEntity(spec: RuntimeEntityCreateSpec): Promise<RuntimeEntityHandle> {
      const key = spec.key ?? "auto-key";
      const id = canonicalEntityId({
        kind: spec.kind,
        source: runtimeEntitySource(spec),
        className: spec.kind === "do" ? spec.className : undefined,
        key,
      });
      const existing = entities.get(id);
      if (existing && existing.status === "retired") {
        existing.status = "active";
      } else if (!existing) {
        entities.set(id, {
          id,
          kind: spec.kind,
          source: runtimeEntitySource(spec),
          contextId: spec.contextId ?? "ctx-default",
          status: "active",
          key,
          activeBuildKey: "b".repeat(64),
          activeExecutionDigest: "a".repeat(64),
          activeAuthority: { requests: [], provides: [] },
        });
      }
      created.push(id);
      revision += 1;
      return {
        id,
        kind: spec.kind,
        source: { repoPath: runtimeEntitySource(spec), effectiveVersion: "test" },
        contextId: spec.contextId ?? "ctx-default",
        targetId: id,
        buildKey: "b".repeat(64),
        executionDigest: "a".repeat(64),
        authorityRequests: [],
      };
    },
    async reserveEntity(spec) {
      const key = spec.key ?? "auto-key";
      const id = canonicalEntityId({ kind: "panel", key });
      entities.set(id, {
        id,
        kind: "panel",
        source: spec.execution.source,
        contextId: spec.contextId ?? "ctx-default",
        status: "preparing",
        key,
        activeBuildKey: "",
        activeExecutionDigest: "",
        activeAuthority: { requests: [], provides: [] },
      });
      created.push(id);
      revision += 1;
      return {
        id,
        kind: "panel",
        source: { repoPath: spec.execution.source, effectiveVersion: "" },
        contextId: spec.contextId ?? "ctx-default",
        targetId: id,
      };
    },
    async activateReservedEntity(spec) {
      if (!spec.key) throw new Error("activateReservedEntity requires a reserved key");
      const id = canonicalEntityId({ kind: "panel", key: spec.key });
      const entity = entities.get(id);
      if (!entity || entity.status !== "preparing") {
        throw new Error(`Unknown preparing panel ${id}`);
      }
      entity.status = "active";
      entity.activeBuildKey = "b".repeat(64);
      entity.activeExecutionDigest = "a".repeat(64);
      revision += 1;
      return {
        id,
        kind: "panel",
        source: { repoPath: spec.execution.source, effectiveVersion: "test" },
        contextId: entity.contextId,
        targetId: id,
        buildKey: entity.activeBuildKey,
        executionDigest: entity.activeExecutionDigest,
        authorityRequests: [],
      };
    },
    async retireEntity(id) {
      retired.push(id);
      const e = entities.get(id);
      if (e) e.status = "retired";
      revision += 1;
    },
  };

  return {
    workspaceState,
    runtime,
    state: {
      slots,
      history,
      entities,
      retired,
      created,
      get revision() {
        return revision;
      },
    },
  };
}

function makeManagerDeps(workspacePath: string) {
  const mem = createWorkspaceMemory();
  return {
    mem,
    deps: {
      workspaceState: mem.workspaceState,
      runtime: mem.runtime,
      workspacePath,
      serverInfo: { gatewayConfig: { serverUrl: "http://127.0.0.1:42773" } },
      grantConnection: vi.fn(async (panelId: PanelEntityId) => ({ token: `rpc-${panelId}` })),
    } as const,
  };
}

describe("PanelManager", () => {
  it("queries durable roots by source without depending on the local registry mirror", async () => {
    const registry = new PanelRegistry({});
    const { mem, deps } = makeManagerDeps("/tmp/workspace");
    const manager = new PanelManager({ registry, ...deps, allowMissingManifests: true });
    await manager.create("panels/existing", { isRoot: true, addAsRoot: true });

    await expect(manager.hasRootPanelSource("panels/existing")).resolves.toBe(true);
    await expect(manager.hasRootPanelSource("panels/missing")).resolves.toBe(false);
    expect(mem.state.slots.size).toBe(1);
  });

  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates browser panels for disposable document URLs", async () => {
    const registry = new PanelRegistry({});
    const { mem, deps } = makeManagerDeps("/tmp/workspace");
    const manager = new PanelManager({
      registry,
      ...deps,
      allowMissingManifests: true,
    });

    const dataResult = await manager.createBrowser(
      null,
      "data:text/html,<button>Click me</button>",
      { addAsRoot: true }
    );
    const aboutResult = await manager.createBrowser(null, "about:blank", { addAsRoot: true });

    expect(dataResult).toMatchObject({
      source: "browser:data:text/html,<button>Click me</button>",
      title: "data",
      url: "data:text/html,<button>Click me</button>",
    });
    expect(aboutResult).toMatchObject({
      source: "browser:about:blank",
      title: "about",
      url: "about:blank",
    });
    expect(getCurrentSnapshot(registry.getPanel(dataResult.panelId)!).source).toBe(
      dataResult.source
    );
    expect(getCurrentSnapshot(registry.getPanel(aboutResult.panelId)!).source).toBe(
      aboutResult.source
    );
    expect(mem.state.slots.size).toBe(2);
  });

  it("does not finish browser creation before the panel is searchable", async () => {
    const registry = new PanelRegistry({});
    const { deps } = makeManagerDeps("/tmp/workspace");
    let releaseIndex!: () => void;
    const indexBlocked = new Promise<void>((resolve) => {
      releaseIndex = resolve;
    });
    const indexed = new Map<string, { title: string; path?: string }>();
    const indexPanel = vi.fn(async (panel: { id: string; title: string; path?: string }) => {
      await indexBlocked;
      indexed.set(panel.id, panel);
    });
    const searchIndex: PanelSearchIndex = {
      indexPanel,
      async search(query) {
        return [...indexed]
          .filter(([, panel]) => `${panel.title} ${panel.path ?? ""}`.includes(query))
          .map(([id, panel]) => ({ id, title: panel.title, relevance: 0, accessCount: 0 }));
      },
      incrementAccessCount: vi.fn(),
      updateTitle: vi.fn(),
      rebuildIndex: vi.fn(),
    };
    const manager = new PanelManager({
      registry,
      ...deps,
      searchIndex,
      allowMissingManifests: true,
    });

    let creationSettled = false;
    const creation = manager
      .createBrowser(null, "https://example.com/", { addAsRoot: true })
      .finally(() => {
        creationSettled = true;
      });
    await vi.waitFor(() => expect(indexPanel).toHaveBeenCalledOnce());
    expect(creationSettled).toBe(false);

    releaseIndex();
    const created = await creation;

    await expect(searchIndex.search("example.com", 10)).resolves.toEqual([
      expect.objectContaining({ id: created.panelId, title: "example.com" }),
    ]);
  });

  it("projects one root when concurrent first reads resolve together", async () => {
    const sourceRegistry = new PanelRegistry({});
    const { deps } = makeManagerDeps("/tmp/workspace");
    const sourceManager = new PanelManager({
      registry: sourceRegistry,
      ...deps,
      allowMissingManifests: true,
    });
    const created = await sourceManager.createBrowser(null, "about:blank", {
      addAsRoot: true,
    });

    const projectedRegistry = new PanelRegistry({});
    const projectedManager = new PanelManager({
      registry: projectedRegistry,
      ...deps,
      allowMissingManifests: true,
    });
    const originalGetPanelDetail = deps.workspaceState.getPanelDetail.bind(deps.workspaceState);
    let releaseReads!: () => void;
    const readsBlocked = new Promise<void>((resolve) => {
      releaseReads = resolve;
    });
    const detailRead = vi
      .spyOn(deps.workspaceState, "getPanelDetail")
      .mockImplementation(async (slotId) => {
        await readsBlocked;
        return originalGetPanelDetail(slotId);
      });

    const first = projectedManager.refreshPanel(created.panelId);
    const second = projectedManager.refreshPanel(created.panelId);
    await vi.waitFor(() => expect(detailRead).toHaveBeenCalledTimes(2));
    releaseReads();
    await Promise.all([first, second]);

    expect(projectedRegistry.getRootPanels().map((panel) => panel.id)).toEqual([created.panelId]);
  });

  it("uses the server-owned icon when refreshing native presentation", async () => {
    const sourceRegistry = new PanelRegistry({});
    const { deps } = makeManagerDeps("/tmp/workspace");
    const sourceManager = new PanelManager({
      registry: sourceRegistry,
      ...deps,
      allowMissingManifests: true,
    });
    const created = await sourceManager.createBrowser(null, "about:blank", { addAsRoot: true });
    const originalGetPanelDetail = deps.workspaceState.getPanelDetail.bind(deps.workspaceState);
    vi.spyOn(deps.workspaceState, "getPanelDetail").mockImplementation(async (slotId) => {
      const detail = await originalGetPanelDetail(slotId);
      return detail ? { ...detail, icon: "💬" } : detail;
    });

    const projectedRegistry = new PanelRegistry({});
    const projectedManager = new PanelManager({
      registry: projectedRegistry,
      ...deps,
      allowMissingManifests: true,
    });
    await projectedManager.refreshPanel(created.panelId);

    expect(projectedRegistry.getPanel(created.panelId)?.icon).toBe("💬");
  });

  it("places an external panel in an explicitly shared orchestration context", async () => {
    const registry = new PanelRegistry({});
    const { deps } = makeManagerDeps("/tmp/workspace");
    const manager = new PanelManager({
      registry,
      ...deps,
      allowMissingManifests: true,
    });

    const created = await manager.createBrowser(null, "https://shared.example", {
      addAsRoot: true,
      contextId: "ctx-collection",
    });

    expect(created.contextId).toBe("ctx-collection");
    expect(getCurrentSnapshot(registry.getPanel(created.panelId)!).contextId).toBe(
      "ctx-collection"
    );
  });

  it("rejects unsupported browser URL schemes", async () => {
    const registry = new PanelRegistry({});
    const { deps } = makeManagerDeps("/tmp/workspace");
    const manager = new PanelManager({
      registry,
      ...deps,
      allowMissingManifests: true,
    });

    await expect(manager.createBrowser(null, "javascript:alert(1)")).rejects.toThrow(
      "Invalid browser panel URL"
    );
  });

  it("passes stable-neighbor placement to the durable tree", async () => {
    const registry = new PanelRegistry({});
    const { mem, deps } = makeManagerDeps("/tmp/workspace");
    const manager = new PanelManager({
      registry,
      ...deps,
      allowMissingManifests: true,
    });
    const aliceRoot = await manager.createBrowser(null, "https://alice.example", {
      name: "alice-root",
      addAsRoot: true,
      ownerUserId: "alice",
    });
    const bobChild = await manager.createBrowser(null, "https://child.example", {
      name: "bob-child",
      addAsRoot: true,
      ownerUserId: "bob",
    });
    const move = vi.spyOn(mem.workspaceState, "moveSlot");
    const placement = { afterSlotId: aliceRoot.panelId };

    await manager.movePanel(bobChild.panelId, null, placement, "bob");

    expect(move).toHaveBeenCalledWith(bobChild.panelId, null, placement);
  });

  /** A workspace holding one trivial panel manifest, for identity/title tests. */
  const namedPanelWorkspace = () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-panel-manager-"));
    tempDirs.push(workspacePath);
    const panelDir = path.join(workspacePath, "panels", "named");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({ name: "named", vibestudio: { title: "Named Panel" } })
    );
    const aboutDir = path.join(workspacePath, "about", "new");
    fs.mkdirSync(aboutDir, { recursive: true });
    fs.writeFileSync(
      path.join(aboutDir, "package.json"),
      JSON.stringify({ name: "about-new", vibestudio: { title: "New Panel" } })
    );
    const registry = new PanelRegistry({});
    const { deps } = makeManagerDeps(workspacePath);
    return { registry, manager: new PanelManager({ registry, ...deps }) };
  };

  it("treats title as a label and never as identity", async () => {
    const { registry, manager } = namedPanelWorkspace();

    const created = await manager.create("panels/named", {
      isRoot: true,
      addAsRoot: true,
      title: "StateArgs CDP Test",
    });

    // The title must not leak into the id, or panels sharing a title collide.
    expect(created.panelId).not.toContain("StateArgs");
    expect(created.title).toBe("StateArgs CDP Test");
    expect(registry.getPanel(created.panelId)?.title).toBe("StateArgs CDP Test");
  });

  it("falls back to the manifest title when no label is given", async () => {
    const { registry, manager } = namedPanelWorkspace();
    const created = await manager.create("panels/named", { isRoot: true, addAsRoot: true });
    expect(registry.getPanel(created.panelId)?.title).toBe("Named Panel");
  });

  it("normalizes titles and restores the source fallback when a title is cleared", async () => {
    const { registry, manager } = namedPanelWorkspace();
    const created = await manager.create("panels/named", { isRoot: true, addAsRoot: true });

    await manager.updateTitle(created.panelId, "  Support\tInbox  ");
    expect(registry.getPanel(created.panelId)?.title).toBe("Support Inbox");

    await manager.updateTitle(created.panelId, "   ");
    expect(registry.getPanel(created.panelId)?.title).toBe("Named Panel");
  });

  it("keeps generated about-panel identity out of its display title", async () => {
    const { registry, manager } = namedPanelWorkspace();
    const created = await manager.createAboutPanel("new");
    expect(created.title).toBe("New Panel");
    expect(registry.getPanel(created.id)?.title).toBe("New Panel");
    expect(created.id).not.toContain("new~");
  });

  it("gives panels sharing a title distinct ids", async () => {
    const { manager } = namedPanelWorkspace();
    const first = await manager.create("panels/named", {
      isRoot: true,
      addAsRoot: true,
      title: "New Tab",
    });
    const second = await manager.create("panels/named", {
      isRoot: true,
      addAsRoot: true,
      title: "New Tab",
    });
    expect(second.panelId).not.toBe(first.panelId);
  });

  it("uses slug as the id segment when the caller opts in", async () => {
    const { manager } = namedPanelWorkspace();
    const created = await manager.create("panels/named", {
      isRoot: true,
      addAsRoot: true,
      slug: "pinned-inbox",
      title: "Inbox",
    });
    expect(created.panelId).toBe("panel:tree/pinned-inbox");
    expect(created.title).toBe("Inbox");
  });

  it("rejects a duplicate slug instead of silently reusing the slot", async () => {
    const { manager } = namedPanelWorkspace();
    await manager.create("panels/named", { isRoot: true, addAsRoot: true, slug: "pinned" });
    await expect(
      manager.create("panels/named", { isRoot: true, addAsRoot: true, slug: "pinned" })
    ).rejects.toThrow(/already in use/);
  });

  it("creates panel state locally, builds panel init, updates state args, and closes panels", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-panel-manager-"));
    tempDirs.push(workspacePath);

    const panelDir = path.join(workspacePath, "panels", "example");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({
        name: "example",
        vibestudio: {
          title: "Example Panel",
          stateArgs: {
            type: "object",
            properties: { greeting: { type: "string" } },
          },
        },
      })
    );

    const registry = new PanelRegistry({});
    const { mem, deps } = makeManagerDeps(workspacePath);
    const manager = new PanelManager({ registry, ...deps });

    const created = await manager.create("panels/example", {
      isRoot: true,
      addAsRoot: true,
      stateArgs: { greeting: "hello" },
    });

    expect(created.title).toBe("Example Panel");
    expect(registry.getRootPanels()).toHaveLength(1);
    expect(mem.state.slots.has(created.panelId)).toBe(true);
    expect(mem.state.entities.size).toBe(1);

    const createdEntry = mem.state.history.get(created.panelId)?.[0];
    if (!createdEntry) throw new Error("missing created history fixture");
    const active = await deps.runtime.activateReservedEntity({
      kind: "panel",
      execution: { surface: "code", source: createdEntry.source },
      key: createdEntry.entry_key,
      contextId: created.contextId,
      stateArgs: { greeting: "hello" },
    });
    registry.applyExecutionIdentity(created.panelId, {
      runtimeEntityId: active.id,
      effectiveVersion: active.source.effectiveVersion,
      buildKey: active.buildKey!,
      executionDigest: active.executionDigest!,
      authorityRequests: active.authorityRequests ?? [],
    });

    const init = (await manager.getPanelInit(created.panelId)) as {
      entityId: string;
      panelId?: string;
      slotId: string;
      contextId: string;
      sourceRepo: string;
      effectiveVersion: string;
      gatewayConfig: { serverUrl: string; token: string };
      stateArgs: Record<string, unknown>;
    };
    const createdSlot = mem.state.slots.get(created.panelId);
    const currentEntityId = createdSlot?.current_entity_id;
    expect(currentEntityId).toBeTruthy();
    expect(init.entityId).toBe(currentEntityId);
    expect(init.panelId).toBeUndefined();
    expect(init.slotId).toBe(created.panelId);
    expect(init.contextId).toBe(created.contextId);
    expect(init.sourceRepo).toBe("panels/example");
    expect(init.effectiveVersion).toBe("test");
    expect(init.gatewayConfig).toEqual({
      serverUrl: "http://127.0.0.1:42773",
      token: `rpc-${currentEntityId}`,
    });
    expect(init.stateArgs).toEqual({ greeting: "hello" });
    expect(registry.getInfo(created.panelId)).toMatchObject({
      panelId: created.panelId,
      source: "panels/example",
      contextId: init.contextId,
      runtimeEntityId: currentEntityId,
      effectiveVersion: "test",
      build: { effectiveVersion: "test" },
    });

    const onStateArgsChanged = vi.fn();
    const unsubscribe = manager.onStateArgsChanged(created.panelId, onStateArgsChanged);

    const nextStateArgs = await manager.updateStateArgs(created.panelId, { greeting: "updated" });
    expect(nextStateArgs).toEqual({ greeting: "updated" });
    expect(onStateArgsChanged).toHaveBeenCalledWith({ greeting: "updated" });
    expect(mem.state.entities.size).toBe(1);
    expect(mem.state.slots.get(created.panelId)?.current_entity_id).toBe(currentEntityId);
    expect(mem.state.history.get(created.panelId)?.[0]?.state_args).toBe(
      JSON.stringify({ greeting: "updated" })
    );
    expect(getCurrentSnapshot(registry.getPanel(created.panelId)!).stateArgs).toEqual({
      greeting: "updated",
    });

    const clearedStateArgs = await manager.updateStateArgs(created.panelId, { greeting: null });
    expect(clearedStateArgs).toEqual({});
    expect(onStateArgsChanged).toHaveBeenCalledWith({});
    expect(mem.state.entities.size).toBe(1);
    expect(mem.state.slots.get(created.panelId)?.current_entity_id).toBe(currentEntityId);
    expect(getCurrentSnapshot(registry.getPanel(created.panelId)!).stateArgs).toEqual({});

    unsubscribe();
    await manager.updateStateArgs(created.panelId, { greeting: "ignored" });
    expect(onStateArgsChanged).toHaveBeenCalledTimes(2);

    const projectedStateArgs = vi.fn();
    const unsubscribeProjection = manager.onStateArgsChanged(created.panelId, projectedStateArgs);
    const persistedBeforeProjection = mem.state.history.get(created.panelId)?.[0]?.state_args;
    manager.applyStateArgsProjection(created.panelId, { greeting: "projected" });
    expect(getCurrentSnapshot(registry.getPanel(created.panelId)!).stateArgs).toEqual({
      greeting: "projected",
    });
    expect(projectedStateArgs).toHaveBeenCalledWith({ greeting: "projected" });
    expect(mem.state.history.get(created.panelId)?.[0]?.state_args).toBe(persistedBeforeProjection);
    unsubscribeProjection();

    await manager.close(created.panelId);
    expect(registry.getPanel(created.panelId)).toBeUndefined();
    expect(mem.state.slots.get(created.panelId)?.closed_at).not.toBeNull();
    expect(mem.state.retired.length).toBeGreaterThan(0);
  });

  it("forwards explicit create refs to runtime entity creation", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-panel-manager-"));
    tempDirs.push(workspacePath);

    const panelDir = path.join(workspacePath, "panels", "example");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({ name: "example", vibestudio: { title: "Example Panel" } })
    );

    const registry = new PanelRegistry({});
    const { deps } = makeManagerDeps(workspacePath);
    const reserveEntity = vi.spyOn(deps.runtime, "reserveEntity");
    const activateReservedEntity = vi.spyOn(deps.runtime, "activateReservedEntity");
    const manager = new PanelManager({ registry, ...deps });

    const created = await manager.create("panels/example", {
      isRoot: true,
      addAsRoot: true,
      ref: "ctx:panel-dev",
    });

    expect(reserveEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "panel",
        execution: {
          surface: "code",
          source: "panels/example",
          ref: "ctx:panel-dev",
        },
      })
    );
    expect(reserveEntity.mock.calls[0]?.[0]).not.toHaveProperty("contextId");
    expect(created.contextId).toBe("ctx-default");
    expect(activateReservedEntity).not.toHaveBeenCalled();
    expect(getCurrentSnapshot(registry.getPanel(created.panelId)!).options.ref).toBe(
      "ctx:panel-dev"
    );
  });

  it("marks shell manifest panels as privileged in snapshots and create results", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-panel-manager-"));
    tempDirs.push(workspacePath);

    const panelDir = path.join(workspacePath, "about", "shell-panel");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({
        name: "shell-panel",
        vibestudio: {
          title: "Shell Panel",
          shell: true,
        },
      })
    );

    const registry = new PanelRegistry({});
    const { deps } = makeManagerDeps(workspacePath);
    const manager = new PanelManager({ registry, ...deps });

    const created = await manager.create("about/shell-panel", {
      isRoot: true,
      addAsRoot: true,
    });

    expect(created.privileged).toBe(true);
    expect(getCurrentSnapshot(registry.getPanel(created.panelId)!)).toMatchObject({
      privileged: true,
    });
  });

  it("resolves the manifest placement hint into the snapshot when the call site has none", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-panel-manager-"));
    tempDirs.push(workspacePath);

    const panelDir = path.join(workspacePath, "panels", "docs");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({
        name: "docs",
        vibestudio: {
          title: "Docs",
          placement: { disposition: "split-below", preferredWidth: 500 },
        },
      })
    );

    const registry = new PanelRegistry({});
    const { deps } = makeManagerDeps(workspacePath);
    const manager = new PanelManager({ registry, ...deps });

    const created = await manager.create("panels/docs", { isRoot: true, addAsRoot: true });
    const snapshot = getCurrentSnapshot(registry.getPanel(created.panelId)!);
    expect(snapshot.placement).toEqual({ disposition: "split-below", preferredWidth: 500 });
    // The hint also rides the persisted per-entry options blob.
    expect(snapshot.options.placement).toEqual({
      disposition: "split-below",
      preferredWidth: 500,
    });
  });

  it("prefers the call-site placement hint over the manifest default", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-panel-manager-"));
    tempDirs.push(workspacePath);

    const panelDir = path.join(workspacePath, "panels", "docs");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({
        name: "docs",
        vibestudio: { title: "Docs", placement: { disposition: "split-below" } },
      })
    );

    const registry = new PanelRegistry({});
    const { deps } = makeManagerDeps(workspacePath);
    const manager = new PanelManager({ registry, ...deps });

    const created = await manager.create("panels/docs", {
      isRoot: true,
      addAsRoot: true,
      placement: { disposition: "replace", minWidth: 420 },
    });
    expect(getCurrentSnapshot(registry.getPanel(created.panelId)!).placement).toEqual({
      disposition: "replace",
      minWidth: 420,
    });
  });

  it("leaves snapshot placement unset when neither call site nor manifest declares one", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-panel-manager-"));
    tempDirs.push(workspacePath);

    const panelDir = path.join(workspacePath, "panels", "plain");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({ name: "plain", vibestudio: { title: "Plain" } })
    );

    const registry = new PanelRegistry({});
    const { deps } = makeManagerDeps(workspacePath);
    const manager = new PanelManager({ registry, ...deps });

    const created = await manager.create("panels/plain", { isRoot: true, addAsRoot: true });
    expect(getCurrentSnapshot(registry.getPanel(created.panelId)!).placement).toBeUndefined();
  });

  it("updates live navigation state and resolved URL through the shared manager", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-panel-manager-"));
    tempDirs.push(workspacePath);

    const panelDir = path.join(workspacePath, "panels", "browserish");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({ name: "browserish", vibestudio: { title: "Initial Title" } })
    );

    const registry = new PanelRegistry({});
    const { deps } = makeManagerDeps(workspacePath);
    const manager = new PanelManager({ registry, ...deps });

    const created = await manager.create("panels/browserish", {
      isRoot: true,
      addAsRoot: true,
    });

    const revisionBeforeUpdate = registry.getTreeRevision();
    await manager.updatePanelState(created.panelId, {
      url: "https://example.com/docs",
      pageTitle: "Docs",
      isLoading: false,
      canGoBack: true,
      canGoForward: false,
    });

    const panel = registry.getPanel(created.panelId)!;
    expect(panel.title).toBe("Docs");
    expect(panel.navigation).toEqual({
      url: "https://example.com/docs",
      pageTitle: "Docs",
      isLoading: false,
      canGoBack: true,
      canGoForward: false,
    });
    expect(getCurrentSnapshot(panel).source).toBe("panels/browserish");
    expect(getCurrentSnapshot(panel).resolvedUrl).toBe("https://example.com/docs");
    expect(registry.getTreeRevision()).toBeGreaterThan(revisionBeforeUpdate);
  });

  it("builds remote bootstrap URLs with gateway-routed RPC", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-panel-manager-"));
    tempDirs.push(workspacePath);

    const panelDir = path.join(workspacePath, "panels", "remote");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({ name: "remote", vibestudio: { title: "Remote Panel" } })
    );

    const { mem, deps } = makeManagerDeps(workspacePath);
    const manager = new PanelManager({
      registry: new PanelRegistry({}),
      ...deps,
      serverInfo: { gatewayConfig: { serverUrl: "https://vibestudio.example.com" } },
    });

    const created = await manager.create("panels/remote", {
      isRoot: true,
      addAsRoot: true,
    });

    const init = (await manager.getPanelInit(created.panelId)) as {
      gatewayConfig: { serverUrl: string; token: string };
    };
    const slot = mem.state.slots.get(created.panelId);
    const currentEntityId = slot?.current_entity_id;
    expect(currentEntityId).toBeTruthy();
    expect(init.gatewayConfig).toEqual({
      serverUrl: "https://vibestudio.example.com",
      token: `rpc-${currentEntityId}`,
    });
  });

  it("includes both parent slot and parent entity ids in child bootstrap config", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-panel-manager-"));
    tempDirs.push(workspacePath);

    for (const name of ["root", "child"]) {
      const panelDir = path.join(workspacePath, "panels", name);
      fs.mkdirSync(panelDir, { recursive: true });
      fs.writeFileSync(
        path.join(panelDir, "package.json"),
        JSON.stringify({ name, vibestudio: { title: `${name} Panel` } })
      );
    }

    const { mem, deps } = makeManagerDeps(workspacePath);
    const manager = new PanelManager({ registry: new PanelRegistry({}), ...deps });

    const root = await manager.create("panels/root", { isRoot: true, addAsRoot: true });
    const child = await manager.create("panels/child", { parentId: root.panelId });
    const init = (await manager.getPanelInit(child.panelId)) as {
      parentId: string | null;
      parentEntityId: string | null;
    };

    expect(init.parentId).toBe(root.panelId);
    expect(init.parentEntityId).toBe(mem.state.slots.get(root.panelId)?.current_entity_id);
  });

  it("persists recursive close for descendant slots", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-panel-manager-"));
    tempDirs.push(workspacePath);

    for (const name of ["root", "child", "grandchild"]) {
      const panelDir = path.join(workspacePath, "panels", name);
      fs.mkdirSync(panelDir, { recursive: true });
      fs.writeFileSync(
        path.join(panelDir, "package.json"),
        JSON.stringify({ name, vibestudio: { title: `${name} Panel` } })
      );
    }

    const registry = new PanelRegistry({});
    const { mem, deps } = makeManagerDeps(workspacePath);
    const manager = new PanelManager({ registry, ...deps });

    const root = await manager.create("panels/root", { isRoot: true, addAsRoot: true });
    const child = await manager.create("panels/child", { parentId: root.panelId });
    const grandchild = await manager.create("panels/grandchild", { parentId: child.panelId });

    await manager.close(root.panelId);

    expect(mem.state.slots.get(root.panelId)?.closed_at).not.toBeNull();
    expect(mem.state.slots.get(child.panelId)?.closed_at).not.toBeNull();
    expect(mem.state.slots.get(grandchild.panelId)?.closed_at).not.toBeNull();

    expect(registry.getRootPanels()).toEqual([]);
    expect(registry.getPanel(child.panelId)).toBeUndefined();
    expect(registry.getPanel(grandchild.panelId)).toBeUndefined();
  });

  it("drains recursive close cleanup across multiple bounded pages", async () => {
    const registry = new PanelRegistry({});
    const { deps } = makeManagerDeps("/tmp/workspace");
    const manager = new PanelManager({ registry, ...deps, allowMissingManifests: true });
    const root = await manager.createBrowser(null, "https://root.example", {
      name: "root",
      addAsRoot: true,
    });
    for (let index = 0; index < 450; index += 1) {
      await manager.createBrowser(root.panelId, `https://child-${index}.example`, {
        name: `child-${index}`,
      });
    }
    const retire = vi.spyOn(deps.runtime, "retireEntity");

    await expect(manager.close(root.panelId)).resolves.toEqual({ closedCount: 451 });
    expect(retire).toHaveBeenCalledTimes(451);
    await expect(manager.close(root.panelId)).resolves.toEqual({ closedCount: 0 });
  });

  it("archives more than one page of owned roots without retaining their roster", async () => {
    const registry = new PanelRegistry({});
    const { mem, deps } = makeManagerDeps("/tmp/workspace");
    const manager = new PanelManager({ registry, ...deps, allowMissingManifests: true });
    for (let index = 0; index < 450; index += 1) {
      const created = await manager.createBrowser(null, `https://alice-${index}.example`, {
        name: `alice-${index}`,
        addAsRoot: true,
        ownerUserId: "usr_alice",
      });
      mem.state.slots.get(created.panelId)!.owner_user_id = "usr_alice";
    }
    const bob = await manager.createBrowser(null, "https://bob.example", {
      name: "bob",
      addAsRoot: true,
      ownerUserId: "usr_bob",
    });
    mem.state.slots.get(bob.panelId)!.owner_user_id = "usr_bob";

    await expect(manager.archiveOwnedRoots("usr_alice")).resolves.toEqual({
      archivedRootCount: 450,
      closedCount: 450,
    });
    expect(
      [...mem.state.slots.values()].filter(
        (slot) => slot.owner_user_id === "usr_alice" && slot.closed_at === null
      )
    ).toHaveLength(0);
    expect(mem.state.slots.get(bob.panelId)?.closed_at).toBeNull();
  });

  it("strictly reports runtime cleanup failure after atomically archiving only one owner's tree", async () => {
    const registry = new PanelRegistry({});
    const { mem, deps } = makeManagerDeps("/tmp/workspace");
    const manager = new PanelManager({ registry, ...deps, allowMissingManifests: true });
    const aliceRoot = await manager.createBrowser(null, "https://alice.example", {
      name: "alice-root",
      addAsRoot: true,
      ownerUserId: "usr_alice",
    });
    const aliceChild = await manager.createBrowser(aliceRoot.panelId, "https://child.example", {
      name: "alice-child",
      ownerUserId: "usr_alice",
    });
    const bobRoot = await manager.createBrowser(null, "https://bob.example", {
      name: "bob-root",
      addAsRoot: true,
      ownerUserId: "usr_bob",
    });
    mem.state.slots.get(aliceRoot.panelId)!.owner_user_id = "usr_alice";
    mem.state.slots.get(aliceChild.panelId)!.owner_user_id = "usr_alice";
    mem.state.slots.get(bobRoot.panelId)!.owner_user_id = "usr_bob";

    const retire = vi.spyOn(deps.runtime, "retireEntity");
    retire.mockRejectedValueOnce(new Error("runtime busy"));
    await expect(manager.archiveOwnedRoots("usr_alice")).rejects.toThrow("runtime busy");
    expect(mem.state.slots.get(aliceRoot.panelId)?.closed_at).not.toBeNull();
    expect(mem.state.slots.get(aliceChild.panelId)?.closed_at).not.toBeNull();
    expect(mem.state.slots.get(bobRoot.panelId)?.closed_at).toBeNull();
    expect(registry.getPanel(bobRoot.panelId)).toBeDefined();
  });

  it("pushes navigation into history and traverses it via back/forward", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-panel-manager-"));
    tempDirs.push(workspacePath);

    for (const name of ["first", "second"]) {
      const panelDir = path.join(workspacePath, "panels", name);
      fs.mkdirSync(panelDir, { recursive: true });
      fs.writeFileSync(
        path.join(panelDir, "package.json"),
        JSON.stringify({ name, vibestudio: { title: `${name} Panel` } })
      );
    }

    const registry = new PanelRegistry({});
    const { mem, deps } = makeManagerDeps(workspacePath);
    const manager = new PanelManager({ registry, ...deps });

    const created = await manager.create("panels/first", { isRoot: true, addAsRoot: true });
    const retireEntity = vi.spyOn(deps.runtime, "retireEntity");
    retireEntity.mockImplementationOnce(async (entityId) => {
      expect(mem.state.slots.get(created.panelId)?.current_entity_id).not.toBe(entityId);
      const entity = mem.state.entities.get(entityId);
      mem.state.retired.push(entityId);
      if (entity) entity.status = "retired";
    });

    await manager.navigate(created.panelId, "panels/second", { ref: "feature" });

    const afterNavigate = registry.getPanel(created.panelId)!;
    expect(getCurrentSnapshot(afterNavigate).source).toBe("panels/second");
    expect(getCurrentSnapshot(afterNavigate).options.ref).toBe("feature");
    expect(afterNavigate.history?.entries.map((e) => e.source)).toEqual(["panels/second"]);
    expect(afterNavigate.navigation?.canGoBack).toBe(true);
    // Two distinct panel entities exist now; the first was retired.
    expect(mem.state.entities.size).toBe(2);
    expect(mem.state.retired.length).toBeGreaterThanOrEqual(1);

    await manager.navigateHistory(created.panelId, -1);
    expect(getCurrentSnapshot(registry.getPanel(created.panelId)!).source).toBe("panels/first");
    expect(registry.getPanel(created.panelId)?.navigation?.canGoForward).toBe(true);

    await manager.navigateHistory(created.panelId, 1);
    expect(getCurrentSnapshot(registry.getPanel(created.panelId)!).source).toBe("panels/second");
    expect(getCurrentSnapshot(registry.getPanel(created.panelId)!).options.ref).toBe("feature");
  });

  it("keeps the current incarnation active when navigate or replace preparation fails", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-panel-manager-"));
    tempDirs.push(workspacePath);
    for (const name of ["first", "second"]) {
      const panelDir = path.join(workspacePath, "panels", name);
      fs.mkdirSync(panelDir, { recursive: true });
      fs.writeFileSync(
        path.join(panelDir, "package.json"),
        JSON.stringify({ name, vibestudio: { title: `${name} Panel` } })
      );
    }

    const registry = new PanelRegistry({});
    const { mem, deps } = makeManagerDeps(workspacePath);
    const manager = new PanelManager({ registry, ...deps });
    const created = await manager.create("panels/first", { isRoot: true, addAsRoot: true });
    const originalEntityId = mem.state.slots.get(created.panelId)?.current_entity_id;
    const createdEntry = mem.state.history.get(created.panelId)?.[0];
    if (!createdEntry) throw new Error("missing created history fixture");
    await deps.runtime.activateReservedEntity({
      kind: "panel",
      execution: { surface: "code", source: createdEntry.source },
      key: createdEntry.entry_key,
      contextId: created.contextId,
      stateArgs: {},
    });
    const createEntity = vi.spyOn(deps.runtime, "createEntity");
    const retireEntity = vi.spyOn(deps.runtime, "retireEntity");

    createEntity.mockRejectedValueOnce(new Error("prepare failed"));
    await expect(manager.navigate(created.panelId, "panels/second")).rejects.toThrow(
      "prepare failed"
    );
    expect(mem.state.slots.get(created.panelId)?.current_entity_id).toBe(originalEntityId);
    expect(mem.state.history.get(created.panelId)).toHaveLength(1);
    expect(mem.state.entities.get(originalEntityId!)?.status).toBe("active");
    expect(retireEntity).not.toHaveBeenCalled();

    createEntity.mockRejectedValueOnce(new Error("replace prepare failed"));
    await expect(
      manager.replaceCurrentSnapshot(created.panelId, { source: "panels/second" })
    ).rejects.toThrow("replace prepare failed");
    expect(mem.state.slots.get(created.panelId)?.current_entity_id).toBe(originalEntityId);
    expect(mem.state.history.get(created.panelId)).toHaveLength(1);
    expect(mem.state.entities.get(originalEntityId!)?.status).toBe("active");
    expect(retireEntity).not.toHaveBeenCalled();
  });

  it("commits the replacement durably before retiring the old runtime", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-panel-manager-"));
    tempDirs.push(workspacePath);
    const panelDir = path.join(workspacePath, "panels", "first");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({ name: "first", vibestudio: { title: "First Panel" } })
    );

    const registry = new PanelRegistry({});
    const { mem, deps } = makeManagerDeps(workspacePath);
    const commitDesiredState = vi.spyOn(deps.workspaceState, "commitPreparedNavigation");
    const retireEntity = vi.spyOn(deps.runtime, "retireEntity");
    const manager = new PanelManager({ registry, ...deps });
    const created = await manager.create("panels/first", { isRoot: true, addAsRoot: true });
    const previousEntityId = mem.state.slots.get(created.panelId)?.current_entity_id;

    await manager.replaceCurrentSnapshot(created.panelId, {});

    const nextEntityId = mem.state.slots.get(created.panelId)?.current_entity_id;
    expect(nextEntityId).not.toBe(previousEntityId);
    expect(commitDesiredState).toHaveBeenCalledWith(
      expect.objectContaining({
        slotId: created.panelId,
        expectedCurrentEntityId: previousEntityId,
        mutation: expect.objectContaining({
          entry: expect.objectContaining({ entityId: nextEntityId }),
        }),
      })
    );
    expect(commitDesiredState.mock.invocationCallOrder[0]).toBeLessThan(
      retireEntity.mock.invocationCallOrder[0]!
    );
  });

  it("does not retire either ambiguous runtime when the atomic commit call fails", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-panel-manager-"));
    tempDirs.push(workspacePath);
    const panelDir = path.join(workspacePath, "panels", "first");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({ name: "first", vibestudio: { title: "First Panel" } })
    );

    const registry = new PanelRegistry({});
    const { deps } = makeManagerDeps(workspacePath);
    const retireEntity = vi.spyOn(deps.runtime, "retireEntity");
    const manager = new PanelManager({
      registry,
      ...deps,
    });
    vi.spyOn(deps.workspaceState, "commitPreparedNavigation").mockRejectedValueOnce(
      new Error("semantic navigation failed")
    );
    const created = await manager.create("panels/first", { isRoot: true, addAsRoot: true });

    const failure = await manager
      .replaceCurrentSnapshot(created.panelId, {})
      .catch((error) => error);
    expect(failure).toBeInstanceOf(PanelNavigationCommitError);
    expect(failure.errors).toEqual([
      expect.objectContaining({ message: "semantic navigation failed" }),
    ]);
    expect(retireEntity).not.toHaveBeenCalled();
  });

  it("refreshes runtime, build, and navigation state as one authoritative incarnation", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-panel-manager-"));
    tempDirs.push(workspacePath);
    for (const name of ["first", "second"]) {
      const panelDir = path.join(workspacePath, "panels", name);
      fs.mkdirSync(panelDir, { recursive: true });
      fs.writeFileSync(
        path.join(panelDir, "package.json"),
        JSON.stringify({ name, vibestudio: { title: `${name} Panel` } })
      );
    }

    const registry = new PanelRegistry({});
    const { mem, deps } = makeManagerDeps(workspacePath);
    const manager = new PanelManager({ registry, ...deps });
    const created = await manager.create("panels/first", { isRoot: true, addAsRoot: true });
    const panel = registry.getPanel(created.panelId)!;
    const previousEntityId = panel.runtimeEntityId!;
    const previousSnapshot = getCurrentSnapshot(panel);

    await manager.navigate(created.panelId, "panels/second");
    const currentEntityId = mem.state.slots.get(created.panelId)?.current_entity_id;
    const currentBuildKey = currentEntityId
      ? mem.state.entities.get(currentEntityId)?.activeBuildKey
      : undefined;

    // Model a thin host whose local tree mirror missed the server-side
    // replacement broadcast before receiving the new runtime lease.
    panel.runtimeEntityId = previousEntityId;
    panel.effectiveVersion = "stale";
    panel.buildKey = "0".repeat(64);
    panel.snapshot = previousSnapshot;
    panel.history = { entries: [previousSnapshot], index: 0 };

    await expect(manager.refreshSlotEntity(created.panelId)).resolves.toBe(currentEntityId);
    expect(panel).toMatchObject({
      runtimeEntityId: currentEntityId,
      effectiveVersion: "test",
      buildKey: currentBuildKey,
    });
    expect(getCurrentSnapshot(panel).source).toBe("panels/second");
    expect(panel.history?.entries.map((entry) => entry.source)).toEqual(["panels/second"]);
    await expect(manager.getPanelInit(created.panelId)).resolves.toMatchObject({
      entityId: currentEntityId,
      sourceRepo: "panels/second",
      buildKey: currentBuildKey,
    });
  });

  it("prepares a history destination before swapping and retiring the current incarnation", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-panel-manager-"));
    tempDirs.push(workspacePath);
    for (const name of ["first", "second"]) {
      const panelDir = path.join(workspacePath, "panels", name);
      fs.mkdirSync(panelDir, { recursive: true });
      fs.writeFileSync(
        path.join(panelDir, "package.json"),
        JSON.stringify({ name, vibestudio: { title: `${name} Panel` } })
      );
    }

    const registry = new PanelRegistry({});
    const { mem, deps } = makeManagerDeps(workspacePath);
    const manager = new PanelManager({ registry, ...deps });
    const created = await manager.create("panels/first", { isRoot: true, addAsRoot: true });
    await manager.navigate(created.panelId, "panels/second");
    const secondEntityId = mem.state.slots.get(created.panelId)?.current_entity_id;
    const retireEntity = vi.spyOn(deps.runtime, "retireEntity");
    retireEntity.mockClear();
    vi.spyOn(deps.runtime, "createEntity").mockRejectedValueOnce(
      new Error("history prepare failed")
    );

    await expect(manager.navigateHistory(created.panelId, -1)).rejects.toThrow(
      "history prepare failed"
    );
    expect(mem.state.slots.get(created.panelId)?.current_entity_id).toBe(secondEntityId);
    expect(mem.state.entities.get(secondEntityId!)?.status).toBe("active");
    expect(registry.getPanel(created.panelId)?.history?.index).toBe(0);
    expect(retireEntity).not.toHaveBeenCalled();
  });

  it("navigates existing slots to URL-like sources as browser snapshots", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-panel-manager-"));
    tempDirs.push(workspacePath);

    const panelDir = path.join(workspacePath, "panels", "chat");
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({ name: "chat", vibestudio: { title: "Chat" } })
    );

    const registry = new PanelRegistry({});
    const { deps } = makeManagerDeps(workspacePath);
    const manager = new PanelManager({ registry, ...deps });
    const created = await manager.create("panels/chat", { isRoot: true, addAsRoot: true });

    const result = await manager.navigate(created.panelId, "https:/example.org");
    const panel = registry.getPanel(created.panelId)!;

    expect(result).toMatchObject({
      panelId: created.panelId,
      source: "browser:https://example.org/",
      title: "example.org",
    });
    expect(getCurrentSnapshot(panel).source).toBe("browser:https://example.org/");
    expect(panel.title).toBe("example.org");
    expect(panel.history?.entries.map((entry) => entry.source)).toEqual([
      "browser:https://example.org/",
    ]);
    expect(panel.navigation?.canGoBack).toBe(true);
    expect(manager.getIncarnationChurnSnapshot()).toMatchObject({
      committed: 2,
      retired: 1,
      retirementFailures: 0,
      outstanding: 1,
      byCause: { create: 1, navigate: 1 },
    });
  });

  it("keeps the runtime panel cache bounded and hydrates evicted panels by address", async () => {
    const registry = new PanelRegistry({});
    const { mem, deps } = makeManagerDeps("/tmp/workspace");
    const manager = new PanelManager({
      registry,
      ...deps,
      allowMissingManifests: true,
    });
    const created: PanelSlotId[] = [];
    for (let index = 0; index < 300; index++) {
      const panel = await manager.createBrowser(null, `https://history-.example`, {
        addAsRoot: true,
      });
      created.push(panel.panelId);
    }

    expect(registry.listPanels().length).toBeLessThanOrEqual(256);
    const oldest = created[0]!;
    expect(registry.getPanel(oldest)).toBeUndefined();

    const detail = vi.spyOn(mem.workspaceState, "getPanelDetail");
    expect((await manager.getPanel(oldest))?.id).toBe(oldest);
    expect(detail).toHaveBeenCalledWith(oldest);
    expect(registry.listPanels().length).toBeLessThanOrEqual(256);
  });
});
