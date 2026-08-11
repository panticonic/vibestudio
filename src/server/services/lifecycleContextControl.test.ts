import { describe, expect, it, vi } from "vitest";
import {
  callerControlsContextTransition,
  callerControlsLifecycleContext,
  type LifecycleContextControlStore,
} from "./lifecycleContextControl.js";

function store(input: {
  ownerEntityId?: string | null;
  ownerParentId?: string | null;
}): LifecycleContextControlStore {
  return {
    listContextEdgesByOwner: vi.fn(async ({ kind }) => {
      expect(kind).toBe("lifecycle");
      return input.ownerEntityId === undefined
        ? []
        : [
            {
              contextId: "ctx-child",
              kind: "lifecycle" as const,
              ownerEntityId: input.ownerEntityId,
            },
          ];
    }),
    listContextEdgesByChild: vi.fn(async () => []),
    resolveRecord: vi.fn(async (id) => ({ id, parentId: input.ownerParentId ?? undefined })),
  };
}

describe("callerControlsLifecycleContext", () => {
  it("accepts an exact lifecycle owner", async () => {
    await expect(
      callerControlsLifecycleContext(
        store({ ownerEntityId: "do:owner" }),
        "do:owner",
        "ctx-parent",
        "ctx-child"
      )
    ).resolves.toBe(true);
  });

  it("accepts the direct creator of the lifecycle owner", async () => {
    await expect(
      callerControlsLifecycleContext(
        store({ ownerEntityId: "do:owner", ownerParentId: "panel:supervisor" }),
        "panel:supervisor",
        "ctx-parent",
        "ctx-child"
      )
    ).resolves.toBe(true);
  });

  it("rejects unrelated callers, missing edges, and callers without an origin context", async () => {
    await expect(
      callerControlsLifecycleContext(
        store({ ownerEntityId: "do:owner", ownerParentId: "panel:other" }),
        "panel:requester",
        "ctx-parent",
        "ctx-child"
      )
    ).resolves.toBe(false);
    await expect(
      callerControlsLifecycleContext(store({}), "panel:requester", "ctx-parent", "ctx-child")
    ).resolves.toBe(false);
    await expect(
      callerControlsLifecycleContext(
        store({ ownerEntityId: "panel:requester" }),
        "panel:requester",
        null,
        "ctx-child"
      )
    ).resolves.toBe(false);
  });
});

describe("callerControlsContextTransition", () => {
  function lineageStore(input: {
    edges: Array<{
      childContextId: string;
      ownerContextId: string;
      ownerEntityId: string | null;
    }>;
    parents?: Record<string, string | undefined>;
  }): LifecycleContextControlStore {
    return {
      listContextEdgesByOwner: vi.fn(async () => []),
      listContextEdgesByChild: vi.fn(async (contextId) =>
        input.edges
          .filter((edge) => edge.childContextId === contextId)
          .map((edge) => ({
            ownerContextId: edge.ownerContextId,
            kind: "lineage" as const,
            ownerEntityId: edge.ownerEntityId,
          }))
      ),
      resolveRecord: vi.fn(async (id) => ({ id, parentId: input.parents?.[id] })),
    };
  }

  it("allows parent, child, and sibling branch navigation through owned lineage", async () => {
    const controlStore = lineageStore({
      edges: [
        {
          childContextId: "ctx-a",
          ownerContextId: "ctx-root",
          ownerEntityId: "panel:root",
        },
        {
          childContextId: "ctx-b",
          ownerContextId: "ctx-root",
          ownerEntityId: "panel:root",
        },
        {
          childContextId: "ctx-grandchild",
          ownerContextId: "ctx-a",
          ownerEntityId: "panel:a",
        },
      ],
      parents: { "panel:a": "panel:root", "panel:grandchild": "panel:a" },
    });

    await expect(
      callerControlsContextTransition(controlStore, "panel:root", "ctx-root", "ctx-a")
    ).resolves.toBe(true);
    await expect(
      callerControlsContextTransition(controlStore, "panel:a", "ctx-a", "ctx-root")
    ).resolves.toBe(true);
    await expect(
      callerControlsContextTransition(controlStore, "panel:a", "ctx-a", "ctx-b")
    ).resolves.toBe(true);
    await expect(
      callerControlsContextTransition(
        controlStore,
        "panel:grandchild",
        "ctx-grandchild",
        "ctx-root"
      )
    ).resolves.toBe(true);
  });

  it("rejects lineage without an owner, unrelated callers, and corrupt multiple parents", async () => {
    await expect(
      callerControlsContextTransition(
        lineageStore({
          edges: [{ childContextId: "ctx-child", ownerContextId: "ctx-root", ownerEntityId: null }],
        }),
        "panel:any",
        "ctx-root",
        "ctx-child"
      )
    ).resolves.toBe(false);
    await expect(
      callerControlsContextTransition(
        lineageStore({
          edges: [
            {
              childContextId: "ctx-child",
              ownerContextId: "ctx-root",
              ownerEntityId: "panel:owner",
            },
          ],
        }),
        "panel:unrelated",
        "ctx-root",
        "ctx-child"
      )
    ).resolves.toBe(false);
    await expect(
      callerControlsContextTransition(
        lineageStore({
          edges: [
            {
              childContextId: "ctx-child",
              ownerContextId: "ctx-root-a",
              ownerEntityId: "panel:owner",
            },
            {
              childContextId: "ctx-child",
              ownerContextId: "ctx-root-b",
              ownerEntityId: "panel:owner",
            },
          ],
        }),
        "panel:owner",
        "ctx-root-a",
        "ctx-child"
      )
    ).resolves.toBe(false);
  });
});
