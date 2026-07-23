/**
 * Authoritative owner-scoped panel-tree bridge.
 *
 * This module owns durable first-attach seeding, the workspace-state-backed
 * panel manager, host assignment, and browser snapshots. Registration only
 * supplies the concrete collaborators and publishes the resulting bridge.
 */

import { createHash, randomUUID } from "crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { access, mkdir, writeFile } from "node:fs/promises";
import nodePath from "node:path";
import { createDevLogger } from "@vibestudio/dev-log";
import type { UserSubject } from "@vibestudio/identity/types";
import { PanelManager } from "@vibestudio/shell-core/panelManager";
import type {
  RuntimeClient,
  SlotCreateInput,
  SlotHistoryRow,
  SlotRow,
  WorkspaceStateClient,
} from "@vibestudio/shell-core/workspaceStateClient";
import {
  createHostCaller,
  type ServiceContext,
  type ServiceDispatcher,
  type VerifiedCaller,
} from "@vibestudio/shared/serviceDispatcher";
import type { ServiceContainer } from "@vibestudio/shared/serviceContainer";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import {
  getCurrentSnapshot,
  getPanelContextId,
  getPanelSource,
  getPanelStateArgs,
} from "@vibestudio/shared/panel/accessors";
import { isOpenPanelBrowserUrl } from "@vibestudio/shared/panelChrome";
import { asPanelSlotId } from "@vibestudio/shared/panel/ids";
import type { PanelSlotId } from "@vibestudio/shared/panel/ids";
import { resolveOwningPanelSlot } from "@vibestudio/shared/panel/owningPanelSlot";
import type {
  EntityRecord,
  RuntimeEntityCreateSpec,
  RuntimeEntityHandle,
} from "@vibestudio/shared/runtime/entitySpec";
import type { PanelNavigationState } from "@vibestudio/shared/types";
import type {
  IndexablePanel,
  PanelSearchIndex,
  PanelSearchResult,
} from "@vibestudio/shared/panelSearchTypes";
import { stateLayout } from "./stateLayout.js";
import type { CdpBridge } from "./cdpBridge.js";
import type { PanelRuntimeCoordinator } from "./panelRuntimeCoordinator.js";
import type { PanelTreeBridgeRequest } from "./services/panelTreeService.js";
import type { EventService } from "@vibestudio/shared/eventsService";

const log = createDevLogger("OwnerPanelTreeBridge");

export interface OwnerPanelTreeBridgeDeps {
  container: ServiceContainer;
  dispatcher: ServiceDispatcher;
  workspacePath: string;
  workspaceConfig: WorkspaceConfig;
  eventService: EventService | undefined;
  panelRuntimeCoordinator: PanelRuntimeCoordinator | undefined;
  ensureDefaultHeadlessHost: (() => Promise<boolean>) | undefined;
  getGatewayPort: (() => number | null) | undefined;
  registerEntityTitleListener:
    | ((
        listener: (
          entityId: string,
          title: string | undefined,
          origin: "set" | "set-explicit" | "mirror" | "clear"
        ) => void | Promise<void>
      ) => () => void)
    | undefined;
  registerSlotStateListener: ((listener: () => void) => () => void) | undefined;
}

export type PanelTreeBridge = (request: PanelTreeBridgeRequest) => Promise<unknown>;

export async function waitForCdpTargetRegistered(
  bridge: CdpBridge,
  panelId: string,
  hostConnectionId?: string,
  timeoutMs = 30_000
): Promise<void> {
  const isReady = () =>
    hostConnectionId
      ? bridge.isTargetRegisteredForHost(panelId, hostConnectionId)
      : bridge.isTargetRegistered(panelId);
  if (isReady()) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (isReady()) return;
  }
  throw new Error(`CDP endpoint unavailable for panel: ${panelId}`);
}

function normalizePanelNavigationState(input: Record<string, unknown>): PanelNavigationState {
  return {
    ...(typeof input["url"] === "string" ? { url: input["url"] } : {}),
    ...(typeof input["pageTitle"] === "string" ? { pageTitle: input["pageTitle"] } : {}),
    ...(typeof input["isLoading"] === "boolean" ? { isLoading: input["isLoading"] } : {}),
    ...(typeof input["canGoBack"] === "boolean" ? { canGoBack: input["canGoBack"] } : {}),
    ...(typeof input["canGoForward"] === "boolean" ? { canGoForward: input["canGoForward"] } : {}),
  };
}

function normalizePanelTreeNavigateOptions(input: unknown):
  | {
      ref?: string;
      contextId?: string;
      env?: Record<string, string>;
      stateArgs?: Record<string, unknown>;
    }
  | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const env =
    record["env"] && typeof record["env"] === "object"
      ? Object.fromEntries(
          Object.entries(record["env"] as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string"
          )
        )
      : undefined;
  const stateArgs =
    record["stateArgs"] && typeof record["stateArgs"] === "object"
      ? (record["stateArgs"] as Record<string, unknown>)
      : undefined;
  return {
    ...(typeof record["ref"] === "string" ? { ref: record["ref"] } : {}),
    ...(typeof record["contextId"] === "string" ? { contextId: record["contextId"] } : {}),
    ...(env ? { env } : {}),
    ...(stateArgs ? { stateArgs } : {}),
  };
}

