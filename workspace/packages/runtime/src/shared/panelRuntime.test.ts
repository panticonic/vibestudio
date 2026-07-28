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

  it("keeps observing across a nonterminal target handoff", async () => {
    const { runtime, call } = runtimeWith(observation("building"), [
      observation("loading"),
      observation("ready"),
    ]);

    await expect(runtime.openPanel("panels/new")).resolves.toMatchObject({
      id: "panel:tree/new",
      source: "panels/new",
    });
    expect(call.mock.calls.map((entry) => entry[1])).toEqual([
      "panelTree.create",
      "panelTree.observe",
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

describe("panel runtime recursive orchestration", () => {
  it("hydrates one revisioned subtree with depth, leaves, and live handles", async () => {
    interface TestNode {
      panelId: string;
      title: string;
      source: string;
      kind: "workspace" | "browser";
      parentId: string | null;
      contextId: string;
      children: TestNode[];
    }
    const makePanel = (
      id: string,
      title: string,
      source: string,
      parentId: string | null,
      children: TestNode[] = []
    ): TestNode => ({
      panelId: id,
      title,
      source,
      kind: source.startsWith("browser:") ? "browser" : "workspace",
      parentId,
      contextId: `ctx:${id}`,
      children,
    });
    const call = vi.fn(async (_target: string, method: string) => {
      if (method !== "panelTree.getSubtree") {
        throw new Error(`Unexpected RPC method: ${method}`);
      }
      return {
        revision: 17,
        root: makePanel("root", "Research", "about/collection", null, [
          makePanel("group", "Window 1", "about/collection", "root", [
            makePanel("browser", "Example", "browser:https://example.com/", "group"),
          ]),
        ]),
      };
    });
    const runtime = createPanelRuntime({
      rpc: { call, emit: vi.fn(), on: vi.fn() } as never,
      createCdp: () => ({}) as never,
    });

    const scope = await runtime.panelTree.subtree("root");

    expect(scope.revision).toBe(17);
    expect(scope.nodes.map((node) => [node.handle.id, node.depth])).toEqual([
      ["root", 0],
      ["group", 1],
      ["browser", 2],
    ]);
    expect(scope.leaves.map((node) => node.handle.id)).toEqual(["browser"]);
    expect(scope.leaves[0]?.handle).toMatchObject({
      kind: "browser",
      source: "https://example.com/",
      parentId: "group",
    });
    await expect(runtime.panelTree.descendants("root")).resolves.toHaveLength(2);
  });

  it("renames an arbitrary slot without requiring it to be loaded", async () => {
    const call = vi.fn(async () => undefined);
    const runtime = createPanelRuntime({
      rpc: { call, emit: vi.fn(), on: vi.fn() } as never,
      createCdp: () => ({}) as never,
    });
    const handle = runtime.panelTree.get("panel:tree/browser", "browser");

    await handle.setTitle("Support inbox", { explicit: true });

    expect(call).toHaveBeenCalledWith("main", "panelTree.setTitle", [
      "panel:tree/browser",
      "Support inbox",
      { explicit: true },
    ]);
    expect(handle.title).toBe("Support inbox");
  });
});
