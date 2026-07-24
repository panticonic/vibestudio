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

function hasApprovalCall(code: string, method: "list" | "request" | "revoke"): boolean {
  return new RegExp(`\\b(?:approvals|userlandApproval)\\.${method}\\b`, "u").test(code);
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
  const grants =
    returned.present && returned.value && typeof returned.value === "object"
      ? (returned.value as Record<string, unknown>)["grants"]
      : undefined;
  return returned.present && (Array.isArray(returned.value) || Array.isArray(grants))
    ? { passed: true, reason: undefined }
    : { passed: false, reason: "The read-only permission listing returned no grant array" };
}

function validateApprovalList(result: TestExecutionResult) {
  const base = successfulEvalCalls(result);
  if (!base.passed) return base;
  const listed = base.calls.find((call) => {
    const code = String(call.arguments?.["code"] ?? "");
    return (
      hasApprovalCall(code, "list") &&
      !hasApprovalCall(code, "request") &&
      !hasApprovalCall(code, "revoke")
    );
  });
  const returned = listed ? invocationReturnValue(listed) : { present: false as const };
  const wrappedInventory =
    returned.present &&
    returned.value &&
    typeof returned.value === "object" &&
    !Array.isArray(returned.value)
      ? Object.values(returned.value).some(Array.isArray)
      : false;
  return returned.present && (Array.isArray(returned.value) || wrappedInventory)
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
  const literal =
    /\bsubject\s*:\s*\{[\s\S]*?\bid\s*:\s*["']([^"']+)["']/u.exec(code)?.[1];
  if (literal) return literal;
  const declaredSubject =
    /\b(?:const|let)\s+subject\s*=\s*\{[\s\S]*?\bid\s*:\s*["']([^"']+)["']/u.exec(code)?.[1];
  if (declaredSubject) return declaredSubject;

  const identifier =
    /\bsubject\s*:\s*\{[\s\S]*?\bid\s*:\s*([A-Za-z_$][\w$]*)/u.exec(code)?.[1];
  if (!identifier) return undefined;
  const constants = new Map(
    [...code.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*["']([^"']+)["']/gu)].map(
      (match) => [match[1], match[2]]
    )
  );
  return constants.get(identifier);
}

function subjectIdFromRevoke(code: string): string | undefined {
  const literal =
    /\bapprovals\.revoke\s*\(\s*["']([^"']+)["']/u.exec(code)?.[1] ??
    /["']userlandApproval\.revoke["']\s*,\s*\[\s*["']([^"']+)["']/u.exec(code)?.[1];
  if (literal) return literal;
  const objectName =
    /\bapprovals\.revoke\s*\(\s*([A-Za-z_$][\w$]*)\.id\s*\)/u.exec(code)?.[1] ??
    /["']userlandApproval\.revoke["']\s*,\s*\[\s*([A-Za-z_$][\w$]*)\.id\s*\]/u.exec(
      code
    )?.[1];
  const objectLiteral = objectName
    ? new RegExp(
        `\\b(?:const|let)\\s+${objectName}\\s*=\\s*\\{[\\s\\S]*?\\bid\\s*:\\s*["']([^"']+)["']`,
        "u"
      ).exec(code)?.[1]
    : undefined;
  if (objectLiteral) return objectLiteral;
  const identifier =
    /\bapprovals\.revoke\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/u.exec(code)?.[1] ??
    /["']userlandApproval\.revoke["']\s*,\s*\[\s*([A-Za-z_$][\w$]*)\s*\]/u.exec(
      code
    )?.[1];
  if (!identifier) return undefined;
  return new RegExp(
    `\\b(?:const|let)\\s+${identifier}\\s*=\\s*["']([^"']+)["']`,
    "u"
  ).exec(code)?.[1];
}

function subjectIdFromDecision(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record["subjectId"] === "string") return record["subjectId"];
  const subject = record["subject"];
  if (typeof subject === "string") return subject;
  if (!subject || typeof subject !== "object" || Array.isArray(subject)) return undefined;
  const id = (subject as Record<string, unknown>)["id"];
  return typeof id === "string" ? id : undefined;
}

function arraysInReturnedValue(value: unknown): unknown[][] {
  if (Array.isArray(value)) return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).filter(Array.isArray);
}

function inventoryCount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  return Array.isArray(value) ? value.length : undefined;
}

function inventoryContains(value: unknown, subjectId: string): boolean | undefined {
  return Array.isArray(value) ? JSON.stringify(value).includes(subjectId) : undefined;
}

function validateApprovalRoundTrip(result: TestExecutionResult) {
  const base = successfulEvalCalls(result);
  if (!base.passed) return base;
  const combined = base.calls.find((call) => {
    const code = String(call.arguments?.["code"] ?? "");
    return (
      hasApprovalCall(code, "request") &&
      hasApprovalCall(code, "revoke") &&
      (code.match(/\b(?:approvals|userlandApproval)\.list\b/gu)?.length ?? 0) >= 2
    );
  });
  if (combined) {
    const returned = invocationReturnValue(combined);
    if (returned.present && returned.value && typeof returned.value === "object") {
      const records = walkRecords([returned.value]);
      const root = returned.value as Record<string, unknown>;
      const inventories = arraysInReturnedValue(returned.value);
      const subjectId =
        (typeof root["subjectId"] === "string" ? root["subjectId"] : undefined) ??
        subjectIdFromRequest(String(combined.arguments?.["code"] ?? "")) ??
        records.map(subjectIdFromDecision).find((id): id is string => Boolean(id));
      const before = inventories[0];
      const after = inventories.at(-1);
      const resolved = records.some(
        (record) =>
          record["kind"] === "choice" &&
          (record["choice"] === "allow" || record["choice"] === "deny")
      );
      const revoked = records.some((record) =>
        Object.values(record).some((value) => value === true)
      );
      const namedBefore = Array.isArray(root["before"]) ? root["before"] : undefined;
      const namedAfterRequest = Array.isArray(root["afterRequest"])
        ? root["afterRequest"]
        : undefined;
      const namedAfterRevoke = Array.isArray(root["afterRevoke"])
        ? root["afterRevoke"]
        : Array.isArray(root["finalList"])
          ? root["finalList"]
          : undefined;
      const namedInventoryProof =
        subjectId !== undefined &&
        resolved &&
        namedBefore !== undefined &&
        namedAfterRequest !== undefined &&
        namedAfterRevoke !== undefined &&
        !JSON.stringify(namedBefore).includes(subjectId) &&
        JSON.stringify(namedAfterRequest).includes(subjectId) &&
        sameInventory(namedBefore, namedAfterRevoke) &&
        !JSON.stringify(namedAfterRevoke).includes(subjectId);
      const inventoryProof =
        subjectId &&
        Array.isArray(before) &&
        Array.isArray(after) &&
        resolved &&
        revoked &&
        sameInventory(before, after) &&
        !JSON.stringify(after).includes(subjectId);
      const beforeState = root["beforeCount"] ?? root["before"];
      const afterRequestState =
        root["afterRequestCount"] ??
        root["afterApproveCount"] ??
        root["afterRequest"] ??
        root["afterApprove"] ??
        root["afterRequestMatch"] ??
        root["mid"];
      const afterRevokeState =
        root["afterRevokeCount"] ??
        root["afterRevoke"] ??
        root["afterRevokeMatch"] ??
        root["finalList"] ??
        root["after"];
      const beforeCount = inventoryCount(beforeState);
      const afterRequestCount = inventoryCount(afterRequestState);
      const afterRevokeCount = inventoryCount(afterRevokeState);
      const beforeHas =
        typeof root["beforeHas"] === "boolean"
          ? root["beforeHas"]
          : inventoryContains(beforeState, subjectId ?? "");
      const afterRequestHas =
        typeof root["afterRequestHas"] === "boolean"
          ? root["afterRequestHas"]
          : inventoryContains(afterRequestState, subjectId ?? "");
      const afterRevokeHas =
        typeof root["afterRevokeHas"] === "boolean"
          ? root["afterRevokeHas"]
          : inventoryContains(afterRevokeState, subjectId ?? "");
      const revokeSubjectId = subjectIdFromRevoke(
        String(combined.arguments?.["code"] ?? "")
      );
      const subjectLifecycleProof =
        subjectId !== undefined &&
        resolved &&
        hasApprovalCall(String(combined.arguments?.["code"] ?? ""), "revoke") &&
        afterRequestHas === true &&
        afterRevokeHas === false;
      const stateTransitionProof =
        subjectId !== undefined &&
        revokeSubjectId === subjectId &&
        resolved &&
        revoked &&
        beforeCount !== undefined &&
        afterRequestCount !== undefined &&
        afterRevokeCount !== undefined &&
        afterRequestCount === beforeCount + 1 &&
        afterRevokeCount === beforeCount &&
        ((beforeHas !== true && afterRequestHas === true && afterRevokeHas !== true) ||
          root["removed"] === true ||
          root["leakedDecision"] === false ||
          (Array.isArray(root["matchingAfterRevoke"]) &&
            root["matchingAfterRevoke"].length === 0));
      if (
        namedInventoryProof ||
        inventoryProof ||
        subjectLifecycleProof ||
        stateTransitionProof
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
  const before = calls
    .flatMap(({ index, code, returned }) =>
      returned.present &&
        hasApprovalCall(code, "list") &&
        !hasApprovalCall(code, "request") &&
        !hasApprovalCall(code, "revoke")
        ? arraysInReturnedValue(returned.value).map((inventory) => ({ index, inventory }))
        : []
    )[0];
  const requested = calls.find(
    ({ index, code, returned }) =>
      index > (before?.index ?? -1) &&
      hasApprovalCall(code, "request") &&
      returned.present &&
      walkRecords([returned.value]).some(
        (record) =>
          record["kind"] === "choice" &&
          (record["choice"] === "allow" || record["choice"] === "deny")
      )
  );
  const requestedRecords =
    requested?.returned.present === true ? walkRecords([requested.returned.value]) : [];
  const requestSubject = requested
    ? (subjectIdFromRequest(requested.code) ??
      requestedRecords.map(subjectIdFromDecision).find((id): id is string => Boolean(id)))
    : undefined;
  const requestedValue =
    requested?.returned.present === true &&
    requested.returned.value &&
    typeof requested.returned.value === "object" &&
    !Array.isArray(requested.returned.value)
      ? (requested.returned.value as Record<string, unknown>)
      : undefined;
  const baselineInventory =
    before?.inventory ??
    (Array.isArray(requestedValue?.["before"]) ? requestedValue["before"] : undefined);
  const baselineCount =
    baselineInventory?.length ??
    (typeof requestedValue?.["beforeCount"] === "number"
      ? requestedValue["beforeCount"]
      : undefined);
  const revoked = calls.find(({ index, code, returned }) => {
    if (
      index <= (requested?.index ?? -1) ||
      !hasApprovalCall(code, "revoke") ||
      !returned.present
    ) {
      return false;
    }
    const literalSubject = subjectIdFromRevoke(code);
    if (literalSubject !== undefined && literalSubject !== requestSubject) return false;
    const records = walkRecords([returned.value]);
    const observedSubject = records.some(
      (record) =>
        subjectIdFromDecision(record) === requestSubject &&
        record["choice"] === "allow"
    );
    const successfulRevocation =
      returned.value === true ||
      records.some((record) => Object.values(record).some((value) => value === true)) ||
      (literalSubject === requestSubject &&
        hasApprovalCall(code, "list") &&
        arraysInReturnedValue(returned.value).length > 0);
    return successfulRevocation && (literalSubject === requestSubject || observedSubject);
  });
  const after = calls
    .flatMap(({ index, code, returned }) =>
      returned.present &&
        index >= (revoked?.index ?? Number.POSITIVE_INFINITY) &&
        hasApprovalCall(code, "list")
        ? arraysInReturnedValue(returned.value).map((inventory) => ({ index, inventory }))
        : []
    )
    .at(-1);
  if (
    after &&
    requestSubject &&
    revoked &&
    ((baselineInventory !== undefined && sameInventory(baselineInventory, after.inventory)) ||
      (baselineCount !== undefined && baselineCount === after.inventory.length)) &&
    !JSON.stringify(after.inventory).includes(requestSubject)
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
    authorityPolicy: {
      authority: [
        {
          ruleId: "list-permissions",
          capability: "permissions.read",
          resource: { kind: "exact", key: "permissions.read" },
          tier: "gated",
          decision: "once",
        },
      ],
      userland: [],
    },
    validate: validatePermissionList,
  },
  {
    name: "approvals-list",
    description: "Inspect stored userland approval decisions",
    category: "approvals-permissions",
    prompt: "What userland approval decisions are currently stored here? Do not change them.",
    authorityPolicy: {
      authority: [
        {
          ruleId: "list-userland-decisions",
          capability: "approvals.read",
          resource: { kind: "exact", key: "approvals.read" },
          tier: "gated",
          decision: "once",
        },
      ],
      userland: [],
    },
    validate: validateApprovalList,
  },
  {
    name: "approval-request-then-withdraw",
    description: "Request a harmless approval and withdraw it without leaving a grant",
    category: "approvals-permissions",
    prompt:
      'Verify that the harmless custom resource "system-test:harmless-resource" can be approved and then removed without leaving a saved decision behind.',
    authorityPolicy: {
      authority: [
        {
          ruleId: "list-userland-decisions",
          capability: "approvals.read",
          resource: { kind: "exact", key: "approvals.read" },
          tier: "gated",
          decision: "once",
        },
        {
          ruleId: "request-harmless-userland-decision",
          capability: "user-approval.request",
          resource: { kind: "exact", key: "user-approval.request" },
          tier: "gated",
          decision: "once",
        },
        {
          ruleId: "revoke-harmless-userland-decision",
          capability: "user-approval.revoke",
          resource: { kind: "exact", key: "user-approval.revoke" },
          tier: "critical",
          decision: "once",
        },
      ],
      userland: [
        {
          ruleId: "approve-harmless-resource",
          subjectId: "system-test:harmless-resource",
          decision: "allow",
          remember: true,
        },
      ],
    },
    validate: validateApprovalRoundTrip,
  },
];
