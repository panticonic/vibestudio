/**
 * panelContext — one aggregate "what panel is this?" read for server-side
 * callers and configurable agent tools.
 *
 * This is a single cheap RPC over facts the server already holds: the durable
 * slot/history/entity join from workspace-state, and the presentation lease
 * from the panel-runtime coordinator. Callers choose when fresh state matters;
 * the service does not inject snapshots into model requests.
 *
 * Two halves are deliberately NOT served here and say so on the wire:
 *
 *  - console counts. Reading console bodies must record external context
 *    ingestion (that is what makes the integrity latch honest), and there is no
 *    server-side log store to count from without a CDP round trip. `describe`
 *    records nothing, so it reports `available: false, via: "panel_console"`.
 *  - favicon / editable address / back-forward state. These live in the
 *    presenting shell's main-process registry. The spec allows fetching them
 *    from the active lease holder over the host-provider connection; that is a
 *    new provider command on both the Electron and headless hosts, which is
 *    more than a modest addition — see the TODO below. The *reported* view URL
 *    is server-resident (hosts already report it), so it is included.
 */

import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { isBrowserPanelSource } from "@vibestudio/shared/panelChrome";
import type { WorkspacePanelDetail } from "@vibestudio/shared/panel/workspaceStateSnapshot";
import {
  PANEL_CONTEXT_BOUNDARY_RESOLVER,
  PANEL_CONTEXT_POLICY,
  panelContextMethods,
  type PanelContextSnapshot,
} from "@vibestudio/service-schemas/panelContext";
import type {
  PanelAccessPermissionDeps,
  PanelAccessPermissionTarget,
} from "./panelAccessPermission.js";
import { preparePanelAccessAuthority } from "./panelAccessPermission.js";

/** Presentation lease facts, as the panel-runtime coordinator knows them. */
export interface PanelContextLease {
  state: "ready" | "loading" | "unavailable";
  url: string | null;
  surface: "desktop" | "headless" | "mobile" | null;
  hostConnectionId: string | null;
  holderLabel: string | null;
  supportsCdp: boolean;
  reachable: boolean;
}

export interface PanelContextSibling {
  slotId: string;
  title: string | null;
}

export interface PanelContextServiceDeps extends PanelAccessPermissionDeps {
  /** Durable slot/history/entity join, i.e. `workspace-state.panelTree.detail`. */
  getPanelDetail(panelId: string): Promise<WorkspacePanelDetail | null>;
  /** Open siblings under the same parent, excluding the panel itself. */
  getSiblings(panelId: string, parentSlotId: string | null): Promise<PanelContextSibling[]>;
  /** Current lease/observation for the slot. */
  getLease(panelId: string): PanelContextLease;
  /** Panel access target used for the context-boundary preparation. */
  getTarget(
    panelId: string
  ): Promise<PanelAccessPermissionTarget | null> | PanelAccessPermissionTarget | null;
}

export function createPanelContextService(deps: PanelContextServiceDeps): ServiceDefinition {
  async function requireTarget(panelId: string): Promise<PanelAccessPermissionTarget> {
    const target = await deps.getTarget(panelId);
    if (!target) throw new Error(`Panel not found: ${panelId}`);
    return target;
  }

  async function describe(panelId: string): Promise<PanelContextSnapshot> {
    const detail = await deps.getPanelDetail(panelId);
    if (!detail) throw new Error(`Panel not found: ${panelId}`);
    const source = detail.currentHistory.source;
    const lease = deps.getLease(panelId);
    return {
      panelId,
      tree: {
        slotId: detail.slot.slot_id,
        parentSlotId: detail.slot.parent_slot_id,
        title: detail.slot.current_entity_title ?? null,
        siblings: await deps.getSiblings(panelId, detail.slot.parent_slot_id),
        stateArgs: detail.currentHistory.state_args,
        createdAt: detail.slot.created_at,
      },
      source: {
        source,
        repoPath: detail.entity.source.repoPath,
        effectiveVersion: detail.entity.source.effectiveVersion,
        executionDigest: detail.entity.activeExecutionDigest ?? null,
        contextId: detail.currentHistory.context_id,
        entityId: detail.entity.id,
        kind: isBrowserPanelSource(source) ? "browser" : "workspace",
      },
      presentation: lease,
      console: {
        available: false,
        reason: "counts-require-cdp-read",
        via: "panel_console",
      },
      // TODO(panel-context): fetch favicon / editable address / canGoBack /
      // canGoForward from the active lease holder over the CDP host-provider
      // connection (`src/server/cdpBridge.ts` sendHostCommand) once a
      // `describePresentation` host command exists on both the Electron shell
      // (src/main/services/panelShellService.ts) and apps/headless-host. Until
      // then this stays an honest absence — never a fabricated address.
      address: { available: false, reason: "presentation-local" },
    };
  }

  return {
    name: "panelContext",
    description: "Aggregate panel identity, tree position, and presentation lease",
    authority: PANEL_CONTEXT_POLICY,
    methods: panelContextMethods,
    authorityPreparation: {
      [PANEL_CONTEXT_BOUNDARY_RESOLVER]: async (ctx: ServiceContext, args: unknown[]) => {
        const target = await requireTarget(String(args[0]));
        return {
          selections: await preparePanelAccessAuthority(deps, ctx, "cdp", target),
          payload: null,
        };
      },
    },
    handler: defineServiceHandler("panelContext", panelContextMethods, {
      describe: (_ctx, [panelId]) => describe(panelId),
    }),
  };
}
