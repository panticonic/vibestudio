import type { TestCase } from "../types.js";
import {
  findLastAgentMessage,
  getToolCalls,
  noIncompleteInvocations,
  successfulEvalCode,
  successfulEvalReturnValues,
} from "./_helpers.js";

const MISSING_CREDENTIAL_AUDIENCE = "https://system-test-missing.invalid/resource";

function credentialMissChecked(result: Parameters<typeof noIncompleteInvocations>[0]) {
  const final = findLastAgentMessage(result);
  if (
    !/(credential|authorization|oauth)/iu.test(final) ||
    !/(not (?:found|available|configured|bound)|no (?:stored )?(?:credential|binding)|missing|unavailable)/iu.test(
      final
    ) ||
    !/(without|did not|didn't|no)\b[^.\n]*(prompt|window|browser|secret|authoriz)/iu.test(final)
  ) {
    return {
      passed: false,
      reason:
        "Final response did not semantically report the non-interactive credential miss and secret-safe handling",
    };
  }

  const evalCalls = getToolCalls(result).filter((call) => call.name === "eval");
  const code = successfulEvalCode(result);
  if (
    evalCalls.length !== 1 ||
    !code.includes("credentials.resolveCredential") ||
    !code.includes(MISSING_CREDENTIAL_AUDIENCE)
  ) {
    return {
      passed: false,
      reason: "Successful eval did not resolve the reserved missing credential audience",
    };
  }
  if (!/===\s*null/u.test(code)) {
    return {
      passed: false,
      reason: "Successful eval did not structurally observe the credential miss as null",
    };
  }

  const allEvalCode = getToolCalls(result)
    .filter((call) => call.name === "eval")
    .map((call) => (typeof call.arguments?.["code"] === "string" ? call.arguments["code"] : ""))
    .join("\n");
  if (
    /credentials\.(?:connect|configureClient|requestCredentialInput)|openExternal/u.test(
      allEvalCode
    )
  ) {
    return {
      passed: false,
      reason: "Credential miss probe attempted interactive credential or authorization UI",
    };
  }

  const values = successfulEvalReturnValues(result);
  if (
    values.length !== 1 ||
    !values[0] ||
    typeof values[0] !== "object" ||
    Array.isArray(values[0]) ||
    Object.keys(values[0]).join(",") !== "missing" ||
    (values[0] as Record<string, unknown>)["missing"] !== true
  ) {
    return { passed: false, reason: "Credential miss eval must return exactly { missing: true }" };
  }
  return noIncompleteInvocations(result);
}

export const oauthTests: TestCase[] = [
  {
    name: "resolve-credential-miss",
    description: "Resolve an unbound URL audience as a non-interactive null miss",
    category: "oauth",
    prompt: `Check whether this workspace already has a credential for ${MISSING_CREDENTIAL_AUDIENCE}. It should be a quiet lookup only: do not connect an account, open authorization UI, request input, or expose secrets.`,
    validate: credentialMissChecked,
  },
];
