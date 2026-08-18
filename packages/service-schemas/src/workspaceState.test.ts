import { describe, expect, it } from "vitest";

import { workspaceStateMethods } from "./workspaceState.js";

const createInput = {
  slotId: "panel:tree/example",
  parentSlotId: null,
  initialEntry: {
    entryKey: "nav-example",
    entityId: "panel:nav-example",
    source: "browser:https://example.com/",
    contextId: "ctx-example",
  },
};

describe("workspace-state persisted panel options", () => {
  it("accepts canonical placement and preserves unrelated durable options", () => {
    expect(
      workspaceStateMethods["slot.create"].args.safeParse([
        {
          ...createInput,
          initialEntry: {
            ...createInput.initialEntry,
            options: {
              ref: "main",
              flags: { inspect: true },
              placement: { disposition: "side", preferredWidth: 640 },
            },
          },
        },
      ]).success,
    ).toBe(true);
  });

  it("rejects malformed placement before it reaches durable workspace state", () => {
    expect(
      workspaceStateMethods["slot.create"].args.safeParse([
        {
          ...createInput,
          initialEntry: {
            ...createInput.initialEntry,
            options: { placement: "replace" },
          },
        },
      ]).success,
    ).toBe(false);
  });

  it("rejects malformed references before they reach durable workspace state", () => {
    expect(
      workspaceStateMethods["slot.create"].args.safeParse([
        {
          ...createInput,
          initialEntry: {
            ...createInput.initialEntry,
            options: { ref: 42 },
          },
        },
      ]).success,
    ).toBe(false);
  });
});
