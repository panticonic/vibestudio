import { describe, expect, it, vi } from "vitest";
import { createHostCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { WorkspacePanelDetail } from "@vibestudio/shared/panel/workspaceStateSnapshot";
import type { PanelContextSnapshot } from "@vibestudio/service-schemas/panelContext";
import { PanelContextSnapshotSchema } from "@vibestudio/service-schemas/panelContext";
import { createPanelContextService, type PanelContextLease } from "./panelContextService.js";

const ctx: ServiceContext = { caller: createHostCaller("server") };

function detailFor(source: string): WorkspacePanelDetail {
  return {
    revision: 7,
    slot: {
      slot_id: "slot-a",
      parent_slot_id: "slot-root",
      current_entity_id: "panel:entry-1",
      current_entity_title: "Sales Dashboard",
      current_entry_key: "entry-1",
      sort_key: 0,
      created_at: 1_000,
      closed_at: null,
    } as WorkspacePanelDetail["slot"],
    currentHistory: {
      slot_id: "slot-a",
      cursor: 0,
      entry_key: "entry-1",
      entity_id: "panel:entry-1",
      source,
      context_id: "ctx-panel",
      state_args: '{"tab":"q3"}',
      recorded_at: 1_000,
    } as WorkspacePanelDetail["currentHistory"],
    entity: {
      id: "panel:entry-1",
      kind: "panel",
      source: { repoPath: "panels/sales-dash", effectiveVersion: "ev-1" },
      activeExecutionDigest: "a".repeat(64),
      contextId: "ctx-panel",
      key: "entry-1",
      createdAt: 1_000,
      status: "active",
      cleanupComplete: true,
    } as WorkspacePanelDetail["entity"],
  };
}

const readyLease: PanelContextLease = {
  state: "ready",
  url: "https://example.test/q3",
  surface: "desktop",
  hostConnectionId: "host-1",
  holderLabel: "Desktop",
  supportsCdp: true,
  reachable: true,
};

function makeService(
  overrides: {
    source?: string;
    lease?: PanelContextLease;
    detail?: WorkspacePanelDetail | null;
  } = {}
) {
  const getSiblings = vi.fn(async () => [{ slotId: "slot-b", title: "Import wizard" }]);
  const definition = createPanelContextService({
    getPanelDetail: async () =>
      overrides.detail === undefined
        ? detailFor(overrides.source ?? "panels/sales-dash")
        : overrides.detail,
    getSiblings,
    getLease: () => overrides.lease ?? readyLease,
    getTarget: async () => ({ id: "slot-a", kind: "workspace", contextId: "ctx-panel" }),
    contextExists: () => true,
    resolveCallerContext: async () => null,
    resolveEntityContext: () => null,
    controlsLifecycleContext: async () => false,
    resolveSubjectCaller: () => null,
    resolveContextOwnerLabel: () => undefined,
  } as never);
  const describe_ = (panelId: string) =>
    definition.handler(ctx, "describe", [panelId]) as Promise<PanelContextSnapshot>;
  return { definition, describe: describe_, getSiblings };
}

describe("panelContext.describe", () => {
  it("returns the complete server-resident snapshot", async () => {
    const { describe: run, getSiblings } = makeService();
    const snapshot = await run("slot-a");

    expect(() => PanelContextSnapshotSchema.parse(snapshot)).not.toThrow();
    expect(snapshot.tree).toEqual({
      slotId: "slot-a",
      parentSlotId: "slot-root",
      title: "Sales Dashboard",
      siblings: [{ slotId: "slot-b", title: "Import wizard" }],
      stateArgs: '{"tab":"q3"}',
      createdAt: 1_000,
    });
    expect(snapshot.source).toEqual({
      source: "panels/sales-dash",
      repoPath: "panels/sales-dash",
      effectiveVersion: "ev-1",
      executionDigest: "a".repeat(64),
      contextId: "ctx-panel",
      entityId: "panel:entry-1",
      kind: "workspace",
    });
    expect(snapshot.presentation).toEqual(readyLease);
    expect(getSiblings).toHaveBeenCalledWith("slot-a", "slot-root");
  });

  it("classifies a browser panel by its source", async () => {
    const { describe: run } = makeService({ source: "browser:https://example.test/" });
    expect((await run("slot-a")).source.kind).toBe("browser");
  });

  it("reports console counts and presentation-local facts as explicitly absent", async () => {
    const { describe: run } = makeService();
    const snapshot = await run("slot-a");
    // Never a fabricated zero: an agent told "unknown" reaches for the tool,
    // an agent told "0 errors" stops looking.
    expect(snapshot.console).toEqual({
      available: false,
      reason: "counts-require-cdp-read",
      via: "panel_console",
    });
    expect(snapshot.address).toEqual({ available: false, reason: "presentation-local" });
  });

  it("surfaces an unavailable lease honestly instead of implying readiness", async () => {
    const { describe: run } = makeService({
      lease: {
        state: "unavailable",
        url: null,
        surface: null,
        hostConnectionId: null,
        holderLabel: null,
        supportsCdp: false,
        reachable: false,
      },
    });
    const snapshot = await run("slot-a");
    expect(snapshot.presentation.state).toBe("unavailable");
    expect(snapshot.presentation.supportsCdp).toBe(false);
  });

  it("fails loudly for an unknown panel", async () => {
    const { describe: run } = makeService({ detail: null });
    await expect(run("missing")).rejects.toThrow("Panel not found: missing");
  });

  it("prepares the same context-boundary leaf panelCdp does", () => {
    const { definition } = makeService();
    const schema = definition.methods["describe"];
    expect(schema?.capability).toBe("panel.inspect");
    const authority = schema?.authority as { prepared?: { resolver?: string; leaves?: unknown[] } };
    expect(authority.prepared?.resolver).toBe("panelContext.describe.contextBoundary");
    expect(definition.authorityPreparation?.["panelContext.describe.contextBoundary"]).toBeTypeOf(
      "function"
    );
  });
});
