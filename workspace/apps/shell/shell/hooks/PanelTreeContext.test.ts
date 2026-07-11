import { describe, expect, it } from "vitest";
import type { Panel } from "@vibestudio/shared/types";
import { coercePanelTreeUpdate } from "./panelTreeRevision";

function panel(id: string): Panel {
  return {
    id,
    title: id,
    children: [],
    snapshot: {
      source: `panels/${id}`,
      contextId: `ctx-${id}`,
      options: {},
    },
    artifacts: {},
  };
}

describe("coercePanelTreeUpdate", () => {
  it("accepts newer revisioned forest snapshots", () => {
    const root = panel("root");

    expect(
      coercePanelTreeUpdate(
        {
          revision: 3,
          forest: [{ owner: "", rootPanels: [root] }],
        },
        2
      )
    ).toEqual({
      revision: 3,
      forest: [{ owner: "", rootPanels: [root] }],
    });
  });

  it("rejects stale revisioned snapshots", () => {
    expect(
      coercePanelTreeUpdate(
        {
          revision: 2,
          forest: [{ owner: "", rootPanels: [panel("old")] }],
        },
        3
      )
    ).toBeNull();
  });

  it("rejects pre-cutover array snapshots", () => {
    expect(coercePanelTreeUpdate([panel("array")], 0)).toBeNull();
  });

  it("rejects pre-forest flat rootPanels snapshots", () => {
    expect(coercePanelTreeUpdate({ revision: 1, rootPanels: [panel("flat")] }, 0)).toBeNull();
  });
});
