import {
  selectCapEvictionVictims,
  selectIdlePanelVictims,
  type LoadedPanelSnapshot,
} from "@vibestudio/shared/panel/panelGc";

export type PanelResourceUnloadReason = "idle-timeout" | "resource-cap";

export interface PanelResourcePolicyDeps {
  tracksAssignedResources: boolean;
  maximumLoadedPanels: number | null;
  idleUnloadMs: number | null;
  idleSweepIntervalMs: number;
  now(): number;
  getFocusedPanelId(): string | null;
  isPinned(panelId: string): boolean;
  isKeepLoaded(panelId: string): boolean;
  panelExists(panelId: string): boolean;
  unload(panelId: string, reason: PanelResourceUnloadReason): Promise<void>;
  reportUnloadError(panelId: string, reason: PanelResourceUnloadReason, error: unknown): void;
}

/**
 * Owns client-local panel resource retention. Its ledger contains only loaded,
 * lease-assigned panels; focus, pins, and automation leases protect entries
 * without changing their last-activity timestamp.
 */
export class PanelResourcePolicy {
  private readonly resources = new Map<string, { lastUsedAt: number }>();
  private idleSweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: PanelResourcePolicyDeps) {}

  start(): void {
    if (this.deps.idleUnloadMs === null || this.idleSweepTimer) return;
    this.idleSweepTimer = setInterval(() => this.sweepIdlePanels(), this.deps.idleSweepIntervalMs);
  }

  stop(): void {
    if (this.idleSweepTimer) clearInterval(this.idleSweepTimer);
    this.idleSweepTimer = null;
  }

  track(panelId: string): void {
    if (!this.deps.tracksAssignedResources) return;
    this.resources.set(panelId, { lastUsedAt: this.deps.now() });
  }

  clear(panelId: string): void {
    this.resources.delete(panelId);
  }

  /** Refresh only a loaded entry; focusing an unloaded panel creates no phantom resource. */
  refreshActivity(panelId: string): void {
    const entry = this.resources.get(panelId);
    if (entry) entry.lastUsedAt = this.deps.now();
  }

  async enforceCap(keepPanelId: string): Promise<void> {
    const cap = this.deps.maximumLoadedPanels;
    if (cap === null || cap <= 0) return;
    const focused = this.deps.getFocusedPanelId();
    const protectedIds = [keepPanelId, ...(focused ? [focused] : [])];
    const victims = selectCapEvictionVictims(this.loadedSnapshots(), {
      cap,
      protectedIds,
      ...this.protectionPredicates(),
    });
    for (const panelId of victims) await this.unloadTracked(panelId, "resource-cap");
  }

  private sweepIdlePanels(): void {
    const idleMs = this.deps.idleUnloadMs;
    if (idleMs === null) return;
    const focused = this.deps.getFocusedPanelId();
    const victims = selectIdlePanelVictims(this.loadedSnapshots(), {
      now: this.deps.now(),
      idleMs,
      protectedIds: focused ? [focused] : [],
      ...this.protectionPredicates(),
    });
    for (const panelId of victims) void this.unloadTracked(panelId, "idle-timeout");
  }

  private loadedSnapshots(): LoadedPanelSnapshot[] {
    return [...this.resources.entries()].map(([panelId, resource]) => ({
      panelId,
      lastActive: resource.lastUsedAt,
    }));
  }

  private protectionPredicates() {
    return {
      isPinned: (panelId: string) => this.deps.isPinned(panelId),
      isKeepLoaded: (panelId: string) => this.deps.isKeepLoaded(panelId),
    };
  }

  private async unloadTracked(panelId: string, reason: PanelResourceUnloadReason): Promise<void> {
    if (!this.resources.has(panelId)) return;
    if (!this.deps.panelExists(panelId)) {
      this.clear(panelId);
      return;
    }
    try {
      await this.deps.unload(panelId, reason);
      this.clear(panelId);
    } catch (error) {
      this.deps.reportUnloadError(panelId, reason, error);
      this.clear(panelId);
    }
  }
}
