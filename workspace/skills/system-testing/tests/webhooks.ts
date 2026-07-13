import type { TestCase } from "../types.js";
import {
  finalMessageHasAll,
  finalMessageHasNumericField,
  noIncompleteInvocations,
  requireEvalEvidence,
} from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

export const webhookTests: TestCase[] = [
  {
    name: "webhook-subscription-lifecycle",
    description: "Create, list, rotate, and revoke a webhook subscription",
    category: "webhooks",
    prompt:
      "Exercise the full webhook subscription lifecycle with a harmless test subscription: create it, confirm it shows up in the subscription list, rotate its secret, then revoke it and confirm it is gone. Finish with WEBHOOK_LIFECYCLE_OK and revoked:yes, or WEBHOOK_UNAVAILABLE with the concrete blocking reason.",
    validate: (result) => {
      const ok = finalMessageHasAll(result, ["WEBHOOK_LIFECYCLE_OK", "revoked:yes"]);
      if (ok.passed) {
        const pending = noIncompleteInvocations(result);
        if (!pending.passed) return pending;
        return requireEvalEvidence(result, ["webhooks"]);
      }
      return checked(result, ["WEBHOOK_UNAVAILABLE"]);
    },
  },
  {
    name: "webhook-list-bounded",
    description: "List current webhook subscriptions",
    category: "webhooks",
    prompt:
      "Report the webhook subscriptions currently registered in this workspace (zero is a valid answer). Finish with WEBHOOK_LIST_OK and count:<number>.",
    validate: (result) => {
      const base = checked(result, ["WEBHOOK_LIST_OK"]);
      if (!base.passed) return base;
      return finalMessageHasNumericField(result, "count");
    },
  },
];
