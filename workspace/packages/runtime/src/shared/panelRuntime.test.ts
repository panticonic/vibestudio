import { describe, expect, it, vi } from "vitest";
import { ledgerTest } from "../../../../tests/helpers/ledgerTest.js";
import { createPanelRuntime } from "./panelRuntime.js";

const WORKSPACE_STATE_TARGET = "do:vibestudio/internal:WorkspaceDO:workspace";

function readyHostReport() {
  return {
    lease: {
      holderLabel: "Headless",
      platform: "headless" as const,
      supportsCdp: true,
    },
    observation: {
      url: "http://panel.test/",
      loading: false,
      boot: { phase: "ready" as const, updatedAt: 1 },
    },
  };
}

function detail(
  slotId: string,
  entityId = "panel:nav-new",
  source = "panels/new"
) {
  return {
    slot: { parent_slot_id: null, current_entity_title: "New" },
    currentHistory: {
      source,
      context_id: "ctx:test",
      state_args: "{}",
      options: '{"ref":"main"}',
    },
    entity: {
      id: entityId,
      source: { effectiveVersion: "ev-new" },
      activeBuildKey: "build-new",
    },
  };
}

function runtimeHarness(options: { hostAvailable?: boolean } = {}) {
  let currentSlotId = "panel:tree/new";
  let currentEntityId = "panel:nav-new";
  const call = vi.fn(async <T>(_target: string, method: string, args: unknown[]): Promise<T> => {
    switch (method) {
      case "workers.resolveService":
        return { kind: "durable-object", targetId: WORKSPACE_STATE_TARGET } as T;
      case "build.getPanelMetadata":
        return { title: "New" } as T;
      case "runtime.reserveEntity":
        return {
          id: currentEntityId,
          contextId: "ctx:test",
          source: { effectiveVersion: "" },
        } as T;
      case "runtime.activateReservedEntity":
      case "runtime.createEntity": {
        const spec = args[0] as { key: string; contextId?: string };
        currentEntityId =
          method === "runtime.createEntity" ? `panel:${spec.key}` : currentEntityId;
        return {
          id: currentEntityId,
          contextId: spec.contextId ?? "ctx:test",
          source: { effectiveVersion: "ev-new" },
          buildKey: "build-new",
        } as T;
      }
      case "slotCreate": {
        currentSlotId = (args[0] as { slotId: string }).slotId;
        return undefined as T;
      }
      case "slotCommitPreparedNavigation": {
        const input = args[0] as {
          mutation: { entry: { entityId: string } };
          expectedCurrentEntityId: string;
        };
        const previousEntityId = input.expectedCurrentEntityId;
        currentEntityId = input.mutation.entry.entityId;
        return { previousEntityId, currentEntityId } as T;
      }
      case "panelTreeDetail":
        return detail(String(args[0]), currentEntityId) as T;
      case "panelRuntime.ensureSlot":
        return {
          status: options.hostAvailable === false ? "unavailable" : "assigned",
          lease: null,
        } as T;
      case "panelRuntime.observeSlot":
        return readyHostReport() as T;
      case "panelUpdateTitle":
      case "panelRuntime.handoffSlot":
      case "runtime.retireEntity":
      case "view.focusPanel":
        return undefined as T;
      case "panelTreePage": {
        const input = args[0] as { group: { parentSlotId: string } };
        return {
          revision: 17,
          group: input.group,
          nodes: [
            {
              slotId: "browser",
              title: "Example",
              source: "browser:https://example.com/",
              kind: "browser",
              parentSlotId: input.group.parentSlotId,
              ownerUserId: null,
              contextId: "ctx:browser",
              createdAt: 1,
              childCount: 0,
            },
          ],
          nextCursor: null,
        } as T;
      }
      case "panelTreePath":
        return {
          revision: 17,
          nodes: [
            {
              slotId: "root",
              title: "Research",
              source: "about/collection",
              kind: "workspace",
              parentSlotId: null,
              ownerUserId: null,
              contextId: "ctx:root",
              createdAt: 1,
              childCount: 1,
            },
          ],
        } as T;
      default:
        throw new Error(`Unexpected RPC method: ${method} for ${currentSlotId}`);
    }
  });
  return {
    call,
    runtime: createPanelRuntime({
      rpc: { call, emit: vi.fn(), on: vi.fn() } as never,
      defaultOpenParentId: null,
      createCdp: () => ({}) as never,
    }),
  };
}

describe("panel runtime topology composition", () => {
  ledgerTest("execution.panel", async () => {
    const { runtime, call } = runtimeHarness();

    await expect(
      runtime.openPanel("panels/new", { slug: "new", focus: false })
    ).resolves.toMatchObject({
      id: "panel:tree/new",
      source: "panels/new",
    });

    const methods = call.mock.calls.map((entry) => entry[1]);
    expect(methods).toEqual(
      expect.arrayContaining([
        "runtime.reserveEntity",
        "slotCreate",
        "runtime.activateReservedEntity",
        "panelRuntime.ensureSlot",
        "panelRuntime.observeSlot",
      ])
    );
    expect(methods).not.toContain("panelTree.create");
    expect(methods).not.toContain("panelTree.observe");
  });

  it("reports an unavailable presentation host as the exact lifecycle failure", async () => {
    const { runtime } = runtimeHarness({ hostAvailable: false });

    await expect(
      runtime.openPanel("panels/new", { slug: "new", focus: false })
    ).rejects.toMatchObject({
      code: "PANEL_OPERATION_FAILED",
      failure: { code: "host_unavailable", stage: "host" },
    });
  });

  it("navigates through runtime creation, an atomic builtin commit, and lease handoff", async () => {
    const { runtime, call } = runtimeHarness();

    await expect(
      runtime.panelTree.get("panel:tree/new").navigate("panels/next", {
        contextId: "ctx:test",
      })
    ).resolves.toMatchObject({ panelId: "panel:tree/new", phase: "ready" });

    const methods = call.mock.calls.map((entry) => entry[1]);
    expect(methods).toEqual(
      expect.arrayContaining([
        "runtime.createEntity",
        "slotCommitPreparedNavigation",
        "panelRuntime.handoffSlot",
      ])
    );
    expect(methods).not.toContain("panelTree.navigate");
  });

  it("hydrates bounded builtin pages and paths with live handles", async () => {
    const { runtime } = runtimeHarness();

    const page = await runtime.panelTree.page({
      group: { kind: "children", parentSlotId: "group" },
      limit: 50,
    });
    expect(page).toMatchObject({
      revision: 17,
      entries: [{ handle: { id: "browser", kind: "browser", parentId: "group" } }],
    });
    await expect(runtime.panelTree.path("root")).resolves.toMatchObject({
      revision: 17,
      entries: [{ handle: { id: "root" } }],
    });
  });

  it("renames an arbitrary slot directly on the builtin topology owner", async () => {
    const { runtime, call } = runtimeHarness();
    const handle = runtime.panelTree.get("panel:tree/browser", "browser");

    await handle.setTitle("Support inbox", { explicit: true });

    expect(call).toHaveBeenCalledWith(WORKSPACE_STATE_TARGET, "panelUpdateTitle", [
      "panel:tree/browser",
      "Support inbox",
      { explicit: true },
    ]);
    expect(handle.title).toBe("Support inbox");
  });
});
