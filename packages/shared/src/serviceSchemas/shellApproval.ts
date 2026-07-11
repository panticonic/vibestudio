/**
 * shellApproval service schema — trusted shell/mobile approval resolution and
 * approval queue rehydration.
 */

import { z } from "zod";
import type { PendingApproval } from "../approvals.js";
import { APPROVAL_DECISIONS } from "../approvalContract.js";
import type { MethodAccessDescriptor } from "../servicePolicy.js";
import { defineServiceMethods } from "../typedServiceClient.js";

export const shellApprovalValuesSchema = z
  .record(z.string().min(1).max(128), z.string().max(4096))
  .describe(
    "Submitted field values keyed by field name (each key ≤128 chars, each value ≤4096 chars)."
  );

export const pendingApprovalSchema = z.custom<PendingApproval>(
  (value) => typeof value === "object" && value !== null
);

// Access descriptors shared across the shellApproval methods. Each call records
// a human's decision on a pending approval (resolving the queued request), so
// the resolution paths are writes; `listPending` is a pure read used to
// rehydrate the renderer's approval bar on mount. The service-level `policy`
// (shell/app/server) stays the enforced caller gate; we omit `access.callers`.
const RESOLVE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const LIST_PENDING_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};

export const shellApprovalMethods = defineServiceMethods({
  resolve: {
    description:
      "Record the user's decision (once/session/version/repo/deny/dismiss) on a pending approval, resolving its queued request.",
    args: z.tuple([z.string(), z.enum(APPROVAL_DECISIONS)]),
    returns: z.void(),
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", "once"] }],
  },
  blockCapability: {
    description:
      "Deny a pending capability request and remember that denial for this exact code version until revoked.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: RESOLVE_ACCESS,
  },
  resolveBootstrap: {
    description:
      "Resolve a pending startup-app (bootstrap unit) approval with an allow-once or deny decision; rejects if the id is not a pending bootstrap approval.",
    args: z.tuple([z.string(), z.enum(["once", "deny"])]),
    returns: z.void(),
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", "deny"] }],
  },
  resolveUserland: {
    description:
      "Resolve a pending userland approval by selecting one of the presented option values (or 'dismiss'); rejects if the choice was not offered to the user.",
    args: z.tuple([z.string(), z.union([z.string().min(1).max(40), z.literal("dismiss")])]),
    returns: z.void(),
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", "dismiss"] }],
  },
  resolveExternalAgent: {
    description:
      "Record the user's allow/deny verdict on a pending external-agent tool-use approval, resolving the relayed permission request.",
    args: z.tuple([z.string(), z.enum(["allow", "deny"])]),
    returns: z.void(),
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", "allow"] }],
  },
  resolveExternalAgentByRequest: {
    description:
      "Record the user's allow/deny verdict on a pending external-agent approval matched by (channelId, requestId, resolveToken) rather than approvalId — the inline conversation card knows the requestId and opaque resolve token, not the internal approvalId. Records a real verdict (unlike the quiet settle-elsewhere path). Returns whether a matching pending approval was resolved.",
    args: z.tuple([
      z
        .object({
          channelId: z.string().min(1).max(200),
          requestId: z
            .string()
            .min(1)
            .max(200)
            .regex(/^[A-Za-z0-9._:/-]+$/),
          resolveToken: z
            .string()
            .min(16)
            .max(200)
            .regex(/^[A-Za-z0-9._:/-]+$/),
        })
        .strict(),
      z.enum(["allow", "deny"]),
    ]),
    returns: z.object({ resolved: z.boolean() }),
    // Method-level gate: the inline approve/deny card lives in the chat panel, so
    // `panel` is admitted here (the service-level policy is shell/app/server for
    // the trusted approval bar). Resolution is scoped to
    // (channelId, requestId, resolveToken).
    policy: { allowed: ["panel", "shell", "app", "server"] },
    access: RESOLVE_ACCESS,
    examples: [
      {
        args: [
          { channelId: "channel-1", requestId: "req-1", resolveToken: "token-1234567890" },
          "allow",
        ],
      },
    ],
  },
  submitClientConfig: {
    description:
      "Submit the user-entered client-configuration field values for a pending approval, fulfilling its config request.",
    args: z.tuple([z.string(), shellApprovalValuesSchema]),
    returns: z.void(),
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", { clientId: "abc", clientSecret: "shh" }] }],
  },
  submitCredentialInput: {
    description:
      "Submit the user-entered credential/secret field values for a pending approval, fulfilling its credential-input request.",
    args: z.tuple([z.string(), shellApprovalValuesSchema]),
    returns: z.void(),
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", { token: "secret-value" }] }],
  },
  submitSecretInput: {
    description:
      "Submit the user-entered secret field values for a pending secret-input approval, fulfilling its feedback-form request.",
    args: z.tuple([z.string(), shellApprovalValuesSchema]),
    returns: z.void(),
    access: RESOLVE_ACCESS,
    examples: [{ args: ["approval-123", { value: "secret-value" }] }],
  },
  listPending: {
    description:
      "List the approvals currently awaiting a decision, used to rehydrate the consent approval bar on mount.",
    args: z.tuple([]),
    returns: z.array(pendingApprovalSchema),
    access: LIST_PENDING_ACCESS,
  },
});
