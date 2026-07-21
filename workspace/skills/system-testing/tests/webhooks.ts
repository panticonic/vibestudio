import type { TestCase } from "../types.js";
import {
  findLastAgentMessage,
  getToolCalls,
  noIncompleteInvocations,
  successfulEvalCode,
  successfulEvalReturnValues,
} from "./_helpers.js";

function records(value: unknown, found: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) records(item, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  const item = value as Record<string, unknown>;
  found.push(item);
  for (const child of Object.values(item)) records(child, found);
  return found;
}

function hasSecretField(value: unknown): boolean {
  return records(value).some((item) => Object.hasOwn(item, "secret"));
}

function unavailableWithEvidence(result: Parameters<typeof noIncompleteInvocations>[0]) {
  const failed = getToolCalls(result).some(
    (call) =>
      call.name === "eval" &&
      call.execution?.isError === true &&
      /webhooks/iu.test(String(call.arguments?.["code"] ?? ""))
  );
  const final = findLastAgentMessage(result);
  return failed &&
    /(unavailable|unsupported|blocked|cannot|could not|failed)/iu.test(final) &&
    final.trim().length > 20
    ? noIncompleteInvocations(result)
    : {
        passed: false,
        reason:
          "Webhook unavailability was not backed by a failed canonical invocation and concrete explanation",
      };
}

function lifecycleChecked(result: Parameters<typeof noIncompleteInvocations>[0]) {
  const code = successfulEvalCode(result);
  const methods = ["createSubscription", "listSubscriptions", "rotateSecret", "revokeSubscription"];
  if (!methods.every((method) => code.includes(`webhooks.${method}`))) {
    return unavailableWithEvidence(result);
  }
  const create = code.indexOf("webhooks.createSubscription");
  const list = code.indexOf("webhooks.listSubscriptions", create + 1);
  const rotate = code.indexOf("webhooks.rotateSecret", list + 1);
  const revoke = code.indexOf("webhooks.revokeSubscription", rotate + 1);
  const finalList = code.indexOf("webhooks.listSubscriptions", revoke + 1);
  if (!(create >= 0 && list > create && rotate > list && revoke > rotate && finalList > revoke)) {
    return {
      passed: false,
      reason:
        "Webhook lifecycle calls were not observed in create/list/rotate/revoke/cleanup order",
    };
  }
  if (
    !/rotateSecret\(\s*\w+\.subscriptionId/u.test(code) ||
    !/revokeSubscription\(\s*\w+\.subscriptionId/u.test(code)
  ) {
    return {
      passed: false,
      reason:
        "Webhook rotation and revocation were not identity-joined to the created subscription",
    };
  }
  const values = successfulEvalReturnValues(result);
  const proof = records(values).find(
    (item) =>
      item["created"] === true &&
      item["listed"] === true &&
      item["rotated"] === true &&
      (item["removed"] === true || item["revoked"] === true)
  );
  if (!proof) return { passed: false, reason: "Webhook lifecycle result did not prove every step" };
  if (values.some(hasSecretField)) {
    return {
      passed: false,
      reason: "Webhook lifecycle returned secret material instead of a redacted verification proof",
    };
  }
  const final = findLastAgentMessage(result);
  if (
    !/webhook|subscription/iu.test(final) ||
    !/rotat/iu.test(final) ||
    !/revok|removed|clean/iu.test(final)
  ) {
    return { passed: false, reason: "Final response did not report webhook rotation and cleanup" };
  }
  return noIncompleteInvocations(result);
}

function listChecked(result: Parameters<typeof noIncompleteInvocations>[0]) {
  const values = successfulEvalReturnValues(result);
  if (!/webhooks\.listSubscriptions/iu.test(successfulEvalCode(result)) || values.length === 0) {
    return { passed: false, reason: "No successful canonical webhook-list observation was found" };
  }
  const subscriptions = values
    .flatMap((value) => {
      if (Array.isArray(value)) return [value];
      return records(value)
        .map((item) => item["subscriptions"])
        .filter((item): item is unknown[] => Array.isArray(item));
    })
    .find((items) =>
      items.every(
        (item) =>
          item &&
          typeof item === "object" &&
          typeof (item as Record<string, unknown>)["subscriptionId"] === "string"
      )
    );
  if (!subscriptions) {
    return { passed: false, reason: "Webhook list result did not contain canonical subscriptions" };
  }
  const final = findLastAgentMessage(result);
  const exactCount = new RegExp(`(?:^|\\D)${subscriptions.length}(?:\\D|$)`, "u");
  if (!/webhook|subscription/iu.test(final) || !exactCount.test(final)) {
    return {
      passed: false,
      reason: "Final response did not report the observed subscription count",
    };
  }
  return noIncompleteInvocations(result);
}

export const webhookTests: TestCase[] = [
  {
    name: "webhook-subscription-lifecycle",
    description: "Create, list, rotate, and revoke a webhook subscription",
    category: "webhooks",
    prompt:
      "Exercise a harmless temporary webhook subscription end to end: create it, confirm it is listed, rotate its secret, revoke it, and verify cleanup. If this deployment cannot support the test, explain the concrete blocker instead of pretending it succeeded.",
    validate: lifecycleChecked,
  },
  {
    name: "webhook-list-bounded",
    description: "List current webhook subscriptions",
    category: "webhooks",
    prompt:
      "How many webhook subscriptions are currently registered in this workspace? Zero is a valid answer; keep the report bounded.",
    validate: listChecked,
  },
];
