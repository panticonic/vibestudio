import { describe, expect, it } from "vitest";
import {
  PanelTreePageSchema,
  RawPanelTreePageSchema,
  RawSlotRowSchema,
  SlotRowSchema,
} from "./workspaceState.js";

const slot = {
  slot_id: "panel:one",
  parent_slot_id: null,
  current_entity_id: "entity:one",
  current_entry_key: "entry:one",
  sort_key: 1,
  created_at: 1,
  closed_at: null,
};

describe("workspace-state presentation boundary", () => {
  it("separates raw durable slot rows from composed service rows", () => {
    expect(
      RawSlotRowSchema.safeParse({ ...slot, current_entity_title: "Owned by Base" }).success
    ).toBe(false);
    expect(
      SlotRowSchema.safeParse({ ...slot, current_entity_title: "Owned by Base" }).success
    ).toBe(true);
  });

  it("accepts topology only internally and presentation only at the service boundary", () => {
    const page = {
      revision: 1,
      group: { kind: "roots", ownerUserId: null },
      nodes: [
        {
          slotId: "panel:one",
          parentSlotId: null,
          ownerUserId: null,
          createdAt: 1,
          childCount: 0,
          source: "panels/chat",
        },
      ],
      nextCursor: null,
    };
    expect(RawPanelTreePageSchema.safeParse(page).success).toBe(true);
    expect(PanelTreePageSchema.safeParse(page).success).toBe(false);
    for (const productField of [
      { title: "Chat" },
      { icon: "chat" },
      { kind: "workspace" },
      { ref: "main" },
      { placement: { disposition: "side" } },
    ]) {
      expect(
        RawPanelTreePageSchema.safeParse({
          ...page,
          nodes: [{ ...page.nodes[0], ...productField }],
        }).success
      ).toBe(false);
    }
    expect(
      PanelTreePageSchema.safeParse({
        ...page,
        nodes: [{ ...page.nodes[0], title: "Chat", icon: "chat", kind: "workspace" }],
      }).success
    ).toBe(true);
  });
});
