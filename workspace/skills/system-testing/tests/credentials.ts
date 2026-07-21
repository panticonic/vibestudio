import type { TestCase } from "../types.js";
import {
  findLastAgentMessage,
  getToolCalls,
  noIncompleteInvocations,
  successfulEvalCode,
  successfulEvalReturnValues,
} from "./_helpers.js";

function storeInspectionChecked(result: Parameters<typeof noIncompleteInvocations>[0]) {
  const final = findLastAgentMessage(result);
  if (
    !/credential/iu.test(final) ||
    !/(lifecycle|active|expired|revoked|state)/iu.test(final) ||
    !/(without|did not|didn't|no)\b[^.\n]*(secret|material|mutat|change|revoke|delete)/iu.test(
      final
    )
  ) {
    return {
      passed: false,
      reason:
        "Final response did not report the bounded credential lifecycle summary and read-only secret-safe handling",
    };
  }

  const evalCalls = getToolCalls(result).filter((call) => call.name === "eval");
  if (
    evalCalls.length !== 1 ||
    !successfulEvalCode(result).includes("credentials.inspectStoredCredentials")
  ) {
    return {
      passed: false,
      reason: "Expected exactly one successful eval inspecting the managed credential store",
    };
  }
  const allEvalCode = getToolCalls(result)
    .filter((call) => call.name === "eval")
    .map((call) => (typeof call.arguments?.["code"] === "string" ? call.arguments["code"] : ""))
    .join("\n");
  if (
    /credentials\.(?:store|connect|configureClient|requestCredentialInput|revokeCredential|deleteClientConfig)/u.test(
      allEvalCode
    )
  ) {
    return {
      passed: false,
      reason: "Credential inspection probe attempted to mutate credential state",
    };
  }

  const values = successfulEvalReturnValues(result);
  if (values.length !== 1 || !isExactCredentialStoreSummary(values[0])) {
    return {
      passed: false,
      reason:
        "Credential inspection eval must return exactly { count: nonnegative integer, states: distinct lifecycle state names[] }",
    };
  }
  return noIncompleteInvocations(result);
}

function isExactCredentialStoreSummary(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "count,states") return false;
  if (!Number.isSafeInteger(record["count"]) || (record["count"] as number) < 0) return false;
  const states = record["states"];
  if (!Array.isArray(states) || states.length > 3) return false;
  if (
    !states.every(
      (state) => typeof state === "string" && ["active", "expired", "revoked"].includes(state)
    )
  ) {
    return false;
  }
  return new Set(states).size === states.length;
}

export const credentialTests: TestCase[] = [
  {
    name: "credential-store-inspect",
    description: "Inspect managed credential lifecycle summaries without mutation or secret access",
    category: "credentials",
    prompt:
      "How many managed credentials are stored here, and which lifecycle states are represented? Give me only a bounded summary—do not expose credential details or secrets, and do not change anything.",
    validate: storeInspectionChecked,
  },
];
