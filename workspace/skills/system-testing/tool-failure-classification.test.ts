import { describe, expect, it } from "vitest";
import {
  isEvalGuestCodeFailure,
  isPreExecutionArgumentRejection,
  isReadOnlyInputRejection,
  isSafeEvalDomainRejection,
  isSafeProvenanceDomainRejection,
  isSafeSubagentDomainRejection,
  isSafeVcsDomainRejection,
} from "./tool-failure-classification.js";

describe("tool failure classification", () => {
  it("recognizes only pre-dispatch argument validation failures", () => {
    expect(isPreExecutionArgumentRejection("Invalid arguments for tool vcs: bad operation")).toBe(
      true
    );
    expect(
      isPreExecutionArgumentRejection(
        '[tool.vcs:execute] unknown_tool_failure: Invalid arguments for tool vcs: /path: Expected string'
      )
    ).toBe(true);
    expect(
      isPreExecutionArgumentRejection(
        '{"details":{"failure":{"message":"[tool.vcs:execute] unknown_tool_failure: Invalid arguments for tool vcs: bad root"}}}'
      )
    ).toBe(true);
    expect(
      isPreExecutionArgumentRejection("The user wrote: Invalid arguments for tool vcs")
    ).toBe(false);
    expect(isPreExecutionArgumentRejection("[vcs.push] publication failed")).toBe(false);
  });

  it("recognizes typed no-effect path rejection from read-only runtime tools", () => {
    const failure = {
      details: {
        failure: {
          protocol: "agent-tool-failure.v1",
          kind: "invalid-input",
          retry: { policy: "correct-input" },
        },
      },
    };
    expect(isReadOnlyInputRejection("read", failure)).toBe(true);
    expect(isReadOnlyInputRejection("write", failure)).toBe(false);
  });

  it("keeps an exact-root provenance miss diagnostic-only", () => {
    expect(isSafeProvenanceDomainRejection("provenance", "InvalidReference")).toBe(true);
    expect(isSafeProvenanceDomainRejection("provenance", "Unauthorized")).toBe(false);
    expect(isSafeProvenanceDomainRejection("vcs", "InvalidReference")).toBe(false);
  });

  it("keeps safe typed VCS refusals diagnostic-only", () => {
    expect(isSafeVcsDomainRejection("vcs", "WorkingChangesPresent")).toBe(true);
    expect(isSafeVcsDomainRejection("vcs", "RevisionChanged")).toBe(true);
    expect(isSafeVcsDomainRejection("vcs", "BuildGateFailed")).toBe(true);
    expect(isSafeVcsDomainRejection("commit", "RevisionChanged")).toBe(false);
    expect(isSafeVcsDomainRejection("vcs", "InvalidReference")).toBe(true);
  });

  it("does not hide authorization, integrity, or untyped failures", () => {
    expect(isSafeVcsDomainRejection("vcs", "Unauthorized")).toBe(false);
    expect(isSafeVcsDomainRejection("vcs", "IntegrityFailure")).toBe(false);
    expect(isSafeVcsDomainRejection("eval", "WorkingChangesPresent")).toBe(false);
    expect(isSafeVcsDomainRejection("vcs", undefined)).toBe(false);
  });

  it("keeps typed pre-execution eval module rejection diagnostic-only", () => {
    expect(isSafeEvalDomainRejection("eval", "module_not_available")).toBe(true);
    expect(isSafeEvalDomainRejection("eval", "guest_execution_failed")).toBe(false);
    expect(isSafeEvalDomainRejection("read", "module_not_available")).toBe(false);
  });

  it("separates typed guest program exceptions from eval infrastructure failures", () => {
    expect(isEvalGuestCodeFailure("eval", "guest_execution_failed", "user-code")).toBe(true);
    expect(isEvalGuestCodeFailure("eval", "guest_execution_failed", "infrastructure")).toBe(false);
    expect(isEvalGuestCodeFailure("eval", "module_not_available", "user-code")).toBe(false);
    expect(isEvalGuestCodeFailure("read", "guest_execution_failed", "user-code")).toBe(false);
  });

  it("keeps typed no-effect subagent close guards diagnostic-only", () => {
    expect(isSafeSubagentDomainRejection("close_subagent", "IntegrationIncomplete")).toBe(true);
    expect(isSafeSubagentDomainRejection("close_subagent", "WorkingChangesPresent")).toBe(true);
    expect(isSafeSubagentDomainRejection("close_subagent", "Unauthorized")).toBe(false);
    expect(isSafeSubagentDomainRejection("integrate_subagent", "IntegrationIncomplete")).toBe(
      false
    );
  });

  it("keeps typed ambiguous subagent inspection diagnostic-only", () => {
    expect(isSafeSubagentDomainRejection("inspect_subagent", "InvalidReference")).toBe(true);
    expect(isSafeSubagentDomainRejection("inspect_subagent", "unknown_tool_failure")).toBe(false);
    expect(isSafeSubagentDomainRejection("read", "InvalidReference")).toBe(false);
  });
});
