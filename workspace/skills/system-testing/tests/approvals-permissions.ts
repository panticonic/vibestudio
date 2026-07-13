import type { TestCase } from "../types.js";
import {
  finalMessageHasAll,
  finalMessageHasNumericField,
  noIncompleteInvocations,
} from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

export const approvalPermissionTests: TestCase[] = [
  {
    name: "permissions-list",
    description: "List the currently granted permissions without revoking anything",
    category: "approvals-permissions",
    prompt:
      "Report what permissions are currently granted in this workspace, without revoking or changing any of them. Finish with PERMISSIONS_LIST_OK and count:<number>.",
    validate: (result) => {
      const base = checked(result, ["PERMISSIONS_LIST_OK"]);
      if (!base.passed) return base;
      return finalMessageHasNumericField(result, "count");
    },
  },
  {
    name: "approvals-list",
    description: "Inspect the approval queue state",
    category: "approvals-permissions",
    prompt:
      "Check the workspace approval queue and report how many approvals are currently pending (zero is a valid answer). Finish with APPROVALS_LIST_OK and pending:<count>.",
    validate: (result) => checked(result, ["APPROVALS_LIST_OK", "pending:"]),
  },
  {
    name: "approval-request-then-withdraw",
    description: "Request a harmless approval and withdraw it without waiting for a human",
    category: "approvals-permissions",
    prompt:
      "Exercise the approval request lifecycle end to end with something harmless: file a low-risk approval request, observe its state (it may resolve immediately in a development environment), and then withdraw or revoke it so nothing lingers in the queue. Do not block waiting for a human decision. Finish with APPROVAL_ROUNDTRIP_OK, state:<observed-state>, and cleaned-up, or APPROVAL_ROUNDTRIP_UNAVAILABLE with the concrete blocking reason.",
    validate: (result) => {
      const ok = finalMessageHasAll(result, ["APPROVAL_ROUNDTRIP_OK", "state:", "cleaned-up"]);
      if (ok.passed) return noIncompleteInvocations(result);
      return checked(result, ["APPROVAL_ROUNDTRIP_UNAVAILABLE"]);
    },
  },
];