export function panelHostCommandAssignmentError(
  panelId: string,
  reason: "already_held" | "mobile_held" | "no_default_cdp_host"
): Error | null {
  if (reason === "mobile_held") {
    return Object.assign(new Error(`Panel ${panelId} is held by a non-CDP host`), {
      code: "panel_host_command_unavailable_mobile_held",
    });
  }
  if (reason === "no_default_cdp_host") {
    return Object.assign(new Error(`No CDP-capable host is available for panel: ${panelId}`), {
      code: "panel_host_command_no_default_cdp_host",
    });
  }
  return null;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function initPanelSeedKey(source: string, stateArgs: Record<string, unknown> | undefined): string {
  return `${source}\u0000${stableJson(stateArgs ?? {})}`;
}

type InitPanelRoot = {
  id?: unknown;
  panelId?: unknown;
  source?: unknown;
  owner?: unknown;
};

/**
 * The SERVER is the single authority that seeds the initial panel tree from the workspace's
 * `initPanels`. Reconciles the configured init-root multiset against roots that already look
 * like init roots, giving retry semantics for a partial previous seed without re-seeding
 * unrelated, established trees.
 *
 * WP3: seeding is **per-owner**. Only that user's roots are reconciled and every
 * created root is stamped with its owner. Every account, including root, seeds
 * on its first attach.
 */
export async function seedPanelTreeIfEmpty(
  bridge: (
    request: import("./services/panelTreeService.js").PanelTreeBridgeRequest
  ) => Promise<unknown>,
  initPanels: ReadonlyArray<{ source: string; stateArgs?: Record<string, unknown> }>,
  ownerSubject: UserSubject
): Promise<void> {
  if (initPanels.length === 0) return;
  const ownerUserId = ownerSubject.userId;
  const allRoots = (await bridge({
    callerId: "server",
    callerKind: "server",
    method: "roots",
    args: [],
  })) as InitPanelRoot[];
  if (!Array.isArray(allRoots)) {
    throw new Error("panelTree.roots returned a non-array result during init-panel seed");
  }
  // Reconcile only THIS owner's roots (mutual visibility means `roots` returns
  // every owner's roots; we seed one user's tree at a time).
  const roots = allRoots.filter(
    (root) => (typeof root.owner === "string" ? root.owner : undefined) === ownerUserId
  );

  const desiredCounts = new Map<string, number>();
  for (const entry of initPanels) {
    const key = initPanelSeedKey(entry.source, entry.stateArgs);
    desiredCounts.set(key, (desiredCounts.get(key) ?? 0) + 1);
  }

  const existingCounts = new Map<string, number>();
  if (roots.length > 0) {
    for (const root of roots) {
      if (typeof root.source !== "string") return;
      const rootId =
        typeof root.panelId === "string"
          ? root.panelId
          : typeof root.id === "string"
            ? root.id
            : null;
      if (!rootId) return;
      const stateArgs = (await bridge({
        callerId: "server",
        callerKind: "server",
        method: "getStateArgs",
        args: [rootId],
      })) as Record<string, unknown> | undefined;
      const key = initPanelSeedKey(root.source, stateArgs);
      if (!desiredCounts.has(key)) return;
      existingCounts.set(key, (existingCounts.get(key) ?? 0) + 1);
    }
  }

  const remainingCounts = new Map(existingCounts);
  for (const entry of initPanels) {
    const key = initPanelSeedKey(entry.source, entry.stateArgs);
    const remaining = remainingCounts.get(key) ?? 0;
    if (remaining > 0) {
      remainingCounts.set(key, remaining - 1);
      continue;
    }
    await bridge({
      callerId: "server",
      callerKind: "server",
      method: "create",
      args: [entry.source, { stateArgs: entry.stateArgs }],
      // Stamp the seeded root under its owner's tree (WP3).
      subject: ownerSubject,
    });
  }
}

export interface OwnerPanelSeedStore {
  isSeeded(ownerUserId: string): Promise<boolean>;
  markSeeded(ownerUserId: string): Promise<void>;
}

/**
 * Durable first-attach ledger. Without this marker, archiving every default
 * panel followed by a server restart would incorrectly recreate them.
 */
export function createOwnerPanelSeedStore(statePath: string): OwnerPanelSeedStore {
  const markerDir = stateLayout(statePath).ownerPanelSeedsDir;
  const markerPath = (ownerUserId: string) =>
    nodePath.join(markerDir, createHash("sha256").update(ownerUserId).digest("hex"));

  return {
    async isSeeded(ownerUserId) {
      try {
        await access(markerPath(ownerUserId));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    async markSeeded(ownerUserId) {
      await mkdir(markerDir, { recursive: true });
      try {
        await writeFile(markerPath(ownerUserId), ownerUserId, { encoding: "utf8", flag: "wx" });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    },
  };
}

/**
 * Wrap the authoritative bridge with per-account first-attach seeding. The
 * wrapper deliberately ignores subject-less/system requests: infrastructure
 * must never recreate the retired anonymous shared root tree.
 */
export function createOwnerSeedingPanelTreeBridge(
  bridge: (
    request: import("./services/panelTreeService.js").PanelTreeBridgeRequest
  ) => Promise<unknown>,
  initPanels: ReadonlyArray<{ source: string; stateArgs?: Record<string, unknown> }>,
  seedStore?: OwnerPanelSeedStore
): (request: import("./services/panelTreeService.js").PanelTreeBridgeRequest) => Promise<unknown> {
  const ownerSeedPromises = new Map<string, Promise<void>>();

  const seedForOwner = (ownerSubject: UserSubject): Promise<void> => {
    const ownerUserId = ownerSubject.userId;
    let pending = ownerSeedPromises.get(ownerUserId);
    if (pending) return pending;
    pending = (async () => {
      if (seedStore && (await seedStore.isSeeded(ownerUserId))) return;
      await seedPanelTreeIfEmpty(bridge, initPanels, ownerSubject);
      await seedStore?.markSeeded(ownerUserId);
    })().catch((error) => {
      ownerSeedPromises.delete(ownerUserId);
      throw error;
    });
    ownerSeedPromises.set(ownerUserId, pending);
    return pending;
  };

  return async (request) => {
    const ownerSubject = request.subject;
    if (ownerSubject && ownerSubject.userId !== "system") {
      await seedForOwner(ownerSubject);
    }
    return bridge(request);
  };
}

export async function createServerPanelTreeBridge(
  deps: OwnerPanelTreeBridgeDeps
): Promise<
  (request: import("./services/panelTreeService.js").PanelTreeBridgeRequest) => Promise<unknown>
> {
  const registry = new PanelRegistry({});
  const serverCtx: ServiceContext = { caller: createHostCaller("server") };
  const callerContext = new AsyncLocalStorage<VerifiedCaller>();
  const call = <T>(service: string, method: string, args: unknown[]) =>
    deps.dispatcher.dispatch(
      { caller: callerContext.getStore() ?? serverCtx.caller },
      service,
      method,
      args
    ) as Promise<T>;
  const callRuntime = <T>(method: string, args: unknown[]) => call<T>("runtime", method, args);
  const workspaceState: WorkspaceStateClient = {
    listSlots: () => call<SlotRow[]>("workspace-state", "slot.list", []),
    getSlot: (slotId) => call<SlotRow | null>("workspace-state", "slot.get", [slotId]),
    getSlotHistory: (slotId) => call<SlotHistoryRow[]>("workspace-state", "slot.history", [slotId]),
    resolveActiveEntity: (id) =>
      call<EntityRecord | null>("workspace-state", "entity.resolveActive", [id]),
    resolveEntity: (id) => call<EntityRecord | null>("workspace-state", "entity.resolve", [id]),
    resolveSlotByEntity: (entityId) =>
      call<string | null>("workspace-state", "slot.resolveByEntity", [entityId]),
    createSlot: (input: SlotCreateInput) =>
      call<undefined>("workspace-state", "slot.create", [input]),
    commitPreparedNavigation: (input) =>
      call("workspace-state", "slot.commitPreparedNavigation", [input]),
    updateCurrentStateArgs: (slotId, stateArgs) =>
      call<undefined>("workspace-state", "slot.updateCurrentStateArgs", [slotId, stateArgs]),
    setSlotParent: (slotId, parentSlotId) =>
      call<undefined>("workspace-state", "slot.setParent", [slotId, parentSlotId]),
    setSlotPosition: (slotId, positionId) =>
      call<undefined>("workspace-state", "slot.setPosition", [slotId, positionId]),
    moveSlot: (slotId, parentSlotId, positionId) =>
      call<undefined>("workspace-state", "slot.move", [slotId, parentSlotId, positionId]),
    closeSlot: (slotId) => call<undefined>("workspace-state", "slot.close", [slotId]),
  };
  const runtime: RuntimeClient = {
    createEntity: (spec: RuntimeEntityCreateSpec) =>
      callRuntime<RuntimeEntityHandle>("createEntity", [spec]),
    reservePanelEntity: (spec) => callRuntime<RuntimeEntityHandle>("reservePanelEntity", [spec]),
    activatePanelEntity: (spec) => callRuntime<RuntimeEntityHandle>("activatePanelEntity", [spec]),
    retireEntity: (id) => callRuntime<undefined>("retireEntity", [{ id }]),
  };
  const searchIndex: PanelSearchIndex = {
    indexPanel: (panel: IndexablePanel) =>
      call<undefined>("workspace-state", "panel.index", [panel]),
    search: (query: string, limit?: number) =>
      call<PanelSearchResult[]>("workspace-state", "panel.search", [query, limit]),
    incrementAccessCount: (panelId: string) =>
      call<undefined>("workspace-state", "panel.incrementAccess", [panelId]),
    updateTitle: (panelId: string, title: string) =>
      call<undefined>("workspace-state", "panel.updateTitle", [panelId, title]),
    rebuildIndex: () => call<undefined>("workspace-state", "panel.rebuildIndex", []),
  };
  const panelManager = new PanelManager({
    registry,
    workspaceState,
    runtime,
    activationClient: {
      markPanelActive: (panelId) => call<undefined>("presence", "markPanelActive", [panelId]),
    },
    viewState: {
      load: () => ({ collapsedIds: [] }),
      save: () => {},
    },
    metadataResolver: {
      getPanelMetadata: (source) =>
        call<{ title?: string } | null>("build", "getPanelMetadata", [source]),
    },
    workspacePath: deps.workspacePath,
    allowMissingManifests: true,
    searchIndex,
    workspaceConfig: deps.workspaceConfig,
    serverInfo: {
      gatewayConfig: { serverUrl: `http://127.0.0.1:${deps.getGatewayPort?.() ?? 0}` },
    },
    grantConnection: (panelId) => call<{ token: string }>("auth", "grantConnection", [panelId]),
  });

  let panelTreeLoaded = false;
  let panelTreeLoadPromise: Promise<void> | null = null;
  const hydrateExecutionAuthority = async (): Promise<void> => {
    const preparingSlots: PanelSlotId[] = [];
    await Promise.all(
      registry.listPanels().map(async ({ panelId }) => {
        const panel = registry.getPanel(panelId);
        if (!panel?.runtimeEntityId || panel.snapshot.source.startsWith("browser:")) return;
        const record = await workspaceState.resolveEntity(panel.runtimeEntityId);
        const authority = record?.activeAuthority;
        panel.buildKey = record?.activeBuildKey ?? null;
        panel.executionDigest = record?.activeExecutionDigest ?? null;
        panel.authorityRequests = authority?.requests;
        panel.authorityEvalCeilings = authority?.evalCeilings;
        if (record?.status === "preparing") {
          preparingSlots.push(asPanelSlotId(panelId));
          panel.artifacts = {
            ...panel.artifacts,
            buildState: "pending",
            buildProgress: "Preparing panel runtime...",
            error: undefined,
          };
        } else if (!record?.activeBuildKey || !record.activeExecutionDigest || !authority) {
          panel.artifacts = {
            ...panel.artifacts,
            buildState: "error",
            error:
              "Panel execution identity is incomplete. The workspace state is incompatible or corrupt and cannot be loaded.",
            buildProgress: "Panel unavailable — invalid execution identity",
          };
        }
      })
    );
    for (const slotId of preparingSlots) {
      void panelManager
        .resumePanelPreparation(slotId)
        .then(() => emitTreeSnapshot())
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          const panel = registry.getPanel(slotId);
          if (panel) {
            registry.updateArtifacts(slotId, {
              ...panel.artifacts,
              buildState: "error",
              error: message,
              buildProgress: "Panel runtime preparation failed",
            });
          }
          emitTreeSnapshot();
          log.warn(`Panel ${slotId} runtime preparation resume failed: ${message}`);
        });
    }
  };
  const sync = async (options: { force?: boolean } = {}) => {
    if (panelTreeLoaded && !options.force) return;
    log.verbose(`Synchronizing authoritative tree (force=${options.force === true})`);
    panelTreeLoadPromise ??= panelManager
      .loadTree()
      .then(async () => {
        log.verbose("Authoritative slot tree loaded; hydrating execution authority");
        await hydrateExecutionAuthority();
        panelTreeLoaded = true;
        log.verbose("Authoritative tree synchronization complete");
      })
      .finally(() => {
        panelTreeLoadPromise = null;
      });
    await panelTreeLoadPromise;
  };
  const emitTreeSnapshot = () => {
    deps.eventService?.emit("panel-tree-updated", registry.getPanelTreeSnapshot());
  };

  // Tree operations and the full-registry self-heal must never interleave, but
  // a background repair must not sit ahead of a user mutation. Keep one
  // executor with explicit priority: bridge requests always drain before a
  // queued self-heal. This preserves the no-oscillation invariant without
  // turning a stale repair read into click latency.
  type ScheduledOperation = {
    run: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  };
  const userOperations: ScheduledOperation[] = [];
  const maintenanceOperations: ScheduledOperation[] = [];
  let operationRunning = false;
  const drainOperations = () => {
    if (operationRunning) return;
    const next = userOperations.shift() ?? maintenanceOperations.shift();
    if (!next) return;
    operationRunning = true;
    void next
      .run()
      .then(next.resolve, next.reject)
      .finally(() => {
        operationRunning = false;
        drainOperations();
      });
  };
  const scheduleOperation = <T>(
    priority: "user" | "maintenance",
    fn: () => Promise<T>
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const queue = priority === "user" ? userOperations : maintenanceOperations;
      queue.push({
        run: fn,
        resolve: (value) => resolve(value as T),
        reject,
      });
      drainOperations();
    });

  // Self-heal: whenever the authoritative slot tree changes (any client, via the
  // shared workspace-state service), force a fresh sync and re-broadcast so every
  // client mirror converges. Debounced — one logical mutation (e.g. a navigate)
  // emits several slot writes. Reads only, so it never re-triggers itself.
  let selfHealRunning = false;
  let selfHealQueued = false;
  const runSelfHeal = async () => {
    if (selfHealRunning) {
      selfHealQueued = true;
      return;
    }
    selfHealRunning = true;
    selfHealQueued = false;
    try {
      await scheduleOperation("maintenance", async () => {
        await sync({ force: true });
        emitTreeSnapshot();
      });
    } catch (error) {
      log.warn(
        `Panel tree self-heal failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      selfHealRunning = false;
      if (selfHealQueued) queueMicrotask(() => void runSelfHeal());
    }
  };
  let selfHealTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSelfHeal = () => {
    if (selfHealTimer) return;
    selfHealTimer = setTimeout(() => {
      selfHealTimer = null;
      void runSelfHeal();
    }, 16);
  };
  deps.registerSlotStateListener?.(scheduleSelfHeal);

  deps.registerEntityTitleListener?.(async (entityId, title, origin) => {
    if (origin === "mirror") return;
    const normalized = title?.trim();
    if (!normalized) return;
    const target = await panelManager.resolveTitleTargetSlot(entityId);
    if (!target) return;
    if (!target.titleIsAlreadyPersistedForSlot && origin !== "set-explicit") return;
    if (!target.titleIsAlreadyPersistedForSlot) {
      await panelManager.updateTitle(asPanelSlotId(target.slotId), normalized);
    }
    deps.eventService?.emit("panel-title-updated", {
      panelId: target.slotId,
      title: normalized,
      explicit: origin === "set-explicit",
    });
  });
  const withRuntimeEntity = async <T extends { panelId: string }>(
    item: T
  ): Promise<
    T & {
      runtimeEntityId: string;
      effectiveVersion?: string | null;
      buildKey?: string | null;
      executionDigest?: string | null;
      authorityRequests?: readonly import("@vibestudio/shared/authorityManifest").UnitAuthorityRequest[];
      authorityEvalCeilings?: readonly import("@vibestudio/shared/authorityManifest").EvalAuthorityCeiling[];
    }
  > => {
    const slotId = asPanelSlotId(item.panelId);
    const runtimeEntityId = await panelManager.getCurrentEntityId(slotId);
    const record = await workspaceState.resolveEntity(runtimeEntityId);
    const executionDigest = record?.activeExecutionDigest ?? null;
    const authority = record?.activeAuthority;
    return {
      ...item,
      runtimeEntityId,
      effectiveVersion: record?.source.effectiveVersion ?? null,
      buildKey: record?.activeBuildKey ?? null,
      executionDigest,
      ...(authority
        ? {
            authorityRequests: authority.requests,
            authorityEvalCeilings: authority.evalCeilings,
          }
        : {}),
    };
  };
  const panelToListItem = (
    panel: import("@vibestudio/shared/types").Panel,
    parentId: string | null
  ) => ({
    panelId: panel.id,
    title: panel.title,
    source: getPanelSource(panel),
    kind: getPanelSource(panel).startsWith("browser:")
      ? ("browser" as const)
      : ("workspace" as const),
    parentId,
    contextId: getPanelContextId(panel),
    // WP3: expose the owning-user id so per-user init seeding reconciles a
    // user's own roots and consumers can group the forest.
    owner: panel.owner ?? null,
  });
  const ensureDefaultLoaded = async (
    panelId: string,
    options: { replaceUnavailableLease?: boolean } = {}
  ) => {
    await sync();
    const runtimeEntityId = await panelManager.getCurrentEntityId(asPanelSlotId(panelId));
    const cdpBridge = deps.container.get<import("./cdpBridge.js").CdpBridge>("cdpBridge");
    let assigned = deps.panelRuntimeCoordinator?.ensureDefaultCdpHostForSlot(
      panelId,
      runtimeEntityId,
      {
        isHostAvailable: (hostConnectionId) => cdpBridge.isProviderConnected(hostConnectionId),
        replaceUnavailableLease: options.replaceUnavailableLease,
      }
    );
    if (
      assigned &&
      !assigned.assigned &&
      assigned.reason === "no_default_cdp_host" &&
      deps.ensureDefaultHeadlessHost
    ) {
      // Renderer of last resort: spawn the headless host and retry once.
      if (await deps.ensureDefaultHeadlessHost()) {
        assigned = deps.panelRuntimeCoordinator?.ensureDefaultCdpHostForSlot(
          panelId,
          runtimeEntityId,
          {
            isHostAvailable: (hostConnectionId) => cdpBridge.isProviderConnected(hostConnectionId),
            replaceUnavailableLease: options.replaceUnavailableLease,
          }
        );
      }
    }
    const assignmentReason = assigned && !assigned.assigned ? assigned.reason : undefined;
    const loadedByLease = Boolean(assigned?.assigned || assignmentReason === "already_held");
    if (loadedByLease) {
      const holder = deps.panelRuntimeCoordinator?.resolveHostForSlot(panelId) ?? null;
      // A CDP host lease is only an assignment. Do not report a programmatic
      // panel as loaded until the host has actually created and registered its
      // renderer target. Mobile/non-CDP holders have their own load contract.
      if (holder?.supportsCdp) {
        if (!cdpBridge.isProviderConnected(holder.hostConnectionId)) {
          throw new Error(`CDP host provider unavailable for panel: ${panelId}`);
        }
        await waitForCdpTargetRegistered(cdpBridge, panelId, holder.hostConnectionId);
      }
    }
    return {
      panelId,
      status: loadedByLease ? "loaded" : (assignmentReason ?? "no_default_cdp_host"),
      focused: false,
      loaded: loadedByLease,
      holderLabel: assigned?.lease?.holderLabel,
    };
  };
  const ensureHostCommandTargetReady = async (panelId: string) => {
    const cdpBridge = deps.container.get<import("./cdpBridge.js").CdpBridge>("cdpBridge");
    let holder = deps.panelRuntimeCoordinator?.resolveHostForSlot(panelId) ?? null;
    if (holder && !holder.supportsCdp) {
      throw Object.assign(new Error(`Panel ${panelId} is held by a non-CDP host`), {
        code: "panel_host_command_unavailable_mobile_held",
      });
    }
    const holderProviderUnavailable =
      holder && !cdpBridge.isProviderConnected(holder.hostConnectionId);
    if (
      !holder ||
      holderProviderUnavailable ||
      !cdpBridge.isTargetRegisteredForHost(panelId, holder.hostConnectionId)
    ) {
      const loaded = await ensureDefaultLoaded(panelId, {
        replaceUnavailableLease: Boolean(holderProviderUnavailable),
      });
      if (loaded.status === "mobile_held" || loaded.status === "no_default_cdp_host") {
        throw panelHostCommandAssignmentError(panelId, loaded.status);
      }
      holder = deps.panelRuntimeCoordinator?.resolveHostForSlot(panelId) ?? holder;
    }
    if (holder && !holder.supportsCdp) {
      throw Object.assign(new Error(`Panel ${panelId} is held by a non-CDP host`), {
        code: "panel_host_command_unavailable_mobile_held",
      });
    }
    if (holder && !cdpBridge.isProviderConnected(holder.hostConnectionId)) {
      throw Object.assign(new Error(`CDP host provider unavailable for panel: ${panelId}`), {
        code: "panel_host_command_unavailable_cdp_host",
      });
    }
    if (holder) {
      await waitForCdpTargetRegistered(cdpBridge, panelId, holder.hostConnectionId);
    } else if (!cdpBridge.isTargetRegistered(panelId)) {
      await waitForCdpTargetRegistered(cdpBridge, panelId);
    }
    return cdpBridge;
  };

  const handleBridgeRequest = async (
    request: import("./services/panelTreeService.js").PanelTreeBridgeRequest
  ): Promise<unknown> => {
    const method = request.method;
    const args = request.args;
    switch (method) {
      case "list": {
        await sync();
        const parentId = typeof args[0] === "string" ? args[0] : null;
        const panels = parentId ? registry.getChildren(parentId) : registry.listPanels();
        return Promise.all(panels.map((panel) => withRuntimeEntity(panel)));
      }
      case "roots": {
        await sync();
        return Promise.all(
          registry.getRootPanels().map((panel) => withRuntimeEntity(panelToListItem(panel, null)))
        );
      }
      case "getTreeSnapshot": {
        // The shell app uses this as its startup recovery read if it missed the
        // first panel-tree event. Force a fresh authoritative read so an early
        // empty bridge sync cannot strand the renderer on an empty mirror.
        await sync({ force: true });
        return registry.getPanelTreeSnapshot();
      }
      case "getFocusedPanelId": {
        await sync();
        return registry.getFocusedPanelId();
      }
      case "metadata": {
        await sync();
        const panelId = String(args[0]);
        let panel = registry.getPanel(panelId);
        if (!panel) {
          await sync({ force: true });
          panel = registry.getPanel(panelId);
        }
        if (!panel) return null;
        const snapshot = getCurrentSnapshot(panel);
        return {
          id: panelId,
          title: panel.title,
          source: getPanelSource(panel),
          kind: getPanelSource(panel).startsWith("browser:") ? "browser" : "workspace",
          parentId: registry.findParentId(panelId),
          runtimeEntityId: await panelManager.getCurrentEntityId(asPanelSlotId(panelId)),
          effectiveVersion:
            (await panelManager.getCurrentEntitySource(asPanelSlotId(panelId)))?.effectiveVersion ??
            null,
          buildKey: panel.buildKey ?? null,
          executionDigest: panel.executionDigest ?? null,
          authorityRequests: panel.authorityRequests,
          authorityEvalCeilings: panel.authorityEvalCeilings,
          contextId: getPanelContextId(panel),
          ref: snapshot.options.ref,
          privileged: snapshot.privileged === true,
        };
      }
      case "create": {
        await sync();
        const source = String(args[0]);
        const options = (args[1] ?? {}) as {
          parentId?: string | null;
          name?: string;
          focus?: boolean;
          ref?: string;
          stateArgs?: Record<string, unknown>;
          placement?: import("@vibestudio/shared/types").PanelPlacementHint;
        };
        // Resolve the owning panel TREE SLOT once, durably. Explicit null = root; an explicit id or
        // the implicit caller = walk the entity lineage to the nearest OPEN panel and return its slot
        // id (parity for panel/worker/agent/eval callers + removal-robustness, in one resolver). This
        // is the single fix for the nav-id-vs-slot-id mismatch that rooted agent/eval-launched panels.
        const explicitParentProvided =
          options.parentId === null || typeof options.parentId === "string";
        const parentStartId = explicitParentProvided ? options.parentId : request.callerId;
        const parentId =
          parentStartId == null
            ? undefined
            : await resolveOwningPanelSlot(parentStartId, {
                isOpenSlot: (id) => Boolean(registry.getPanel(id)),
                resolveOpenSlotForEntity: async (id) =>
                  (await workspaceState.resolveSlotByEntity(id)) ?? undefined,
                resolveParentId: async (id) =>
                  (await workspaceState.resolveActiveEntity(id))?.parentId,
              });
        const isBrowser = isOpenPanelBrowserUrl(source);
        // A null parent means a root panel. addPanel() treats a null parent
        // WITHOUT addAsRoot as "replace the tree with this single panel", so root
        // creates MUST set addAsRoot/isRoot — otherwise a root create would wipe
        // the in-memory mirror to one panel before the next sync restores it.
        const isRoot = parentId == null;
        // WP3: stamp the acting user (threaded on the bridge request) as owner.
        const ownerUserId = request.subject?.userId;
        const created = isBrowser
          ? await panelManager.createBrowser(parentId ?? null, source, {
              name: options.name,
              addAsRoot: isRoot,
              ...(ownerUserId ? { ownerUserId } : {}),
            })
          : await panelManager.create(source, {
              ...options,
              parentId,
              isRoot,
              addAsRoot: isRoot,
              ...(ownerUserId ? { ownerUserId } : {}),
            });
        if (created.preparation) {
          void created.preparation
            .then(() => {
              emitTreeSnapshot();
            })
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              const panel = registry.getPanel(created.panelId);
              if (panel) {
                registry.updateArtifacts(created.panelId, {
                  ...panel.artifacts,
                  buildState: "error",
                  error: message,
                  buildProgress: "Panel runtime preparation failed",
                });
              }
              emitTreeSnapshot();
              log.warn(`Panel ${created.panelId} runtime preparation failed: ${message}`);
            });
        }
        emitTreeSnapshot();
        const runtimeEntityId = await panelManager.getCurrentEntityId(
          asPanelSlotId(created.panelId)
        );
        const entitySource = await panelManager.getCurrentEntitySource(
          asPanelSlotId(created.panelId)
        );
        if (options.focus) {
          // Focus is semantic state; renderer readiness is presentation state.
          // Publish/select the new slot as soon as its durable identity exists,
          // then let the assigned desktop or mobile host load it asynchronously.
          // Waiting for CDP registration here made panel-tree.create block on a
          // complete Electron page load before the shell could show progress.
          await panelManager.notifyFocused(asPanelSlotId(created.panelId));
          emitTreeSnapshot();
          void ensureDefaultLoaded(created.panelId).catch((error: unknown) => {
            log.warn(
              `Focused panel ${created.panelId} could not be assigned to a runtime host: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          });
        }
        return {
          id: created.panelId,
          title: created.title,
          kind: isBrowser ? "browser" : "workspace",
          parentId: parentId ?? null,
          contextId: created.contextId,
          source: created.source,
          runtimeEntityId,
          effectiveVersion: entitySource?.effectiveVersion ?? null,
          buildKey: registry.getPanel(created.panelId)?.buildKey ?? null,
          executionDigest: registry.getPanel(created.panelId)?.executionDigest ?? null,
          authorityRequests: registry.getPanel(created.panelId)?.authorityRequests,
          authorityEvalCeilings: registry.getPanel(created.panelId)?.authorityEvalCeilings,
        };
      }
      case "focus": {
        const panelId = String(args[0]);
        const options = (args[1] ?? {}) as {
          anchorPanelId?: string;
          placement?: import("@vibestudio/shared/types").PanelPlacementHint;
        };
        const anchorPanelId =
          typeof options.anchorPanelId === "string" && options.anchorPanelId.length > 0
            ? options.anchorPanelId
            : (registry.getFocusedPanelId() ?? undefined);
        const loaded = await ensureDefaultLoaded(panelId);
        await panelManager.notifyFocused(asPanelSlotId(panelId));
        emitTreeSnapshot();
        if (options.placement) {
          deps.eventService?.emit("navigate-to-panel", {
            panelId,
            ...(anchorPanelId ? { anchorPanelId } : {}),
            hint: options.placement,
            intentId: `focus:${randomUUID()}`,
          });
        }
        return { ...loaded, status: loaded.loaded ? "focused" : loaded.status, focused: true };
      }
      case "ensureLoaded": {
        const panelId = String(args[0]);
        return ensureDefaultLoaded(panelId);
      }
      case "getRuntimeLease": {
        await sync();
        const runtimeEntityId = await panelManager.getCurrentEntityId(
          asPanelSlotId(String(args[0]))
        );
        return deps.panelRuntimeCoordinator?.getLease(runtimeEntityId) ?? null;
      }
      case "getStateArgs": {
        await sync();
        const panel = registry.getPanel(String(args[0]));
        if (!panel) throw new Error(`Panel not found: ${String(args[0])}`);
        return (getPanelStateArgs(panel) ?? {}) as Record<string, unknown>;
      }
      case "setStateArgs": {
        const result = await panelManager.updateStateArgs(
          asPanelSlotId(String(args[0])),
          (args[1] ?? {}) as Record<string, unknown>
        );
        emitTreeSnapshot();
        return result;
      }
      case "close":
      case "archive": {
        const panelId = String(args[0]);
        const result = await panelManager.close(asPanelSlotId(String(args[0])));
        emitTreeSnapshot();
        return {
          panelId,
          operation: "close",
          status: "closed",
          loaded: false,
          rebuilt: false,
          reloaded: false,
          closedIds: Array.isArray((result as { closedIds?: unknown }).closedIds)
            ? (result as { closedIds: unknown[] }).closedIds
            : undefined,
        };
      }
      case "archiveOwnedRoots": {
        const userId = String(args[0]);
        if (!userId || userId === "system") {
          throw new Error("archiveOwnedRoots requires a revocable user id");
        }
        await sync({ force: true });
        const result = await panelManager.archiveOwnedRoots(userId);
        emitTreeSnapshot();
        return result;
      }
      case "unload": {
        const panelId = String(args[0]);
        const lease = deps.panelRuntimeCoordinator?.unloadSlot(panelId) ?? null;
        return {
          panelId,
          operation: "unload",
          status: lease ? "unloaded" : "already_unloaded",
          loaded: false,
          rebuilt: false,
          reloaded: false,
        };
      }
      case "movePanel": {
        const payload = (args[0] ?? {}) as {
          panelId?: unknown;
          newParentId?: unknown;
          targetPosition?: unknown;
        };
        const result = await panelManager.movePanel(
          asPanelSlotId(String(payload.panelId)),
          typeof payload.newParentId === "string" ? asPanelSlotId(payload.newParentId) : null,
          typeof payload.targetPosition === "number" ? payload.targetPosition : 0,
          // WP3 §10.1: the acting mover; the subtree re-owns to the destination
          // root's owner (or, on promote-to-root, to this mover).
          request.subject?.userId
        );
        emitTreeSnapshot();
        return result;
      }
      case "navigate": {
        const panelId = String(args[0]);
        const source = String(args[1]);
        const options = normalizePanelTreeNavigateOptions(args[2]);
        // Server is the sole writer: mutate WorkspaceDO here, then broadcast.
        // The hosting client reloads the panel's view reactively from the new
        // snapshot (no per-mutation host command).
        const result = await panelManager.navigate(asPanelSlotId(panelId), source, options);
        emitTreeSnapshot();
        return {
          id: result.panelId,
          title: result.title,
          kind: result.source.startsWith("browser:") ? "browser" : "workspace",
          source: result.source,
          contextId: result.contextId,
        };
      }
      case "historyTargetContext": {
        // Non-mutating peek for the context-boundary gate (panelTreeService) so
        // a cross-context back/forward is gated against its destination context.
        const panelId = String(args[0]);
        const delta = (args[1] === 1 ? 1 : -1) as -1 | 1;
        return panelManager.historyTargetContext(asPanelSlotId(panelId), delta);
      }
      case "navigateHistory": {
        const panelId = String(args[0]);
        const delta = (args[1] === 1 ? 1 : -1) as -1 | 1;
        // Server is the sole writer; the hosting client rebuilds the view from
        // this response (source/contextId) after refreshing its entity cache.
        const panel = await panelManager.navigateHistory(asPanelSlotId(panelId), delta);
        emitTreeSnapshot();
        if (!panel) return null;
        const snap = getCurrentSnapshot(panel);
        return { id: panel.id, title: panel.title, source: snap.source, contextId: snap.contextId };
      }
      case "updatePanelState":
        await panelManager.updatePanelState(
          asPanelSlotId(String(args[0])),
          normalizePanelNavigationState((args[1] ?? {}) as Record<string, unknown>)
        );
        emitTreeSnapshot();
        return;
      case "getCollapsedIds":
        return panelManager.getCollapsedIds();
      case "setCollapsed":
        await panelManager.setCollapsed(asPanelSlotId(String(args[0])), Boolean(args[1]));
        return;
      case "expandIds":
        await panelManager.expandIds(
          Array.isArray(args[0]) ? (args[0] as unknown[]).map((id) => String(id)) : []
        );
        return;
      case "reload": {
        const panelId = String(args[0]);
        const cdpBridge = await ensureHostCommandTargetReady(panelId);
        const result = await cdpBridge.sendHostCommand(panelId, "reloadPanel", []);
        emitTreeSnapshot();
        return result;
      }
      case "snapshot": {
        const panelId = String(args[0]);
        await sync();
        const panel = registry.getPanel(panelId);
        if (!panel) throw new Error(`Panel not found: ${panelId}`);
        const cdpBridge = await ensureHostCommandTargetReady(panelId);
        if (getPanelSource(panel).startsWith("browser:")) {
          return snapshotBrowserPanelFromCdpBridge(cdpBridge, panelId);
        }
        const runtimeEntityId = await panelManager.getCurrentEntityId(asPanelSlotId(panelId));
        const { server: rpcServer } = deps.container.get<{
          server: import("./rpcServer.js").RpcServer;
        }>("rpcServer");
        try {
          return await rpcServer.callTarget(runtimeEntityId, "_agent.snapshot", []);
        } catch {
          // Not every workspace panel exposes an in-process agent API. The
          // accessibility tree is the universal readable snapshot surface.
          return snapshotBrowserPanelFromCdpBridge(cdpBridge, panelId);
        }
      }
      case "callAgent": {
        const panelId = String(args[0]);
        await ensureDefaultLoaded(panelId);
        const runtimeEntityId = await panelManager.getCurrentEntityId(asPanelSlotId(panelId));
        const { server: rpcServer } = deps.container.get<{
          server: import("./rpcServer.js").RpcServer;
        }>("rpcServer");
        const agentMethod = String(args[1]);
        try {
          return await rpcServer.callTarget(
            runtimeEntityId,
            agentMethod,
            Array.isArray(args[2]) ? args[2] : []
          );
        } catch (error) {
          // The built-in inspection contract is a property of a hosted panel,
          // not of whether its application bundle happened to import the panel
          // runtime barrel early enough to expose `_agent.*`. Keep custom RPC
          // methods fail-loud, but provide universal host-backed fallbacks for
          // the standard handle inspection methods.
          if (!agentMethod.startsWith("_agent.")) throw error;
          const panel = registry.getPanel(panelId);
          if (!panel) throw error;
          const cdpBridge = await ensureHostCommandTargetReady(panelId);
          if (agentMethod === "_agent.snapshot" || agentMethod === "_agent.tree") {
            const snapshot = await snapshotBrowserPanelFromCdpBridge(cdpBridge, panelId);
            return agentMethod === "_agent.tree" ? snapshot.structure : snapshot;
          }
          if (agentMethod === "_agent.state") return {};
          if (agentMethod === "_agent.routes") {
            const snapshot = getCurrentSnapshot(panel);
            return {
              source: getPanelSource(panel),
              contextId: getPanelContextId(panel),
              ref: snapshot.options.ref ?? null,
            };
          }
          if (agentMethod === "_agent.setMode") {
            return {
              mode: Array.isArray(args[2]) ? args[2][0] : undefined,
              applied: false,
              reason: "panel runtime agent API is not exposed; inspection remains host-backed",
            };
          }
          throw error;
        }
      }
      case "takeOver": {
        if (request.callerKind !== "panel") {
          throw new Error("takeOver requires a panel caller with an active host lease");
        }
        const requesterLease = deps.panelRuntimeCoordinator?.getLease(request.callerId) ?? null;
        if (!requesterLease) {
          throw new Error("takeOver requires the caller panel to be loaded on a host");
        }
        const panelId = String(args[0]);
        await sync();
        const runtimeEntityId = await panelManager.getCurrentEntityId(asPanelSlotId(panelId));
        const result = deps.panelRuntimeCoordinator?.takeOver(runtimeEntityId, {
          slotId: panelId,
          clientSessionId: requesterLease.clientSessionId,
          hostConnectionId: requesterLease.hostConnectionId,
          connectionId: `takeover-${panelId}-${randomUUID()}`,
        });
        if (!result?.acquired) throw new Error(`Unable to take over panel ${panelId}`);
        await panelManager.notifyFocused(asPanelSlotId(panelId));
        emitTreeSnapshot();
        return {
          panelId,
          status: "taken_over",
          focused: true,
          loaded: true,
          holderLabel: result.lease.holderLabel,
        };
      }
      case "openDevTools": {
        const panelId = String(args[0]);
        const mode = args[1] === "right" || args[1] === "bottom" ? args[1] : "detach";
        const cdpBridge = await ensureHostCommandTargetReady(panelId);
        return cdpBridge.sendHostCommand(panelId, "openDevTools", [mode]);
      }
      case "rebuildPanel": {
        const panelId = String(args[0]);
        const cdpBridge = await ensureHostCommandTargetReady(panelId);
        return cdpBridge.sendHostCommand(panelId, "rebuildPanel", []);
      }
      case "rebuildAndReload": {
        const panelId = String(args[0]);
        const cdpBridge = await ensureHostCommandTargetReady(panelId);
        return cdpBridge.sendHostCommand(panelId, "rebuildAndReload", []);
      }
      default:
        throw new Error(`Unknown panelTree bridge method: ${method}`);
    }
  };

  // Every bridge request runs on the shared op-chain so mutations and the
  // self-heal reload never interleave (prevents mirror oscillation).
  return (request) => {
    // The panelTree service has already authorized the external caller. Its
    // bridge is a trusted product deputy for lower-level workspace-state and
    // runtime operations, so it must carry genuine host attestation rather
    // than relying on the cosmetic "server" caller kind. Preserve the acting
    // user separately for durable ownership attribution.
    const mediatedCaller = createHostCaller(request.callerId, "server", request.subject);
    return scheduleOperation("user", async () => {
      log.verbose(`Handling ${request.method} for ${request.callerId}`);
      const result = await callerContext.run(mediatedCaller, () => handleBridgeRequest(request));
      log.verbose(`Handled ${request.method} for ${request.callerId}`);
      return result;
    });
  };
}

export async function snapshotBrowserPanelFromCdpBridge(
  cdpBridge: Pick<CdpBridge, "isTargetRegistered" | "sendHostCommand">,
  panelId: string
): Promise<{ kind: "synth"; text: string; structure: unknown }> {
  if (!cdpBridge.isTargetRegistered(panelId)) {
    throw new Error(`target-not-loaded: ${panelId}`);
  }
  const snapshot = (await cdpBridge.sendHostCommand(panelId, "domSnapshot", [])) as {
    kind?: unknown;
    text?: unknown;
    structure?: unknown;
  };
  if (snapshot?.kind !== "synth" || typeof snapshot.text !== "string") {
    throw new Error("host returned an invalid DOM snapshot");
  }
  return { kind: "synth", text: snapshot.text, structure: snapshot.structure ?? null };
}
