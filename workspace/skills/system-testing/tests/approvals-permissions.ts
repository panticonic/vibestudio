import type { TestCase, TestExecutionResult } from "../types.js";
import {
  completedScenarioEvidence,
  invocationReturnValue,
  walkRecords,
} from "./_scenario-evidence.js";

function successfulEvalCalls(result: TestExecutionResult) {
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  return {
    passed: true as const,
    evidence: base.evidence,
    calls: base.evidence.calls.filter(
      (call) =>
        call.name === "eval" &&
        call.execution?.status === "complete" &&
        call.execution.isError !== true
    ),
  };
}

function validatePermissionList(result: TestExecutionResult) {
  const base = successfulEvalCalls(result);
  if (!base.passed) return base;
  const listed = base.calls.find((call) => {
    const code = String(call.arguments?.["code"] ?? "");
    return (
      /permissions\.list|["']permissions\.list["']/u.test(code) &&
      !/permissions\.revoke/u.test(code)
    );
  });
  const returned = listed ? invocationReturnValue(listed) : { present: false as const };
  return returned.present && Array.isArray(returned.value)
    ? { passed: true, reason: undefined }
    : { passed: false, reason: "The read-only permission listing returned no grant array" };
}

function validateApprovalList(result: TestExecutionResult) {
  const base = successfulEvalCalls(result);
  if (!base.passed) return base;
  const listed = base.calls.find((call) => {
    const code = String(call.arguments?.["code"] ?? "");
    return /approvals\.list/u.test(code) && !/approvals\.(?:request|revoke)/u.test(code);
  });
  const returned = listed ? invocationReturnValue(listed) : { present: false as const };
  return returned.present && Array.isArray(returned.value)
    ? { passed: true, reason: undefined }
    : { passed: false, reason: "The read-only approval listing returned no decision array" };
}

function sameInventory(before: unknown[], after: unknown[]): boolean {
  const identity = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return JSON.stringify(value);
    const record = value as Record<string, unknown>;
    return JSON.stringify({
      id: record["id"] ?? record["subjectId"] ?? record["subject"],
      kind: record["kind"],
      choice: record["choice"],
    });
  };
  const beforeIds = before.map(identity).sort();
  const afterIds = after.map(identity).sort();
  return (
    beforeIds.length === afterIds.length &&
    beforeIds.every((entry, index) => entry === afterIds[index])
  );
}

function subjectIdFromRequest(code: string): string | undefined {
  return /\bsubject\s*:\s*\{[\s\S]*?\bid\s*:\s*["']([^"']+)["']/u.exec(code)?.[1];
}

function subjectIdFromRevoke(code: string): string | undefined {
  return /\bapprovals\.revoke\s*\(\s*["']([^"']+)["']/u.exec(code)?.[1];
}

function validateApprovalRoundTrip(result: TestExecutionResult) {
  const base = successfulEvalCalls(result);
  if (!base.passed) return base;
  const combined = base.calls.find((call) => {
    const code = String(call.arguments?.["code"] ?? "");
    return (
      /approvals\.request/u.test(code) &&
      /approvals\.revoke/u.test(code) &&
      (code.match(/approvals\.list/gu)?.length ?? 0) >= 2
    );
  });
  if (combined) {
    const returned = invocationReturnValue(combined);
    if (returned.present && returned.value && typeof returned.value === "object") {
      const records = walkRecords([returned.value]);
      const root = returned.value as Record<string, unknown>;
      const subjectId = root["subjectId"];
      const before = root["before"];
      const after = root["after"];
      const resolved = records.some(
        (record) =>
          record["kind"] === "choice" &&
          (record["choice"] === "allow" || record["choice"] === "deny")
      );
      if (
        typeof subjectId === "string" &&
        subjectId &&
        Array.isArray(before) &&
        Array.isArray(after) &&
        resolved &&
        sameInventory(before, after) &&
        !JSON.stringify(after).includes(subjectId)
      ) {
        return { passed: true, reason: undefined };
      }
    }
  }

  const calls = base.calls.map((call, index) => ({
    call,
    index,
    code: String(call.arguments?.["code"] ?? ""),
    returned: invocationReturnValue(call),
  }));
  const before = calls.find(
    ({ code, returned }) =>
      /approvals\.list/u.test(code) && returned.present && Array.isArray(returned.value)
  );
  const requested = calls.find(
    ({ index, code, returned }) =>
      index > (before?.index ?? -1) &&
      /approvals\.request/u.test(code) &&
      returned.present &&
      walkRecords([returned.value]).some(
        (record) =>
          record["kind"] === "choice" &&
          (record["choice"] === "allow" || record["choice"] === "deny")
      )
  );
  const requestSubject = requested ? subjectIdFromRequest(requested.code) : undefined;
  const revoked = calls.find(
    ({ index, code, returned }) =>
      index > (requested?.index ?? -1) &&
      subjectIdFromRevoke(code) === requestSubject &&
      returned.present &&
      typeof returned.value === "boolean"
  );
  const after = calls.find(
    ({ index, code, returned }) =>
      index > (revoked?.index ?? -1) &&
      /approvals\.list/u.test(code) &&
      returned.present &&
      Array.isArray(returned.value)
  );
  if (
    before?.returned.present &&
    after?.returned.present &&
    Array.isArray(before.returned.value) &&
    Array.isArray(after.returned.value) &&
    requestSubject &&
    revoked &&
    sameInventory(before.returned.value, after.returned.value) &&
    !JSON.stringify(after.returned.value).includes(requestSubject)
  ) {
    return { passed: true, reason: undefined };
  }
  return {
    passed: false,
    reason:
      "Approval evidence did not join one resolved subject to its revocation and the restored decision inventory",
  };
}

export const approvalPermissionTests: TestCase[] = [
  {
    name: "permissions-list",
    description: "List the currently granted permissions without revoking anything",
    category: "approvals-permissions",
    prompt: "What permission grants are active in this workspace? Do not change them.",
    validate: validatePermissionList,
  },
  {
    name: "approvals-list",
    description: "Inspect stored userland approval decisions",
    category: "approvals-permissions",
    prompt: "What userland approval decisions are currently stored here? Do not change them.",
    validate: validateApprovalList,
  },
  {
    name: "approval-request-then-withdraw",
    description: "Request a harmless approval and withdraw it without leaving a grant",
    category: "approvals-permissions",
    prompt:
      "Verify that a harmless custom-resource approval can be resolved and removed without leaving a saved decision behind.",
    validate: validateApprovalRoundTrip,
  },
];
