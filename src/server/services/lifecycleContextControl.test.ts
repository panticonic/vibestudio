import { describe, expect, it, vi } from "vitest";
import {
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
