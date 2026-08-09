import { describe, expect, it } from "vitest";
import { getPublishPresentation } from "./publishPresentation.js";

describe("publish presentation", () => {
  const snapshot = {
    pendingChanges: 0,
    relationship: "at" as const,
    publishing: false,
    lastError: null,
    conflicts: [],
  };

  it("distinguishes editor text still saving from a durable working change", () => {
    expect(getPublishPresentation(snapshot, 1).statusLabel).toBe("Saving 1 note…");
    expect(
      getPublishPresentation({ ...snapshot, pendingChanges: 2 }, 0).statusLabel
    ).toBe("2 saved local changes");
  });

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
