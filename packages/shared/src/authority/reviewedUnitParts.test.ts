import { describe, expect, it } from "vitest";
import type { ReviewedUnit } from "../approvals.js";
import { hostBuildOrigin, installReviewPartTitle, reviewedUnitPart } from "./reviewedUnitParts.js";

function unit(repo: string, unitName: string, displayName: string): ReviewedUnit {
  return {
    unitKind: repo.startsWith("panels/") ? "panel" : "worker",
    unitName,
    displayName,
    source: { kind: "workspace-repo", repo, ref: "main" },
    ev: "ev-1",
    capabilities: [],
  };
}

describe("install-review part names", () => {
  it.each([
    ["panels/chat", "chat"],
    ["workers/agent-worker", "agent-worker"],
    ["about/browser-import-inspector", "browser-import-inspector"],
  ])("uses the repo leaf for %s", (repo, expected) => {
    expect(installReviewPartTitle(repo)).toBe(expected);
  });

  it("keeps package and manifest identities out of user-facing titles", () => {
    const part = reviewedUnitPart({
      unit: unit("panels/chat", "@workspace-panels/chat", "Agentic Chat"),
      identityKey: "panels/chat@ev-1",
      origin: hostBuildOrigin("1.0.0"),
    });

    expect(part.title).toBe("chat");
    expect(part.name).toBe("@workspace-panels/chat");
    expect(part.displayName).toBe("Agentic Chat");
  });

  it("rejects a missing repo identity instead of falling back to package machinery", () => {
    expect(() => installReviewPartTitle("")).toThrow("canonical repo path");
  });
});
