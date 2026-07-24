/**
 * Panel-init resolution for the headless host — a port of mobile's
 * createMobileShellCore (workspace/apps/mobile/src/shellCore/) minus the
 * mobile-only pieces: the shared PanelManager over plain RPC delegates,
 * with in-memory view state. getPanelInit() returns the bootstrap config
 * (incl. a fresh single-use auth.grantConnection token — never cache it).
 */
import { PanelRegistry } from "@vibestudio/shared/panelRegistry";
import { PanelManager } from "@vibestudio/shell-core/panelManager";
import {
  createRuntimeClient,
  createWorkspaceStateClient,
} from "@vibestudio/shell-core/createShellCore";
import type { CreatePanelResult, NavigatePanelOptions } from "@vibestudio/shell-core/panelManager";
import {
  asPanelEntityId,
  asPanelSlotId,
  type PanelEntityId,
  type PanelSlotId,
} from "@vibestudio/shared/panel/ids";
import { buildPanelUrl } from "@vibestudio/shared/panelFactory";
import type { PanelRuntimeAcquireResult } from "@vibestudio/shared/panel/panelLease";
import {
  createPanelRuntimeLeaseRequest,
  formatPanelRuntimeLeaseDeniedMessage,
} from "@vibestudio/shared/panel/panelLease";
import type { RpcClient } from "@vibestudio/rpc";

export interface PanelLoadInfo {
  panelUrl: string;
  contextId: string;
  source: string;
  /** Bootstrap payload incl. connectionId — inject as __vibestudioPanelInit. */
  panelInit: Record<string, unknown>;
}

export class PanelInitClient {
  private readonly panelManager: PanelManager;

  constructor(
    private readonly rpc: Pick<RpcClient, "call">,
    private readonly serverUrl: string,
    private readonly clientLabel: string,
    private readonly clientSessionId: string
  ) {
    const call = <T>(method: string, args: unknown[]) =>
      rpc.call<T>("main", method, args) as Promise<T>;
    const callService = (service: string, method: string, args: unknown[]) =>
      call<unknown>(`${service}.${method}`, args);
    const workspaceState = createWorkspaceStateClient(callService);
    const runtime = createRuntimeClient(callService);

    this.panelManager = new PanelManager({
      registry: new PanelRegistry({}),
      workspaceState,
      runtime,
      // The headless host never surfaces search UI; keep index ops as no-ops
      // so transient hosting doesn't churn the workspace search state.
      searchIndex: {
        indexPanel: async () => undefined,
        search: async () => [],
        incrementAccessCount: async () => undefined,
        updateTitle: async () => undefined,
        rebuildIndex: async () => undefined,
      },
      viewState: { load: () => ({ collapsedIds: [] }), save: () => undefined },
      metadataResolver: {
        getPanelMetadata: (source) =>
          call<{ title?: string } | null>("build.getPanelMetadata", [source]),
      },
      workspacePath: "",
      allowMissingManifests: true,
      serverInfo: { gatewayConfig: { serverUrl } },
      grantConnection: (entityId) => call<{ token: string }>("auth.grantConnection", [entityId]),
    });
  }

  /**
   * Resolve everything needed to host a panel: URL + bootstrap payload with
   * the lease connectionId merged in. Fetch fresh on every (re)load — the
   * embedded gateway token is single-use.
   */
  async getPanelLoadInfo(
    slotId: string,
    runtimeEntityId: PanelEntityId,
    connectionId: string
  ): Promise<PanelLoadInfo> {
    const normalizedSlotId = asPanelSlotId(slotId);
    // This headless PanelManager is an RPC adapter, not the owner-side tree
    // mirror. Its in-memory entity cache therefore does not receive panel-tree
    // broadcasts. Resolve the authoritative slot cursor for every load and
    // prove it still matches the lease that caused this load before minting the
    // single-use panel credential.
    const currentEntityId = await this.panelManager.refreshSlotEntity(normalizedSlotId);
    if (currentEntityId !== asPanelEntityId(runtimeEntityId)) {
      throw new Error(
        `panel ${slotId} lease targets ${runtimeEntityId}, but the current runtime is ${currentEntityId ?? "missing"}`
      );
    }
    const init = (await this.panelManager.getPanelInit(normalizedSlotId)) as Record<
      string,
      unknown
    >;
    if (init["entityId"] !== runtimeEntityId) {
      throw new Error(
        `panel ${slotId} bootstrap targets ${String(init["entityId"] ?? "missing")}, but the lease targets ${runtimeEntityId}`
      );
    }
    const source = String(init["sourceRepo"] ?? "");
    const contextId = String(init["contextId"] ?? "");
    const buildKey = typeof init["buildKey"] === "string" ? init["buildKey"] : null;
    if (!source) throw new Error(`panel ${slotId} has no source`);

    const url = new URL(this.serverUrl);
    const basePath = url.pathname.replace(/\/+$/, "");
    const panelUrl = source.startsWith("browser:")
      ? source.slice("browser:".length)
      : buildPanelUrl({
          source,
          contextId,
          buildKey,
          ref: undefined,
          gatewayPort: Number.parseInt(url.port, 10) || (url.protocol === "https:" ? 443 : 80),
          basePath: basePath === "/" ? "" : basePath,
        });

    return {
      panelUrl,
      contextId,
      source,
      panelInit: {
        ...init,
        connectionId,
        clientLabel: this.clientLabel,
      },
    };
  }

  async navigatePanel(
    slotId: string,
    source: string,
    options: NavigatePanelOptions | undefined,
    connectionId: string
  ): Promise<CreatePanelResult> {
    const normalizedSlotId = asPanelSlotId(slotId);
    const result = await this.panelManager.navigate(normalizedSlotId, source, options);
    await this.acquireCurrentPanelLease(normalizedSlotId, slotId, connectionId);
    return result;
  }

  async navigatePanelHistory(
    slotId: string,
    delta: -1 | 1,
    connectionId: string
  ): Promise<{ id: string; title: string } | null> {
    const normalizedSlotId = asPanelSlotId(slotId);
    const panel = await this.panelManager.navigateHistory(normalizedSlotId, delta);
    if (!panel) return null;
    await this.acquireCurrentPanelLease(normalizedSlotId, slotId, connectionId);
    return { id: panel.id, title: panel.title };
  }

  private async acquireCurrentPanelLease(
    normalizedSlotId: PanelSlotId,
    slotId: string,
    connectionId: string
  ): Promise<void> {
    const runtimeEntityId = await this.panelManager.getCurrentEntityId(normalizedSlotId);
    const acquired = await this.rpc.call<PanelRuntimeAcquireResult>(
      "main",
      "panelRuntime.acquire",
      [
        runtimeEntityId,
        createPanelRuntimeLeaseRequest({
          slotId,
          clientSessionId: this.clientSessionId,
          hostConnectionId: this.clientSessionId,
          connectionId,
        }),
      ]
    );
    if (!acquired.acquired) {
      throw new Error(formatPanelRuntimeLeaseDeniedMessage(slotId, acquired.lease));
    }
  }
}
