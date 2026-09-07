import { describe, expect, it } from "vitest";
import { createOpenUnitReviewLookup, unitReviewCodeKey } from "./openUnitReviewLookup";

const extension = { repoPath: "extensions/templates", effectiveVersion: "current" };
const panel = { repoPath: "about/new", effectiveVersion: "current" };
function fixture() {
  const deps = {
    listPendingReviews: () => [
      { approvalId: "review-uuid", title: "Template tools", parts: [extension] },
    ],
    isLaunchGateRepoPath: (repoPath: string) =>
      repoPath.startsWith("extensions/") || repoPath.startsWith("apps/"),
    creationReviewOwed: () => true,
    creationReviewUnits: (): ReadonlySet<string> | null => null,
    hasVersion: () => false,
  };
  return { deps, lookup: createOpenUnitReviewLookup(deps) };
}

describe("production unit review lookup policies", () => {
  it("explains the exact queued review for an unavailable declared extension while leaving running launch-gate code usable", () => {
    const { lookup } = fixture();
    expect(lookup.forUnavailableCode(extension)).toEqual({
      approvalId: "review-uuid",
      title: "Template tools",
    });
    expect(lookup.forRunningCode(extension)).toBeNull();
    expect(
      lookup.forRunningCode({ repoPath: "apps/shell", effectiveVersion: "current" })
    ).toBeNull();
  });

  it("never invents a creation review for an unavailable launch-gate extension", () => {
    const { lookup } = fixture();
    expect(lookup.forUnavailableCode({ ...extension, effectiveVersion: "different" })).toBeNull();
    expect(
      lookup.forUnavailableCode({ ...extension, repoPath: "extensions/browser-data" })
    ).toBeNull();
  });

  it("retains ordinary-code creation review semantics until the exact owed set is known", () => {
    const { deps, lookup } = fixture();
    expect(lookup.forRunningCode(panel)?.approvalId).toBe("workspace-creation-review");
    deps.creationReviewUnits = () => new Set([unitReviewCodeKey(panel)]);
    expect(lookup.forRunningCode(panel)?.approvalId).toBe("workspace-creation-review");
    expect(lookup.forRunningCode({ ...panel, effectiveVersion: "other" })).toBeNull();
    deps.creationReviewOwed = () => false;
    expect(lookup.forRunningCode(panel)).toBeNull();
  });
});
