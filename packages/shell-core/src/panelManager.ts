import * as path from "path";
import { createDevLogger } from "@vibestudio/dev-log";
import type { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import type {
  Panel,
  PanelNavigationState,
  PanelPlacementHint,
  PanelSnapshot,
  ThemeAppearance,
} from "@vibestudio/shared/types";
import type { PanelSearchIndex } from "@vibestudio/shared/panelSearchTypes";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import { loadPanelManifest } from "@vibestudio/shared/panelTypes";
import { validateStateArgs } from "@vibestudio/shared/stateArgsValidator";
import { computePanelId, panelIdSegmentFromName } from "@vibestudio/shared/panelIdUtils";
import {
  buildBootstrapConfig,
  browserSourceFromHostname,
  generateContextId,
  resolveSource,
} from "@vibestudio/shared/panelFactory";
import {
  browserUrlFromPanelSource,
  isOpenPanelBrowserUrl,
  panelSourceFromBrowserUrl,
} from "@vibestudio/shared/panelChrome";
import {
  createSnapshot,
  getCurrentSnapshot,
  getPanelContextId,
  getPanelOptions,
  getPanelSource,
  getPanelStateArgs,
  updatePanelNavigationState,
} from "@vibestudio/shared/panel/accessors";
import type { RuntimeCodePanelEntityCreateSpec } from "@vibestudio/shared/runtime/entitySpec";
import { asPanelEntityId, asPanelSlotId } from "@vibestudio/shared/panel/idValues";
import { normalizePanelTitle } from "@vibestudio/shared/panel/title";
import type { PanelEntityId, PanelSlotId } from "@vibestudio/shared/panel/idValues";
import type {
  RuntimeClient,
  SlotHistoryRow,
  WorkspaceStateClient,
} from "./workspaceStateClient.js";
import {
  commitPreparedPanelNavigation,
  type PanelNavigationCommitResult,
} from "./panelNavigationTransaction.js";
import { aboutPanelSource, isAboutSource } from "@vibestudio/workspace-contracts/aboutNamespace";

const log = createDevLogger("PanelManager");

/** A panel lifecycle failure with every causal error, portable to mobile
 * runtimes whose language baseline does not expose `AggregateError`. */
export class PanelLifecycleAggregateError extends Error {
  readonly errors: readonly unknown[];

  constructor(errors: readonly unknown[], message: string) {
    super(message);
    this.name = "PanelLifecycleAggregateError";
    this.errors = errors;
  }
}

function browserNavigationSource(source: string): string | null {
  const url = browserUrlFromPanelSource(source) ?? source;
  if (!isOpenPanelBrowserUrl(url)) return null;
  return panelSourceFromBrowserUrl(new URL(url).toString());
}

function panelExecutionForSource(source: string, ref?: string) {
  const browserUrl = browserUrlFromPanelSource(source);
  if (browserUrl !== null) {
    return { surface: "external" as const, url: browserUrl };
  }
  return { surface: "code" as const, source, ...(ref ? { ref } : {}) };
}

// =============================================================================
// Public API surfaces
// =============================================================================

export interface PanelManagerServerInfo {
  gatewayConfig: {
    serverUrl: string;
    token?: string;
    aliases?: readonly string[];
    workspace?: string;
  };
}

export interface PanelIncarnationChurnSnapshot {
  committed: number;
  retired: number;
  retirementFailures: number;
  outstanding: number;
  byCause: Readonly<Record<"create" | "navigate" | "history" | "replace", number>>;
}

export interface CreatePanelOptions {
  parentId?: PanelSlotId;
  /** Display title, overriding the manifest's. Free text; carries no identity. */
  title?: string;
  /**
   * Opt-in stable id segment, making the panel `{parentId}/{slug}`. The caller
   * owns uniqueness: a second panel with the same parent and slug is rejected.
   * Never derive it from a title or other user-controlled text.
   */
  slug?: string;
  contextId?: string;
  env?: Record<string, string>;
  ref?: string;
  stateArgs?: Record<string, unknown>;
  isRoot?: boolean;
  addAsRoot?: boolean;
  autoArchiveWhenEmpty?: boolean;
  /** Per-call layout placement hint; wins over the manifest's `placement`. */
  placement?: PanelPlacementHint;
  /**
   * Owning-user id (WP3) — the creating caller's verified `subject.userId`.
   * Stamped onto the slot + the in-memory panel so the new
   * tree groups under its owner. Absent for system/bootstrap seeds.
   */
  ownerUserId?: string;
}

export interface CreatePanelResult {
  panelId: PanelSlotId;
  contextId: string;
  source: string;
  title: string;
  stateArgs: Record<string, unknown>;
  options: Record<string, unknown>;
  autoArchiveWhenEmpty?: boolean;
  privileged?: boolean;
}

export interface NavigatePanelOptions {
  contextId?: string;
  env?: Record<string, string>;
  ref?: string;
  stateArgs?: Record<string, unknown>;
}

export interface ActivationClient {
  markPanelActive(panelId: PanelSlotId): Promise<void>;
}

export interface LocalPanelViewState {
  collapsedIds: string[];
  focusedPanelId?: string | null;
  panelTitles?: Record<string, { source: string; title: string }>;
}

export interface LocalPanelViewStateStore {
  load(): Promise<LocalPanelViewState | null> | LocalPanelViewState | null;
  save(state: LocalPanelViewState): Promise<void> | void;
}

export interface PanelMetadata {
  title?: string;
}

export interface PanelMetadataResolver {
  getPanelMetadata(source: string): Promise<PanelMetadata | null> | PanelMetadata | null;
}

export interface PanelManagerDeps {
  registry: PanelRegistry;
  workspaceState: WorkspaceStateClient;
  runtime: RuntimeClient;
  activationClient?: ActivationClient;
  viewState?: LocalPanelViewStateStore;
  metadataResolver?: PanelMetadataResolver;
  serverInfo: PanelManagerServerInfo;
  workspacePath: string;
  searchIndex?: PanelSearchIndex | null;
  workspaceConfig?: WorkspaceConfig;
  allowMissingManifests?: boolean;
  /**
   * Optional token issuer used to obtain a per-panel WS auth token when
   * building the bootstrap config delivered to a freshly mounted view.
   * Implementations should call into the shell's auth service.
   */
  grantConnection?(panelId: PanelEntityId): Promise<{ token: string }>;
}

export interface PanelOperationClients {
  workspaceState: WorkspaceStateClient;
  runtime: RuntimeClient;
}

// =============================================================================
// Helpers
// =============================================================================

function mintHistoryEntryKey(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return `nav-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

// =============================================================================
// PanelManager
// =============================================================================

export class PanelManager {
  private static readonly MAX_RUNTIME_PANEL_CACHE = 256;
  private readonly stateArgsSubscribers = new Map<
    string,
    Set<(stateArgs: Record<string, unknown>) => void>
  >();
  private readonly registry: PanelRegistry;
  private readonly workspaceState: WorkspaceStateClient;
  private readonly runtime: RuntimeClient;
  private readonly activationClient?: ActivationClient;
  private readonly viewState?: LocalPanelViewStateStore;
  private readonly metadataResolver?: PanelMetadataResolver;
  private readonly serverInfo: PanelManagerServerInfo;
  private readonly workspacePath: string;
  private readonly searchIndex: PanelSearchIndex | null;
  private readonly workspaceConfig?: WorkspaceConfig;
  private readonly allowMissingManifests: boolean;
  private readonly grantConnectionImpl?: (panelId: PanelEntityId) => Promise<{ token: string }>;

  private readonly collapsedIds = new Set<string>();
  private readonly localPanelTitles = new Map<string, { source: string; title: string }>();
  private currentTheme: "light" | "dark" = "dark";
  private viewStateLoaded = false;
  /**
   * Mirrors the slot's current panelEntityId by slotId. Tracks the *currently
   * active* panel entity per slot — what gets retired on the next navigation.
   * Kept in sync with the local registry after every navigation / sync.
   */
  private readonly currentEntityBySlot = new Map<PanelSlotId, PanelEntityId>();
  private readonly currentEntitySourceBySlot = new Map<
    PanelSlotId,
    { repoPath: string; effectiveVersion: string }
  >();
  private readonly runtimePanelLru = new Map<PanelSlotId, number>();
  private runtimePanelClock = 0;
  private readonly incarnationChurn = {
    committed: 0,
    retired: 0,
    retirementFailures: 0,
    byCause: { create: 0, navigate: 0, history: 0, replace: 0 },
  };

  constructor(deps: PanelManagerDeps) {
    this.registry = deps.registry;
    this.workspaceState = deps.workspaceState;
    this.runtime = deps.runtime;
    this.activationClient = deps.activationClient;
    this.viewState = deps.viewState;
    this.metadataResolver = deps.metadataResolver;
    this.serverInfo = deps.serverInfo;
    this.workspacePath = deps.workspacePath;
    this.searchIndex = deps.searchIndex ?? null;
    this.workspaceConfig = deps.workspaceConfig;
    this.allowMissingManifests = deps.allowMissingManifests ?? false;
    this.grantConnectionImpl = deps.grantConnection;
  }

  getIncarnationChurnSnapshot(): PanelIncarnationChurnSnapshot {
    return {
      ...this.incarnationChurn,
      outstanding: this.incarnationChurn.committed - this.incarnationChurn.retired,
      byCause: { ...this.incarnationChurn.byCause },
    };
  }

  private recordIncarnationCommit(cause: keyof PanelIncarnationChurnSnapshot["byCause"]): void {
    this.incarnationChurn.committed += 1;
    this.incarnationChurn.byCause[cause] += 1;
    if (this.incarnationChurn.committed % 25 === 0) this.logIncarnationChurn();
  }

  private recordIncarnationRetirement(failed: boolean): void {
    if (failed) {
      this.incarnationChurn.retirementFailures += 1;
      this.logIncarnationChurn();
      return;
    }
    this.incarnationChurn.retired += 1;
  }

  private logIncarnationChurn(): void {
    log.verbose(`Panel incarnation churn ${JSON.stringify(this.getIncarnationChurnSnapshot())}`);
  }

  async loadViewState(): Promise<{
    collapsedIds: string[];
    revision: number;
    preparingSlotIds: PanelSlotId[];
  }> {
    await this.ensureViewStateLoaded();
    await this.drainCloseCleanup({}, false);
    return {
      collapsedIds: [...this.collapsedIds],
      revision: 0,
      preparingSlotIds: [],
    };
  }

  /** Whether durable query state already contains a root for this source. */
  async hasRootPanelSource(source: string): Promise<boolean> {
    let groupCursor: string | undefined;
    do {
      const groups = await this.workspaceState.getPanelTreeRootGroups({
        cursor: groupCursor,
        limit: 200,
      });
      for (const group of groups.groups) {
        let nodeCursor: string | undefined;
        do {
          const page = await this.workspaceState.getPanelTreePage({
            group: { kind: "roots", ownerUserId: group.ownerUserId },
            cursor: nodeCursor,
            limit: 200,
          });
          if (page.nodes.some((node) => node.source === source)) return true;
          nodeCursor = page.nextCursor ?? undefined;
        } while (nodeCursor);
      }
      groupCursor = groups.nextCursor ?? undefined;
    } while (groupCursor);
    return false;
  }

  // ===========================================================================
  // Create
  // ===========================================================================

  async createExecution(
    execution:
      | { surface: "code"; source: string; ref?: string }
      | { surface: "external"; url: string },
    opts?: CreatePanelOptions,
    clients?: PanelOperationClients
  ): Promise<CreatePanelResult & { url?: string }> {
    if (execution.surface === "external") {
      return this.createExternalPanel(
        opts?.parentId ?? null,
        execution.url,
        {
          title: opts?.title,
          slug: opts?.slug,
          contextId: opts?.contextId,
          addAsRoot: opts?.addAsRoot,
          ownerUserId: opts?.ownerUserId,
        },
        clients
      );
    }
    return this.createCodePanel(
      execution.source,
      {
        ...opts,
        ...(execution.ref ? { ref: execution.ref } : {}),
      },
      clients
    );
  }

  async create(
    source: string,
    opts?: CreatePanelOptions,
    clients?: PanelOperationClients
  ): Promise<CreatePanelResult> {
    return this.createExecution(
      { surface: "code", source, ...(opts?.ref ? { ref: opts.ref } : {}) },
      opts,
      clients
    );
  }

  private async createCodePanel(
    source: string,
    opts?: CreatePanelOptions,
    clients?: PanelOperationClients
  ): Promise<CreatePanelResult> {
    const workspaceState = clients?.workspaceState ?? this.workspaceState;
    const runtime = clients?.runtime ?? this.runtime;
    const { relativePath, absolutePath } = resolveSource(source, this.workspacePath);
    const allowMissing = Boolean(opts?.contextId) || this.allowMissingManifests;
    const manifest = this.resolveManifest(absolutePath, relativePath, allowMissing);
    const validatedStateArgs = this.validateManifestStateArgs(
      relativePath,
      manifest.stateArgs,
      opts?.stateArgs
    );

    // Identity comes from `slug` alone. `name`/`title` are labels: deriving an
    // id from them made ids collide whenever two panels shared a title.
    const slotId = asPanelSlotId(
      computePanelId({
        relativePath,
        parent: opts?.parentId ? { id: opts.parentId } : null,
        requestedId: opts?.slug ? panelIdSegmentFromName(opts.slug) : undefined,
        isRoot: opts?.isRoot,
      })
    );
    if (opts?.slug && this.registry.getPanel(slotId)) {
      throw new Error(
        `Panel id already in use: ${slotId}. A slug must be unique among its parent's children.`
      );
    }
    const displayTitle =
      normalizePanelTitle(opts?.title) ?? normalizePanelTitle(manifest.title) ?? relativePath;
    const historyEntryKey = mintHistoryEntryKey();
    const stateArgsPayload = validatedStateArgs ?? {};

    const entitySpec: RuntimeCodePanelEntityCreateSpec = {
      kind: "panel",
      execution: { surface: "code", source: relativePath, ...(opts?.ref ? { ref: opts.ref } : {}) },
      key: historyEntryKey,
      ...(opts?.contextId ? { contextId: opts.contextId } : {}),
      stateArgs: stateArgsPayload,
    };
    const handle = await runtime.reserveEntity(entitySpec);
    const entityId = asPanelEntityId(handle.id);
    const contextId = handle.contextId;

    // Effective placement hint: call-site override wins, else the manifest's
    // declared default. Resolved after reservation because the runtime owns
    // fresh panel-context allocation and returns its durable coordinate.
    const placement = opts?.placement ?? manifest.placement;
    const snapshot = createSnapshot(
      relativePath,
      contextId,
      { env: opts?.env, ref: opts?.ref, ...(placement ? { placement } : {}) },
      validatedStateArgs
    );
    if (opts?.autoArchiveWhenEmpty || manifest.autoArchiveWhenEmpty) {
      snapshot.autoArchiveWhenEmpty = true;
    }
    if (manifest.privileged) {
      snapshot.privileged = true;
    }

    try {
      await workspaceState.createSlot({
        slotId,
        parentSlotId: opts?.parentId ?? null,
        initialEntry: {
          entryKey: historyEntryKey,
          entityId,
          source: relativePath,
          contextId,
          stateArgs: stateArgsPayload,
          options: snapshot.options,
        },
      });
    } catch (error) {
      try {
        await runtime.retireEntity(handle.id);
      } catch (cleanupError) {
        throw new PanelLifecycleAggregateError(
          [error, cleanupError],
          `Panel creation failed and entity cleanup also failed for ${handle.id}`
        );
      }
      throw error;
    }
    this.recordIncarnationCommit("create");

    this.currentEntityBySlot.set(slotId, entityId);
    this.currentEntitySourceBySlot.set(slotId, handle.source);

    const panel: Panel = {
      id: slotId,
      title: displayTitle,
      runtimeEntityId: entityId,
      effectiveVersion: handle.source.effectiveVersion,
      buildKey: handle.buildKey ?? null,
      executionDigest: handle.executionDigest ?? null,
      authorityRequests: handle.authorityRequests,
      ...(opts?.ownerUserId ? { owner: opts.ownerUserId } : {}),
      children: [],
      snapshot,
      history: { entries: [snapshot], index: 0 },
      artifacts: { buildState: "pending", buildProgress: "Preparing panel runtime..." },
    };
    this.registry.addPanel(panel, null, { addAsRoot: true });
    this.touchRuntimePanel(slotId);

    this.indexPanel(slotId, displayTitle, relativePath);

    return {
      panelId: slotId,
      contextId,
      source: relativePath,
      title: displayTitle,
      stateArgs: stateArgsPayload,
      options: { env: opts?.env ?? {}, ...(opts?.ref ? { ref: opts.ref } : {}) },
      autoArchiveWhenEmpty: snapshot.autoArchiveWhenEmpty,
      privileged: snapshot.privileged,
    };
  }

  async createBrowser(
    parentId: PanelSlotId | null,
    url: string,
    opts?: {
      title?: string;
      slug?: string;
      name?: string;
      contextId?: string;
      addAsRoot?: boolean;
      ownerUserId?: string;
    },
    clients?: PanelOperationClients
  ): Promise<CreatePanelResult & { url: string }> {
    return this.createExecution(
      { surface: "external", url },
      {
        parentId: parentId ?? undefined,
        isRoot: parentId == null,
        title: opts?.title,
        slug: opts?.slug,
        contextId: opts?.contextId,
        addAsRoot: opts?.addAsRoot,
        ownerUserId: opts?.ownerUserId,
      },
      clients
    ) as Promise<CreatePanelResult & { url: string }>;
  }

  private async createExternalPanel(
    parentId: PanelSlotId | null,
    url: string,
    opts?: {
      /** Display title until the page reports its own. Carries no identity. */
      title?: string;
      /** Opt-in stable id segment; must be unique among the parent's children. */
      slug?: string;
      /** Existing semantic context to share; omitted mints an isolated context. */
      contextId?: string;
      addAsRoot?: boolean;
      ownerUserId?: string;
    },
    clients?: PanelOperationClients
  ): Promise<CreatePanelResult & { url: string }> {
    const workspaceState = clients?.workspaceState ?? this.workspaceState;
    const runtime = clients?.runtime ?? this.runtime;
    if (typeof url !== "string" || !isOpenPanelBrowserUrl(url)) {
      throw new Error(
        `Invalid browser panel URL (must be http/https, data:, or about:blank string): ${String(
          url
        )}`
      );
    }
    const parsed = new URL(url);
    const normalizedSource = browserSourceFromHostname(
      parsed.hostname || parsed.protocol.replace(/:$/, "") || "browser"
    );
    const slotId = asPanelSlotId(
      computePanelId({
        relativePath: normalizedSource,
        parent: parentId ? { id: parentId } : null,
        // Identity from `slug` only: page titles duplicate constantly, so
        // deriving ids from them collided (two "New Tab"s under one parent).
        requestedId: opts?.slug ? panelIdSegmentFromName(opts.slug) : undefined,
        isRoot: parentId == null,
      })
    );
    if (opts?.slug && this.registry.getPanel(slotId)) {
      throw new Error(
        `Panel id already in use: ${slotId}. A slug must be unique among its parent's children.`
      );
    }
    const contextId = opts?.contextId?.trim() || generateContextId(slotId);
    const historyEntryKey = mintHistoryEntryKey();
    const browserSource = `browser:${url}`;

    const snapshot = createSnapshot(browserSource, contextId, {});

    const handle = await runtime.createEntity({
      kind: "panel",
      execution: { surface: "external", url },
      key: historyEntryKey,
      contextId,
    });
    const entityId = asPanelEntityId(handle.id);

    try {
      await workspaceState.createSlot({
        slotId,
        parentSlotId: parentId,
        initialEntry: {
          entryKey: historyEntryKey,
          entityId,
          source: browserSource,
          contextId,
          stateArgs: {},
          options: snapshot.options,
        },
      });
    } catch (error) {
      try {
        await runtime.retireEntity(handle.id);
      } catch (cleanupError) {
        throw new PanelLifecycleAggregateError(
          [error, cleanupError],
          `Panel creation failed and entity cleanup also failed for ${handle.id}`
        );
      }
      throw error;
    }

    this.currentEntityBySlot.set(slotId, entityId);
    this.currentEntitySourceBySlot.set(slotId, handle.source);

    const title =
      normalizePanelTitle(opts?.title) ??
      normalizePanelTitle(parsed.hostname) ??
      normalizePanelTitle(parsed.protocol.replace(/:$/, "")) ??
      "browser";
    const panel: Panel = {
      id: slotId,
      title,
      runtimeEntityId: entityId,
      effectiveVersion: handle.source.effectiveVersion,
      buildKey: handle.buildKey ?? null,
      executionDigest: handle.executionDigest ?? null,
      ...(opts?.ownerUserId ? { owner: opts.ownerUserId } : {}),
      children: [],
      snapshot,
      history: { entries: [snapshot], index: 0 },
      artifacts: { buildState: "ready", htmlPath: url },
    };
    this.registry.addPanel(panel, null, { addAsRoot: true });
    this.touchRuntimePanel(slotId);
    this.indexPanel(slotId, title, browserSource);

    return {
      panelId: slotId,
      contextId,
      source: browserSource,
      title,
      url,
      stateArgs: {},
      options: {},
    };
  }

  async createFromSource(
    source: string,
    options?: { name?: string; stateArgs?: Record<string, unknown> }
  ): Promise<{ id: string; title: string }> {
    const result = await this.create(source, {
      stateArgs: options?.stateArgs,
      isRoot: true,
      addAsRoot: true,
    });
    return { id: result.panelId, title: result.title };
  }

  async createAboutPanel(page: string): Promise<{ id: string; title: string }> {
    const result = await this.create(aboutPanelSource(page), {
      isRoot: true,
      addAsRoot: true,
    });
    return { id: result.panelId, title: result.title };
  }

  // ===========================================================================
  // Close
  // ===========================================================================

  async close(
    slotId: PanelSlotId,
    options: { strict?: boolean } = {},
    clients?: PanelOperationClients
  ): Promise<{ closedCount: number }> {
    const workspaceState = clients?.workspaceState ?? this.workspaceState;
    await this.drainCloseCleanup({}, false, clients);
    const closed = await workspaceState.closeSlot(slotId);
    await this.drainCloseCleanup({ closeId: closed.closeId }, options.strict === true, clients);
    return { closedCount: closed.closedCount };
  }

  private async drainCloseCleanup(
    filter: { closeId?: string; ownerUserId?: string | null },
    strict: boolean,
    clients?: PanelOperationClients
  ): Promise<number> {
    const workspaceState = clients?.workspaceState ?? this.workspaceState;
    const runtime = clients?.runtime ?? this.runtime;
    let cursor: string | undefined;
    let cleanedCount = 0;
    do {
      const page = await workspaceState.getCloseCleanupPage({
        ...filter,
        ...(cursor ? { cursor } : {}),
        limit: 200,
      });
      const acknowledged: PanelSlotId[] = [];
      for (const { slotId: id, entityId } of page.items) {
        try {
          if (entityId) await runtime.retireEntity(entityId);
          acknowledged.push(id);
          cleanedCount += 1;
        } catch (error) {
          if (strict && acknowledged.length > 0) {
            await workspaceState.acknowledgeCloseCleanup(acknowledged);
          }
          if (strict) throw error;
          log.warn(
            `Failed to retire panel entity ${entityId ?? "(none)"} for slot ${id}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        } finally {
          if (this.registry.getPanel(id)) this.registry.removePanel(id);
          this.currentEntityBySlot.delete(id);
          this.currentEntitySourceBySlot.delete(id);
          this.runtimePanelLru.delete(id);
        }
      }
      if (acknowledged.length > 0) {
        await workspaceState.acknowledgeCloseCleanup(acknowledged);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return cleanedCount;
  }

  /**
   * Idempotently archive every open root owned by one account. Strict mode is
   * intentional: revocation cleanup is acknowledged/retried by the hub and may
   * never report success after silently skipping a runtime or durable slot.
   * Other owners' roots are never traversed or modified.
   */
  async archiveOwnedRoots(
    ownerUserId: string
  ): Promise<{ archivedRootCount: number; closedCount: number }> {
    await this.drainCloseCleanup({ ownerUserId }, true);
    let archivedRootCount = 0;
    let closedCount = 0;
    let cursor: string | undefined;
    do {
      const page = await this.workspaceState.getPanelTreePage({
        group: { kind: "roots", ownerUserId },
        ...(cursor ? { cursor } : {}),
        limit: 200,
      });
      for (const node of page.nodes) {
        const result = await this.close(asPanelSlotId(node.slotId), { strict: true });
        archivedRootCount += 1;
        closedCount += result.closedCount;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return { archivedRootCount, closedCount };
  }

  // ===========================================================================
  // Mutate (state-args / snapshot / navigate / history)
  // ===========================================================================

  getInfo(slotId: PanelSlotId): unknown {
    return this.registry.getInfo(slotId);
  }

  async getPanel(slotId: PanelSlotId): Promise<Panel | null> {
    try {
      return await this.requireStoredPanel(slotId);
    } catch {
      return null;
    }
  }

  /** Refresh one bounded runtime projection from durable query state. */
  async refreshPanel(slotId: PanelSlotId): Promise<Panel | null> {
    try {
      return await this.requireStoredPanel(slotId, true);
    } catch {
      return null;
    }
  }

  onStateArgsChanged(
    slotId: PanelSlotId,
    callback: (stateArgs: Record<string, unknown>) => void
  ): () => void {
    const subscribers = this.stateArgsSubscribers.get(slotId) ?? new Set();
    subscribers.add(callback);
    this.stateArgsSubscribers.set(slotId, subscribers);
    return () => {
      subscribers.delete(callback);
      if (subscribers.size === 0) this.stateArgsSubscribers.delete(slotId);
    };
  }

  async updateStateArgs(
    slotId: PanelSlotId,
    updates: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const panel = await this.requireStoredPanel(slotId);
    const schema = this.loadPanelSchema(panel);
    const merged = Object.fromEntries(
      Object.entries({ ...(getPanelStateArgs(panel) ?? {}), ...updates }).filter(
        ([, value]) => value !== null
      )
    );
    const validation = validateStateArgs(merged, schema);
    if (!validation.success) {
      throw new Error(`Invalid stateArgs: ${validation.error}`);
    }
    const nextStateArgs = validation.data as Record<string, unknown>;
    await this.workspaceState.updateCurrentStateArgs(slotId, nextStateArgs);
    const livePanel = this.registry.getPanel(slotId);
    if (livePanel) {
      const currentSnapshot = getCurrentSnapshot(livePanel);
      const nextSnapshot: PanelSnapshot = {
        ...currentSnapshot,
        stateArgs: nextStateArgs,
      };
      const history = livePanel.history ?? { entries: [currentSnapshot], index: 0 };
      const entries = history.entries.slice();
      entries[history.index] = nextSnapshot;
      this.registry.replaceCurrentSnapshot(slotId, nextSnapshot, {
        entries,
        index: history.index,
      });
    }
    this.notifyStateArgsSubscribers(slotId, nextStateArgs);
    return nextStateArgs;
  }

  /**
   * Apply an authoritative state-args snapshot to this manager's bounded
   * runtime projection without writing it back to durable workspace state.
   */
  applyStateArgsProjection(slotId: PanelSlotId, stateArgs: Record<string, unknown>): void {
    this.registry.updateStateArgs(slotId, stateArgs);
    this.notifyStateArgsSubscribers(slotId, stateArgs);
  }

  private notifyStateArgsSubscribers(
    slotId: PanelSlotId,
    stateArgs: Record<string, unknown>
  ): void {
    for (const callback of this.stateArgsSubscribers.get(slotId) ?? []) {
      callback(stateArgs);
    }
  }

  /**
   * Identity is immutable: mint a new historyEntryKey, retire the old panel
   * entity, create a new one, and replace the current cursor's history entry
   * in-place (overwrite, do not append).
   */
  async replaceCurrentSnapshot(
    slotId: PanelSlotId,
    updates: { contextId?: string; source?: string; stateArgs?: Record<string, unknown> }
  ): Promise<void> {
    const panel = await this.requireStoredPanel(slotId);
    const currentSnapshot = getCurrentSnapshot(panel);
    const nextSource = updates.source ?? currentSnapshot.source;
    const nextContextId = updates.contextId ?? currentSnapshot.contextId;
    const nextStateArgs =
      updates.stateArgs !== undefined
        ? updates.stateArgs
        : ((currentSnapshot.stateArgs ?? {}) as Record<string, unknown>);

    const nextSnapshot: PanelSnapshot = {
      ...currentSnapshot,
      source: nextSource,
      contextId: nextContextId,
      stateArgs: nextStateArgs,
    };
    if (updates.source) {
      const manifest = this.tryResolveManifestForSource(updates.source);
      if (manifest?.autoArchiveWhenEmpty) nextSnapshot.autoArchiveWhenEmpty = true;
      else delete nextSnapshot.autoArchiveWhenEmpty;
      if (manifest?.privileged) nextSnapshot.privileged = true;
      else delete nextSnapshot.privileged;
    }

    await this.replaceHistoryAtCurrent(slotId, panel, nextSnapshot);
  }

  async navigate(
    slotId: PanelSlotId,
    source: string,
    opts?: NavigatePanelOptions,
    clients?: PanelOperationClients
  ): Promise<CreatePanelResult> {
    const workspaceState = clients?.workspaceState ?? this.workspaceState;
    const runtime = clients?.runtime ?? this.runtime;
    const panel = await this.requireStoredPanel(slotId);
    const nextSnapshot = this.createNavigationSnapshot(panel, source, opts);
    const title = this.titleFor(slotId, nextSnapshot.source);

    const previousEntityId = await this.resolveCurrentEntityIdForSlot(slotId);

    const historyEntryKey = mintHistoryEntryKey();
    const stateArgsPayload = (nextSnapshot.stateArgs ?? {}) as Record<string, unknown>;
    const handle = await runtime.createEntity({
      kind: "panel",
      execution: panelExecutionForSource(nextSnapshot.source, nextSnapshot.options.ref),
      key: historyEntryKey,
      contextId: nextSnapshot.contextId,
      stateArgs: stateArgsPayload,
    });
    const entityId = asPanelEntityId(handle.id);

    const transition = await commitPreparedPanelNavigation(
      { runtime, workspaceState },
      {
        slotId,
        expectedCurrentEntityId: previousEntityId,
        mutation: {
          kind: "append",
          entry: {
            entryKey: historyEntryKey,
            entityId,
            source: nextSnapshot.source,
            contextId: nextSnapshot.contextId,
            stateArgs: stateArgsPayload,
            options: nextSnapshot.options,
          },
        },
      }
    );
    this.recordIncarnationCommit("navigate");
    this.recordNavigationRetirement(transition, "navigate");

    this.currentEntityBySlot.set(slotId, entityId);
    this.currentEntitySourceBySlot.set(slotId, handle.source);

    const livePanel = this.registry.getPanel(slotId);
    if (livePanel) {
      livePanel.title = title;
      livePanel.runtimeEntityId = entityId;
      livePanel.effectiveVersion = handle.source.effectiveVersion;
      livePanel.buildKey = handle.buildKey ?? null;
      livePanel.executionDigest = handle.executionDigest ?? null;
      livePanel.authorityRequests = handle.authorityRequests;
      this.registry.replaceCurrentSnapshot(slotId, nextSnapshot, {
        entries: [nextSnapshot],
        index: 0,
      });
      livePanel.navigation = { canGoBack: transition.cursor > 0, canGoForward: false };
    }

    this.indexPanel(slotId, title, nextSnapshot.source);

    return {
      panelId: slotId,
      contextId: nextSnapshot.contextId,
      source: nextSnapshot.source,
      title,
      stateArgs: stateArgsPayload,
      options: nextSnapshot.options,
      autoArchiveWhenEmpty: nextSnapshot.autoArchiveWhenEmpty,
      privileged: nextSnapshot.privileged,
    };
  }

  /**
   * Non-mutating peek: the context the panel WOULD move into for a history
   * back/forward. The panel-tree service resolves this before the bridge so the
   * context-boundary gate sees the destination context (a panel's history can
   * span foreign contexts). Returns null when the move is a no-op.
   */
  async historyTargetContext(slotId: PanelSlotId, delta: -1 | 1): Promise<string | null> {
    const target = await this.workspaceState.getRelativeSlotHistory(slotId, delta);
    return target?.context_id ?? null;
  }

  async navigateHistory(
    slotId: PanelSlotId,
    delta: -1 | 1,
    clients?: PanelOperationClients
  ): Promise<Panel | null> {
    const workspaceState = clients?.workspaceState ?? this.workspaceState;
    const runtime = clients?.runtime ?? this.runtime;
    const before = await this.requireStoredPanel(slotId);
    const target = await workspaceState.getRelativeSlotHistory(slotId, delta);
    if (!target) return before;
    const targetSnapshot = this.snapshotFromHistoryRow(target);
    const targetEntryKey = target.entry_key;
    const targetEntityId = target.entity_id;
    const currentEntityId = await this.resolveCurrentEntityIdForSlot(slotId);

    // Reactivate (or no-op for the same identity).
    const stateArgsPayload = (targetSnapshot.stateArgs ?? {}) as Record<string, unknown>;
    const handle = await runtime.createEntity({
      kind: "panel",
      execution: panelExecutionForSource(targetSnapshot.source, targetSnapshot.options.ref),
      key: targetEntryKey,
      contextId: targetSnapshot.contextId,
      stateArgs: stateArgsPayload,
    });
    const entityId = asPanelEntityId(handle.id);
    if (entityId !== targetEntityId) {
      throw new Error(
        `Prepared history entity mismatch: expected ${targetEntityId}, received ${entityId}`
      );
    }
    const transition = await commitPreparedPanelNavigation(
      { runtime, workspaceState },
      {
        slotId,
        expectedCurrentEntityId: currentEntityId,
        mutation: { kind: "select", entryKey: targetEntryKey },
      }
    );
    this.recordIncarnationCommit("history");
    this.recordNavigationRetirement(transition, "history navigate");
    this.currentEntityBySlot.set(slotId, entityId);
    this.currentEntitySourceBySlot.set(slotId, handle.source);

    const livePanel = this.registry.getPanel(slotId);
    if (livePanel) {
      livePanel.runtimeEntityId = entityId;
      livePanel.effectiveVersion = handle.source.effectiveVersion;
      livePanel.buildKey = handle.buildKey ?? null;
      livePanel.executionDigest = handle.executionDigest ?? null;
      livePanel.authorityRequests = handle.authorityRequests;
      this.registry.replaceCurrentSnapshot(slotId, targetSnapshot);
      livePanel.navigation = {
        canGoBack: target.cursor > 0,
        canGoForward: Boolean(await workspaceState.getRelativeSlotHistory(slotId, 1)),
      };
    }
    const result = this.registry.getPanel(slotId) ?? null;
    return result;
  }

  async updateTitle(slotId: PanelSlotId, title: string | null): Promise<void> {
    await this.ensureViewStateLoaded();
    const livePanel = this.registry.getPanel(slotId);
    const normalized = normalizePanelTitle(title);
    if (livePanel) {
      const source = getPanelSource(livePanel);
      if (normalized) {
        livePanel.title = normalized;
        this.localPanelTitles.set(slotId, { source, title: normalized });
      } else {
        this.localPanelTitles.delete(slotId);
        livePanel.title = this.titleFor(slotId, source);
      }
    }
    this.searchIndex?.updateTitle(slotId, normalized ?? "");
    await this.persistViewState();
    this.registry.notifyPanelTreeUpdate(slotId);
  }

  async updatePanelState(slotId: PanelSlotId, state: PanelNavigationState): Promise<void> {
    const livePanel = this.registry.getPanel(slotId);
    if (!livePanel) return;

    updatePanelNavigationState(livePanel, state);

    if (state.pageTitle !== undefined) {
      await this.ensureViewStateLoaded();
      const normalized = normalizePanelTitle(state.pageTitle);
      if (normalized) {
        this.localPanelTitles.set(slotId, {
          source: getPanelSource(livePanel),
          title: normalized,
        });
        livePanel.title = normalized;
      } else {
        this.localPanelTitles.delete(slotId);
        livePanel.title = this.titleFor(slotId, getPanelSource(livePanel));
      }
      this.searchIndex?.updateTitle(slotId, normalized ?? "");
      await this.persistViewState();
    }

    this.registry.notifyPanelTreeUpdate(slotId);
  }

  async movePanel(
    slotId: PanelSlotId,
    newParentId: PanelSlotId | null,
    placement?: { beforeSlotId?: PanelSlotId | null; afterSlotId?: PanelSlotId | null },
    _ownerUserId?: string
  ): Promise<void> {
    await this.workspaceState.moveSlot(slotId, newParentId, placement);
  }

  async setCollapsed(slotId: PanelSlotId, collapsed: boolean): Promise<void> {
    await this.ensureViewStateLoaded();
    if (collapsed) this.collapsedIds.add(slotId);
    else this.collapsedIds.delete(slotId);
    this.registry.setCollapsed(slotId, collapsed);
    await this.persistViewState();
  }

  async expandIds(slotIds: string[]): Promise<void> {
    await this.ensureViewStateLoaded();
    for (const slotId of slotIds) this.collapsedIds.delete(slotId);
    this.registry.setCollapsedBatch(slotIds, false);
    await this.persistViewState();
  }

  async getCollapsedIds(): Promise<string[]> {
    await this.ensureViewStateLoaded();
    return [...this.collapsedIds];
  }

  async notifyFocused(slotId: PanelSlotId): Promise<void> {
    await this.ensureViewStateLoaded();
    this.registry.updateSelectedPath(slotId);
    await this.persistViewState();
    this.searchIndex?.incrementAccessCount(slotId);
    await this.activationClient?.markPanelActive(slotId);
  }

  setCurrentTheme(theme: ThemeAppearance): void {
    const appearance = theme === "dark" ? "dark" : "light";
    this.currentTheme = appearance;
    this.registry.setCurrentTheme(appearance);
  }

  getCurrentTheme(): "light" | "dark" {
    return this.currentTheme;
  }

  getWorkspaceConfig(): WorkspaceConfig | undefined {
    return this.workspaceConfig;
  }

  listPanels() {
    return this.registry.listPanels();
  }

  async getPanelInit(slotId: PanelSlotId): Promise<unknown> {
    // Bootstrap is also the rehydration boundary for an existing renderer.
    // Always refresh the addressed slot from durable state here so a reload
    // cannot resurrect an older local projection (for example, a terminal
    // layout saved just before the renderer was restarted).
    const panel = await this.requireStoredPanel(slotId, true);
    const storedSlot = await this.workspaceState.getSlot(slotId);
    const parentId = storedSlot?.parent_slot_id ?? null;
    const parentEntityId = parentId
      ? (this.currentEntityBySlot.get(parentId) ??
        (await this.resolveCurrentEntityIdForSlot(parentId)))
      : null;
    // The grant is bound to the panel's current ENTITY id (panel:<historyEntryKey>),
    // not the slotId — that's what `connectionGrants` validates against the
    // entity cache, and what the panel uses as its RPC `caller.runtime.id`.
    const entityId =
      this.currentEntityBySlot.get(slotId) ?? (await this.resolveCurrentEntityIdForSlot(slotId));
    const token = this.grantConnectionImpl
      ? (await this.grantConnectionImpl(entityId)).token
      : (this.serverInfo.gatewayConfig.token ?? "");

    return buildBootstrapConfig({
      entityId,
      slotId,
      contextId: getPanelContextId(panel),
      effectiveVersion: (await this.getCurrentEntitySource(slotId))?.effectiveVersion ?? null,
      buildKey: panel.buildKey ?? null,
      parentId,
      parentEntityId,
      source: getPanelSource(panel),
      theme: this.currentTheme,
      gatewayConfig: {
        serverUrl: this.serverInfo.gatewayConfig.serverUrl,
        token,
        aliases: this.serverInfo.gatewayConfig.aliases,
        workspace: this.serverInfo.gatewayConfig.workspace,
      },
      env: (getPanelOptions(panel).env ?? {}) as Record<string, string>,
      stateArgs: (getPanelStateArgs(panel) ?? {}) as Record<string, unknown>,
    });
  }

  async getCurrentEntityId(slotId: PanelSlotId): Promise<PanelEntityId> {
    return this.resolveCurrentEntityIdForSlot(slotId);
  }

  /**
   * Force-refresh a slot's complete current incarnation from the authoritative
   * store. Runtime identity, immutable build identity, and navigation snapshot
   * are one bootstrap fact: refreshing only the entity id can pair a replacement
   * runtime with the previous build URL.
   *
   * Required after a SERVER-side mutation (navigate / history): the panel-tree
   * broadcast refreshes the owner mirror, but thin clients may not receive or
   * apply that mirror before a lease assignment asks them to load the new
   * incarnation.
   */
  async refreshSlotEntity(slotId: PanelSlotId): Promise<PanelEntityId | null> {
    this.currentEntityBySlot.delete(slotId);
    this.currentEntitySourceBySlot.delete(slotId);
    const slot = await this.workspaceState.getSlot(slotId);
    if (!slot?.current_entity_id) return null;
    const entityId = slot.current_entity_id;
    const [entity, detail] = await Promise.all([
      this.workspaceState.resolveEntity(entityId),
      this.workspaceState.getPanelDetail(slotId),
    ]);
    this.currentEntityBySlot.set(slotId, entityId);
    if (entity?.source) this.currentEntitySourceBySlot.set(slotId, entity.source);

    const panel = this.registry.getPanel(slotId);
    if (panel) {
      const previousTitle = panel.title;
      const currentSnapshot = detail
        ? this.snapshotFromHistoryRow(detail.currentHistory)
        : undefined;
      panel.runtimeEntityId = entityId;
      panel.effectiveVersion = entity?.source.effectiveVersion ?? null;
      panel.buildKey = entity?.activeBuildKey ?? null;
      panel.executionDigest = entity?.activeExecutionDigest ?? null;
      panel.authorityRequests = entity?.activeAuthority?.requests;
      if (currentSnapshot) {
        // A null durable title is a clear, not "leave the old local title in
        // place". Drop the local fallback first so titleFor can select the
        // manifest/metadata/browser fallback deterministically.
        if (slot.current_entity_title == null) this.localPanelTitles.delete(slotId);
        panel.title = this.titleFor(
          slotId,
          currentSnapshot.source,
          slot.current_entity_title ?? undefined
        );
        const nextIcon = detail?.icon;
        if (nextIcon) panel.icon = nextIcon;
        else delete panel.icon;
        this.registry.replaceCurrentSnapshot(slotId, currentSnapshot, {
          entries: [currentSnapshot],
          index: 0,
        });
      } else if (slot.current_entity_title != null) {
        panel.title = normalizePanelTitle(slot.current_entity_title) ?? panel.title;
      }
      if (panel.title !== previousTitle) {
        this.registry.notifyPanelTreeUpdate(slotId);
      }
    }
    return entityId;
  }

  /**
   * Sync the entity caches from the (already-repopulated) registry mirror. A thin
   * client applies the panel-tree broadcast to its registry but does NOT re-read
   * the DB, so without this its `currentEntityBySlot` cache would drift from the
   * authoritative tree after ANY server-side mutation by ANY client — leaving
   * `getPanelInit`/`acquireRuntimeLease` resolving a retired entity. The registry
   * panels carry the authoritative `runtimeEntityId` straight from the broadcast,
   * so this is an in-memory reconcile (no RPC). Source cache is dropped so it is
   * re-resolved lazily against the new entity.
   */
  syncEntityCachesFromRegistry(): void {
    for (const { panelId } of this.registry.listPanels()) {
      const panel = this.registry.getPanel(panelId);
      const entityId = panel?.runtimeEntityId;
      if (!entityId) continue;
      const slotId = asPanelSlotId(panelId);
      this.currentEntityBySlot.set(slotId, asPanelEntityId(entityId));
      this.currentEntitySourceBySlot.delete(slotId);
    }
  }

  async getCurrentEntitySource(
    slotId: PanelSlotId
  ): Promise<{ repoPath: string; effectiveVersion: string } | null> {
    const cached = this.currentEntitySourceBySlot.get(slotId);
    if (cached) return cached;
    const entityId = await this.resolveCurrentEntityIdForSlot(slotId);
    const record = await this.workspaceState.resolveEntity(entityId);
    const source = record?.source ?? null;
    if (source) this.currentEntitySourceBySlot.set(slotId, source);
    return source;
  }

  // ===========================================================================
  // Private — tree reconstruction
  // ===========================================================================

  private snapshotFromHistoryRow(row: SlotHistoryRow): PanelSnapshot {
    const stateArgs = row.state_args ? this.safeParseJson(row.state_args) : undefined;
    // Prefer the server-persisted per-entry options (env/ref) so they survive
    // restart and cross-client; fall back to the in-memory record for entries
    // written before persistence, then to empty.
    const persistedOptions = row.options ? this.safeParseJson(row.options) : undefined;
    const options = (persistedOptions ?? {}) as PanelSnapshot["options"];
    return {
      source: row.source,
      contextId: row.context_id,
      options,
      stateArgs: stateArgs as PanelSnapshot["stateArgs"],
      // The resolved placement hint round-trips inside the persisted options
      // blob; re-lift it to the snapshot's canonical top-level field.
      ...(options.placement ? { placement: options.placement } : {}),
    };
  }

  private safeParseJson(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }

  private resolveCursor(history: SlotHistoryRow[], currentEntryKey: string | null): number | null {
    if (!currentEntryKey) return history.length > 0 ? history.length - 1 : null;
    const idx = history.findIndex((row) => row.entry_key === currentEntryKey);
    return idx >= 0 ? idx : null;
  }

  private titleFor(
    slotId: PanelSlotId,
    source: string,
    entityTitle?: string,
    metadata?: PanelMetadata
  ): string {
    const normalizedEntityTitle = normalizePanelTitle(entityTitle);
    if (normalizedEntityTitle) return normalizedEntityTitle;
    const manifest = this.tryResolveManifestForSource(source);
    const manifestTitle = normalizePanelTitle(manifest?.title);
    if (manifestTitle) return manifestTitle;
    const metadataTitle = normalizePanelTitle(metadata?.title);
    if (metadataTitle) return metadataTitle;
    const localTitle = this.localPanelTitles.get(slotId);
    const normalizedLocalTitle = normalizePanelTitle(localTitle?.title);
    if (localTitle?.source === source && normalizedLocalTitle) return normalizedLocalTitle;
    if (source.startsWith("browser:")) {
      try {
        return new URL(source.slice("browser:".length)).hostname;
      } catch {
        return path.basename(source);
      }
    }
    return path.basename(source) || slotId;
  }

  private async fetchPanelMetadataForHistories(
    histories: Map<PanelSlotId, SlotHistoryRow[]>
  ): Promise<Map<string, PanelMetadata>> {
    const metadataResolver = this.metadataResolver;
    if (!metadataResolver) return new Map();
    const sources = new Set<string>();
    for (const rows of histories.values()) {
      for (const row of rows) {
        if (!row.source.startsWith("browser:")) sources.add(row.source);
      }
    }
    const entries = await Promise.all(
      [...sources].map(async (source): Promise<[string, PanelMetadata | null]> => {
        try {
          return [source, await metadataResolver.getPanelMetadata(source)];
        } catch (err) {
          log.warn("Failed to resolve panel metadata", { source, err });
          return [source, null];
        }
      })
    );
    const metadataBySource = new Map<string, PanelMetadata>();
    for (const [source, metadata] of entries) {
      if (metadata) metadataBySource.set(source, metadata);
    }
    return metadataBySource;
  }

  private async replaceHistoryAtCurrent(
    slotId: PanelSlotId,
    panel: Panel,
    nextSnapshot: PanelSnapshot
  ): Promise<void> {
    const currentEntityId = await this.resolveCurrentEntityIdForSlot(slotId);
    const newEntryKey = mintHistoryEntryKey();
    const stateArgsPayload = (nextSnapshot.stateArgs ?? {}) as Record<string, unknown>;
    const handle = await this.runtime.createEntity({
      kind: "panel",
      execution: panelExecutionForSource(nextSnapshot.source, nextSnapshot.options.ref),
      key: newEntryKey,
      contextId: nextSnapshot.contextId,
      stateArgs: stateArgsPayload,
    });
    const entityId = asPanelEntityId(handle.id);
    const transition = await commitPreparedPanelNavigation(
      {
        runtime: this.runtime,
        workspaceState: this.workspaceState,
      },
      {
        slotId,
        expectedCurrentEntityId: currentEntityId,
        mutation: {
          kind: "replace",
          entry: {
            entryKey: newEntryKey,
            entityId,
            source: nextSnapshot.source,
            contextId: nextSnapshot.contextId,
            stateArgs: stateArgsPayload,
            options: nextSnapshot.options,
          },
        },
      }
    );
    this.recordIncarnationCommit("replace");
    this.recordNavigationRetirement(transition, "replace-current");

    this.currentEntityBySlot.set(slotId, entityId);
    this.currentEntitySourceBySlot.set(slotId, handle.source);

    const livePanel = this.registry.getPanel(slotId);
    if (livePanel) {
      livePanel.runtimeEntityId = entityId;
      livePanel.effectiveVersion = handle.source.effectiveVersion;
      livePanel.buildKey = handle.buildKey ?? null;
      livePanel.executionDigest = handle.executionDigest ?? null;
      livePanel.authorityRequests = handle.authorityRequests;
      const history = panel.history ?? { entries: [getCurrentSnapshot(panel)], index: 0 };
      const entries = history.entries.slice();
      entries[history.index] = nextSnapshot;
      this.registry.replaceCurrentSnapshot(slotId, nextSnapshot, {
        entries,
        index: history.index,
      });
    }
  }

  private recordNavigationRetirement(
    transition: PanelNavigationCommitResult,
    operation: string
  ): void {
    if (transition.retirement.status === "unchanged") return;
    if (transition.retirement.status === "retired") {
      this.recordIncarnationRetirement(false);
      return;
    }
    this.recordIncarnationRetirement(true);
    const error = transition.retirement.error;
    log.warn(
      `Failed to retire panel entity ${transition.previousEntityId} on ${operation}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  // ===========================================================================
  // Private — manifest / validation
  // ===========================================================================

  private createNavigationSnapshot(
    panel: Panel,
    source: string,
    opts?: NavigatePanelOptions
  ): PanelSnapshot {
    const browserSource = browserNavigationSource(source);
    if (browserSource) {
      const currentSnapshot = getCurrentSnapshot(panel);
      const previousOptions = currentSnapshot.options;
      return createSnapshot(browserSource, opts?.contextId ?? currentSnapshot.contextId, {
        env: opts?.env ?? previousOptions.env,
        ref: opts?.ref,
      });
    }

    const { relativePath, absolutePath } = resolveSource(source, this.workspacePath);
    const manifest = this.resolveManifest(absolutePath, relativePath, this.allowMissingManifests);
    const validatedStateArgs = this.validateManifestStateArgs(
      relativePath,
      manifest.stateArgs,
      opts?.stateArgs
    );
    const currentSnapshot = getCurrentSnapshot(panel);
    const previousOptions = currentSnapshot.options;
    const snapshot = createSnapshot(
      relativePath,
      opts?.contextId ?? currentSnapshot.contextId,
      {
        env: opts?.env ?? previousOptions.env,
        ref: opts?.ref,
      },
      validatedStateArgs
    );
    if (manifest.autoArchiveWhenEmpty) snapshot.autoArchiveWhenEmpty = true;
    if (manifest.privileged) snapshot.privileged = true;
    return snapshot;
  }

  private resolveManifest(
    absolutePath: string,
    relativePath: string,
    allowMissing: boolean
  ): {
    title: string;
    stateArgs?: unknown;
    autoArchiveWhenEmpty?: boolean;
    privileged?: boolean;
    placement?: PanelPlacementHint;
  } {
    try {
      const manifest = loadPanelManifest(absolutePath);
      return {
        ...manifest,
        // Privileged is gated purely by location: any unit under about/. (No `shell`
        // flag — an about page is a normal panel that lives in about/.)
        privileged: isAboutSource(relativePath),
      };
    } catch (error) {
      if (allowMissing) {
        return { title: path.basename(relativePath) };
      }
      throw new Error(
        `Failed to load manifest for ${relativePath}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private tryResolveManifestForSource(source: string) {
    if (source.startsWith("browser:")) return null;
    try {
      const { absolutePath } = resolveSource(source, this.workspacePath);
      const manifest = loadPanelManifest(absolutePath);
      return {
        ...manifest,
        // Privileged is gated purely by location: any unit under about/.
        privileged: isAboutSource(source),
      };
    } catch {
      return null;
    }
  }

  private validateManifestStateArgs(
    source: string,
    schema: unknown,
    stateArgs?: Record<string, unknown>
  ): Record<string, unknown> | undefined {
    if (!stateArgs && !schema) return undefined;
    const validation = validateStateArgs(stateArgs ?? {}, schema as never);
    if (!validation.success) {
      throw new Error(`Invalid stateArgs for ${source}: ${validation.error}`);
    }
    return validation.data as Record<string, unknown>;
  }

  private loadPanelSchema(panel: Panel) {
    try {
      const absolutePath = path.resolve(this.workspacePath, getPanelSource(panel));
      return loadPanelManifest(absolutePath).stateArgs;
    } catch {
      return undefined;
    }
  }

  private async requireStoredPanel(slotId: PanelSlotId, forceRefresh = false): Promise<Panel> {
    let panel = this.registry.getPanel(slotId) ?? null;
    if (!panel || forceRefresh) {
      const detail = await this.workspaceState.getPanelDetail(slotId);
      if (detail) {
        // Another bounded refresh may have projected this slot while the
        // durable detail read was in flight. Reconcile against the registry
        // again before insertion so concurrent first reads cannot prepend the
        // same root twice.
        panel = this.registry.getPanel(slotId) ?? panel;
        const snapshot = this.snapshotFromHistoryRow(detail.currentHistory);
        const entity = detail.entity;
        const source = entity.source;
        const isBrowser = snapshot.source.startsWith("browser:");
        const manifestIcon = detail.icon;
        if (detail.slot.current_entity_title == null) this.localPanelTitles.delete(slotId);
        const preservesMaterializedView =
          panel?.runtimeEntityId === detail.slot.current_entity_id &&
          panel?.buildKey === (entity.activeBuildKey ?? null) &&
          panel?.executionDigest === (entity.activeExecutionDigest ?? null);
        const projected: Panel = {
          id: slotId,
          title: this.titleFor(
            slotId,
            snapshot.source,
            detail.slot.current_entity_title ?? undefined
          ),
          ...(manifestIcon ? { icon: manifestIcon } : {}),
          runtimeEntityId: detail.slot.current_entity_id,
          effectiveVersion: source.effectiveVersion,
          buildKey: entity.activeBuildKey ?? null,
          executionDigest: entity.activeExecutionDigest ?? null,
          authorityRequests: entity.activeAuthority?.requests,
          ...(detail.slot.owner_user_id ? { owner: detail.slot.owner_user_id } : {}),
          children: [],
          snapshot,
          history: { entries: [snapshot], index: 0 },
          artifacts:
            preservesMaterializedView && panel
              ? panel.artifacts
              : entity.status === "preparing"
                ? { buildState: "pending", buildProgress: "Preparing panel runtime..." }
                : isBrowser
                  ? { buildState: "ready", htmlPath: snapshot.source.slice("browser:".length) }
                  : { buildState: "building", buildProgress: "Loading panel runtime..." },
          navigation: {
            canGoBack: (detail.slot.current_history_cursor ?? 0) > 0,
            canGoForward:
              (detail.slot.current_history_cursor ?? 0) <
              Math.max(0, (detail.slot.history_count ?? 1) - 1),
          },
        };
        if (panel) {
          const children = panel.children;
          Object.assign(panel, projected);
          panel.children = children;
        } else {
          panel = projected;
          this.registry.addPanel(panel, null, { addAsRoot: true });
        }
        this.currentEntityBySlot.set(slotId, detail.entity.id as PanelEntityId);
        this.currentEntitySourceBySlot.set(slotId, detail.entity.source);
      }
    }
    if (!panel) throw new Error(`Panel not found: ${slotId}`);
    this.touchRuntimePanel(slotId);
    return panel;
  }

  private touchRuntimePanel(slotId: PanelSlotId): void {
    this.runtimePanelLru.set(slotId, ++this.runtimePanelClock);
    while (this.runtimePanelLru.size > PanelManager.MAX_RUNTIME_PANEL_CACHE) {
      const oldest = [...this.runtimePanelLru.entries()].sort((a, b) => a[1] - b[1])[0];
      if (!oldest) return;
      const [candidate] = oldest;
      this.runtimePanelLru.delete(candidate);
      this.currentEntityBySlot.delete(candidate);
      this.currentEntitySourceBySlot.delete(candidate);
      if (this.registry.getPanel(candidate)) this.registry.removePanel(candidate);
    }
  }

  /**
   * Resolve the canonical entity id (`panel:<historyEntryKey>`) for a slot.
   * Used at panel-init time when the local `currentEntityBySlot` cache hasn't
   * been populated yet — e.g. on the first addressed access after app boot.
   */
  private async resolveCurrentEntityIdForSlot(slotId: PanelSlotId): Promise<PanelEntityId> {
    const fromCache = this.currentEntityBySlot.get(slotId);
    if (fromCache) return fromCache;
    const slot = await this.workspaceState.getSlot(slotId);
    if (!slot?.current_entity_id) {
      throw new Error(`Slot ${slotId} has no current panel entity`);
    }
    this.currentEntityBySlot.set(slotId, slot.current_entity_id);
    return slot.current_entity_id;
  }

  private async ensureViewStateLoaded(): Promise<void> {
    if (this.viewStateLoaded) return;
    this.viewStateLoaded = true;
    const state = await Promise.resolve(this.viewState?.load()).catch(() => null);
    for (const slotId of state?.collapsedIds ?? []) {
      this.collapsedIds.add(slotId);
    }
    if (typeof state?.focusedPanelId === "string" && state.focusedPanelId) {
      this.registry.setFocusedPanelId(state.focusedPanelId);
    }
    for (const [slotId, entry] of Object.entries(state?.panelTitles ?? {})) {
      if (typeof entry?.source === "string" && typeof entry?.title === "string" && entry.title) {
        this.localPanelTitles.set(slotId, { source: entry.source, title: entry.title });
      }
    }
  }

  private async persistViewState(): Promise<void> {
    const panelTitles: NonNullable<LocalPanelViewState["panelTitles"]> = {};
    for (const panel of this.registry.listPanels()) {
      panelTitles[panel.panelId] = { source: panel.source, title: panel.title };
    }
    await this.viewState?.save({
      collapsedIds: [...this.collapsedIds],
      focusedPanelId: this.registry.getFocusedPanelId(),
      panelTitles,
    });
  }

  private indexPanel(slotId: PanelSlotId, title: string, panelPath: string): void {
    if (!this.searchIndex) return;
    Promise.resolve(this.searchIndex.indexPanel({ id: slotId, title, path: panelPath })).catch(
      (error) => {
        log.warn(`Failed to index panel ${slotId}:`, error);
      }
    );
  }
}
