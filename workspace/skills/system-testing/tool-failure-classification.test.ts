import { describe, expect, it } from "vitest";
import {
  isPreExecutionArgumentRejection,
  isSafeVcsDomainRejection,
} from "./tool-failure-classification.js";

describe("tool failure classification", () => {
  it("recognizes only pre-dispatch argument validation failures", () => {
    expect(isPreExecutionArgumentRejection("Invalid arguments for tool vcs: bad operation")).toBe(
      true
    );
    expect(isPreExecutionArgumentRejection("[vcs.push] publication failed")).toBe(false);
  });

  it("keeps safe typed VCS refusals diagnostic-only", () => {
    expect(isSafeVcsDomainRejection("vcs", "WorkingChangesPresent")).toBe(true);
    expect(isSafeVcsDomainRejection("commit", "RevisionChanged")).toBe(true);
  });

  it("does not hide authorization, integrity, or untyped failures", () => {
    expect(isSafeVcsDomainRejection("vcs", "Unauthorized")).toBe(false);
    expect(isSafeVcsDomainRejection("vcs", "IntegrityFailure")).toBe(false);
    expect(isSafeVcsDomainRejection("eval", "WorkingChangesPresent")).toBe(false);
    expect(isSafeVcsDomainRejection("vcs", undefined)).toBe(false);
  });
});
