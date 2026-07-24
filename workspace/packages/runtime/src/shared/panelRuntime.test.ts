import { describe, expect, it, vi } from "vitest";
import { panelFailure, type PanelObservation } from "@vibestudio/shared/panel/observation";
import { createPanelRuntime } from "./panelRuntime.js";

function observation(
  phase: PanelObservation["phase"],
  failure?: PanelObservation["failure"]
): PanelObservation {
  return {
    panelId: "panel:tree/new",
    title: "New",
    source: "panels/new",
    kind: "workspace",
    parentId: null,
    contextId: "ctx:test",
    requestedRef: "main",
    runtimeEntityId: "panel:nav-new",
    attemptId: `panel:nav-new@${"b".repeat(64)}`,
    effectiveVersion: "e".repeat(64),
    buildKey: "b".repeat(64),
    phase,
    ...(failure ? { failure } : {}),
    updatedAt: Date.now(),
  };
}

function runtimeWith(createObservation: PanelObservation, observed: PanelObservation[]) {
  const call = vi.fn(async (_target: string, method: string) => {
    if (method === "panelTree.create") {
      return {
        id: "panel:tree/new",
        title: "New",
        source: "panels/new",
        kind: "workspace",
        parentId: null,
        contextId: "ctx:test",
        runtimeEntityId: "panel:nav-new",
        effectiveVersion: "e".repeat(64),
        buildKey: "b".repeat(64),
        observation: createObservation,
      };
    }
    if (method === "panelTree.observe") {
      const next = observed.shift();
      if (!next) throw new Error("Unexpected extra observation");
      return next;
    }
    throw new Error(`Unexpected RPC method: ${method}`);
  });
  const runtime = createPanelRuntime({
    rpc: { call, emit: vi.fn(), on: vi.fn() } as never,
    defaultOpenParentId: null,
    createCdp: () => ({}) as never,
  });
  return { runtime, call };
}

describe("panel runtime openPanel lifecycle", () => {
  it("creates the slot immediately but resolves the SDK handle only when that attempt is ready", async () => {
    const { runtime, call } = runtimeWith(observation("building"), [observation("ready")]);

    await expect(runtime.openPanel("panels/new")).resolves.toMatchObject({
      id: "panel:tree/new",
      source: "panels/new",
    });
    expect(call.mock.calls.map((entry) => entry[1])).toEqual([
      "panelTree.create",
      "panelTree.observe",
    ]);
  });

  it("rejects with the exact structured asynchronous lifecycle failure", async () => {
    const failure = panelFailure({
      code: "host_unavailable",
      stage: "host",
      message: "No inspectable host accepted the panel lease",
      provenance: {
        panelId: "panel:tree/new",
        runtimeEntityId: "panel:nav-new",
        source: "panels/new",
        contextId: "ctx:test",
        requestedRef: "main",
        buildKey: "b".repeat(64),
      },
    });
    const { runtime } = runtimeWith(observation("failed", failure), []);

    await expect(runtime.openPanel("panels/new")).rejects.toMatchObject({
      code: "PANEL_OPERATION_FAILED",
      failure: {
        code: "host_unavailable",
        stage: "host",
        diagnosticId: failure.diagnosticId,
      },
    });
  });
});
