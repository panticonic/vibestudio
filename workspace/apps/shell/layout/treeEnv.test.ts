import { describe, expect, it } from "vitest";
import { observedPanelDeletions } from "./treeEnv";

const panelMap = (...ids: string[]) => new Map(ids.map((id) => [id, {} as never]));

describe("observedPanelDeletions", () => {
  it("does not mistake presentation ahead of query-first discovery for deletion", () => {
    expect(
      observedPanelDeletions(
        ["newly-presented"],
        { panelMap: panelMap() },
        { panelMap: panelMap() }
      )
    ).toEqual([]);
  });

  it("returns a visible panel that disappeared from an established projection", () => {
    expect(
      observedPanelDeletions(
        ["kept", "deleted"],
        { panelMap: panelMap("kept", "deleted") },
        { panelMap: panelMap("kept") }
      )
    ).toEqual(["deleted"]);
  });
});
