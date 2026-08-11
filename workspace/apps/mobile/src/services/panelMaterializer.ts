import type { Panel } from "@vibestudio/shared/types";
import { getCurrentSnapshot } from "@vibestudio/shared/panel/accessors";
import { formatPanelRuntimeLeaseDeniedMessage } from "@vibestudio/shared/panel/panelLease";
import { asPanelEntityId, type PanelEntityId } from "@vibestudio/shared/panel/ids";
import { buildPanelUrl, type HostConfig } from "./panelUrls";

export interface MobileMaterializedPanel {
  panelId: string;
  runtimeEntityId: PanelEntityId;
  url: string;
  managed: boolean;
  panelInit: unknown;
}

export interface MobilePanelMaterializationDeps {
  panelId: string;
  hostConfig: HostConfig;
  getPanelInit(panelId: string): Promise<unknown>;
  acquireLease(
    panelId: string,
    runtimeEntityId: PanelEntityId,
    opts: { connectionId: string }
  ): Promise<{ acquired: boolean; lease?: { holderLabel: string } }>;
  takeOverLease(
    panelId: string,
    runtimeEntityId: PanelEntityId,
    opts: { connectionId: string }
  ): Promise<{ acquired: boolean; lease?: { holderLabel: string } }>;
  leaseMode: "acquire" | "takeOver";
}

function panelInitEntityId(panelInit: unknown): string | null {
  return panelInit &&
    typeof panelInit === "object" &&
    typeof (panelInit as { entityId?: unknown }).entityId === "string"
    ? (panelInit as { entityId: string }).entityId
    : null;
}

/**
 * A loaded WebView is a projection of one immutable panel runtime entity.
 *
 * Build completion and navigation both publish a new runtime identity through
 * the shared tree. The host converges every retained WebView to that identity;
 * visibility is only presentation state and must not control materialization.
 */
export type MobilePanelMaterializationState = "pending" | "needed" | "current";

export function mobilePanelMaterializationState(
  panel: Panel,
  current: { url: string; runtimeEntityId: string | null }
): MobilePanelMaterializationState {
  if (!panel.runtimeEntityId) return "pending";
  const managed = !getCurrentSnapshot(panel).source.startsWith("browser:");
  if (managed && !/^[0-9a-f]{64}$/.test(panel.buildKey ?? "")) return "pending";
  return current.url === "about:blank" || current.runtimeEntityId !== panel.runtimeEntityId
    ? "needed"
    : "current";
}

export function needsMobilePanelMaterialization(
  panel: Panel,
  current: { url: string; runtimeEntityId: string | null }
): boolean {
  return mobilePanelMaterializationState(panel, current) === "needed";
}

/**
 * Mobile workspace app-owned runtime materialization.
 *
 * The server owns persisted panel state. The mobile app owns WebView runtime
 * state: load URLs and host-injected panel identity.
 */
