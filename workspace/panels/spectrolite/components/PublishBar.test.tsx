import { describe, expect, it } from "vitest";
import { getPublishPresentation } from "./publishPresentation.js";

describe("publish presentation", () => {
  it("describes divergence as a synchronization obligation", () => {
    const presentation = getPublishPresentation(
      {
        pendingChanges: 2,
        relationship: "diverged",
        publishing: false,
        lastError: null,
        conflicts: [],
      },
      0
    );
    expect(presentation.statusLabel).toContain("Needs sync");
    expect(presentation.hasChanges).toBe(true);
  });
});