export async function materializeMobilePanel(
  opts: MobilePanelMaterializationDeps & { panel: Panel }
): Promise<MobileMaterializedPanel> {
  const snapshot = getCurrentSnapshot(opts.panel);
  const managed = !snapshot.source.startsWith("browser:");
  const connectionId = `mobile-${opts.panelId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const acquireLease = (runtimeEntityId: PanelEntityId) =>
    opts.leaseMode === "takeOver"
      ? opts.takeOverLease(opts.panelId, runtimeEntityId, { connectionId })
      : opts.acquireLease(opts.panelId, runtimeEntityId, { connectionId });
  if (managed && !/^[0-9a-f]{64}$/.test(opts.panel.buildKey ?? "")) {
    if (!opts.panel.runtimeEntityId) {
      throw new Error(`Panel ${opts.panelId} did not provide a reserved runtime entity id`);
    }
    const runtimeEntityId = asPanelEntityId(opts.panel.runtimeEntityId);
    const lease = await acquireLease(runtimeEntityId);
    if (!lease.acquired) {
      throw new Error(formatPanelRuntimeLeaseDeniedMessage(opts.panelId, lease.lease));
    }
    return {
      panelId: opts.panelId,
      runtimeEntityId,
      url: "about:blank",
      managed: true,
      panelInit: null,
    };
  }
  const panelInit = await opts.getPanelInit(opts.panelId);
  const rawEntityId = panelInitEntityId(panelInit);
  if (!rawEntityId) {
    throw new Error(`Panel ${opts.panelId} did not provide a runtime entity id`);
  }
  // Validate the SHAPE here (throws loudly on a slot id "panel:tree/…" where an
  // entity id "panel:nav-…" is required) so the slot/entity mix-up cannot reach
  // the lease + grant as a laundered raw string — the brand then enforces it
  // through acquireLease → runtimeConnectionBySlot → openPanelSession at compile
  // time.
  const runtimeEntityId: PanelEntityId = asPanelEntityId(rawEntityId);
  if (runtimeEntityId !== opts.panel.runtimeEntityId) {
    throw new Error(
      `Panel ${opts.panelId} changed runtime identity while it was being materialized`
    );
  }
  const lease = await acquireLease(runtimeEntityId);
  if (!lease.acquired) {
    throw new Error(formatPanelRuntimeLeaseDeniedMessage(opts.panelId, lease.lease));
  }
  if (!managed) {
    return {
      panelId: opts.panelId,
      runtimeEntityId,
      url: snapshot.source.slice("browser:".length),
      managed: false,
      panelInit: null,
    };
  }
  return {
    panelId: opts.panelId,
    runtimeEntityId,
    url: buildPanelUrl(
      snapshot.source,
      snapshot.contextId,
      opts.panel.buildKey ?? "",
      opts.hostConfig
    ),
    managed: true,
    panelInit:
      panelInit && typeof panelInit === "object"
        ? {
            ...(panelInit as Record<string, unknown>),
            connectionId,
            clientLabel: "Mobile",
          }
        : panelInit,
  };
}

function materializationCoordinate(panel: Panel): string {
  const snapshot = getCurrentSnapshot(panel);
  return JSON.stringify({
    runtimeEntityId: panel.runtimeEntityId ?? null,
    buildKey: panel.buildKey ?? null,
    source: snapshot.source,
    contextId: snapshot.contextId,
  });
}

/**
 * Materialize one coherent live panel incarnation.
 *
 * `getPanelInit` and lease acquisition cross the host boundary, so navigation
 * or build completion may replace the panel while either is in flight. Retry
 * from the new authoritative snapshot instead of ever pairing one incarnation's
 * URL with another incarnation's runtime identity.
 */
export async function materializeLatestMobilePanel(
  opts: MobilePanelMaterializationDeps & { getPanel(): Panel | null }
): Promise<MobileMaterializedPanel> {
  while (true) {
    const panel = opts.getPanel();
    if (!panel) throw new Error(`Panel ${opts.panelId} no longer exists`);
    const expectedCoordinate = materializationCoordinate(panel);

    let materialized: MobileMaterializedPanel;
    try {
      materialized = await materializeMobilePanel({ ...opts, panel });
    } catch (error) {
      const current = opts.getPanel();
      if (current && materializationCoordinate(current) !== expectedCoordinate) continue;
      throw error;
    }

    const current = opts.getPanel();
    if (!current) throw new Error(`Panel ${opts.panelId} no longer exists`);
    if (
      materialized.runtimeEntityId !== panel.runtimeEntityId ||
      materializationCoordinate(current) !== expectedCoordinate
    ) {
      continue;
    }
    return materialized;
  }
}

export class PanelMaterializationRetryQueue {
  private readonly retries = new Map<
    string,
    { attempt: number; timer: ReturnType<typeof setTimeout> | null }
  >();
  private stopped = false;

  constructor(
    private readonly onRetry: () => void,
    private readonly initialDelayMs = 1_000,
    private readonly maxDelayMs = 30_000
  ) {}

  cancel(panelId: string, options: { resetAttempts: boolean }): void {
    const retry = this.retries.get(panelId);
    if (retry?.timer) clearTimeout(retry.timer);
    if (options.resetAttempts) {
      this.retries.delete(panelId);
    } else if (retry) {
      this.retries.set(panelId, { ...retry, timer: null });
    }
  }

  schedule(panelId: string): void {
    if (this.stopped) return;
    const previous = this.retries.get(panelId);
    if (previous?.timer) return;
    const attempt = (previous?.attempt ?? 0) + 1;
    const delayMs = Math.min(this.maxDelayMs, this.initialDelayMs * 2 ** Math.min(attempt - 1, 10));
    const timer = setTimeout(() => {
      const current = this.retries.get(panelId);
      if (!current || current.timer !== timer) return;
      this.retries.set(panelId, { attempt, timer: null });
      this.onRetry();
    }, delayMs);
    this.retries.set(panelId, { attempt, timer });
  }

  retainOnly(panelIds: ReadonlySet<string>): void {
    for (const panelId of this.retries.keys()) {
      if (!panelIds.has(panelId)) this.cancel(panelId, { resetAttempts: true });
    }
  }

  stop(): void {
    this.stopped = true;
    for (const retry of this.retries.values()) {
      if (retry.timer) clearTimeout(retry.timer);
    }
    this.retries.clear();
  }
}
