export const APPROVAL_DECISIONS = [
  "once",
  "task",
  "agent",
  "lock",
  "session",
  "version",
  "always",
  "block",
  "deny",
  "dismiss",
] as const;
export type ApprovalDecisionId = (typeof APPROVAL_DECISIONS)[number];

// Notification action ids (subset of decisions + "open"). Order matters for iOS:
// the system prioritizes earlier actions in constrained notification layouts.
export const NOTIFICATION_ACTION_IDS_STANDARD = [
  "once",
  "deny",
  "open",
  "version",
] as const;
export const NOTIFICATION_ACTION_IDS_INPUT_REQUIRED = ["open"] as const;
export const NOTIFICATION_ACTION_IDS_BROWSER_PERMISSION = [
  "once",
  "session",
  "always",
  "block",
  "open",
] as const;

export const APPROVAL_CATEGORY_DECIDE = "vibestudio-approval-decide";
export const APPROVAL_CATEGORY_INPUT_REQUIRED = "vibestudio-approval-input-required";
export const APPROVAL_CATEGORY_BROWSER_PERMISSION = "vibestudio-browser-permission-decide";

export type PushApprovalDataPayload = {
  kind: "approval-prompt" | "approval-cancel";
  approvalId: string;
  approvalKind?:
    | "credential"
    | "capability"
    | "unit-batch"
    | "mission-review"
    | "client-config"
    | "credential-input"
    | "secret-input"
    | "userland"
    | "external-agent"
    | "device-code"
    | "browser-permission";
  title?: string;
  body?: string;
  category?: string;
  cancelKey?: string;
  // FCM data values must be strings; JSON-encode complex values.
  actionsJson?: string;
};

export const RPC_METHODS = {
  shellApproval: {
    resolve: "shellApproval.resolve",
    resolveBootstrap: "shellApproval.resolveBootstrap",
    submitClientConfig: "shellApproval.submitClientConfig",
    submitCredentialInput: "shellApproval.submitCredentialInput",
    submitSecretInput: "shellApproval.submitSecretInput",
    resolveUserland: "shellApproval.resolveUserland",
    listPending: "shellApproval.listPending",
  },
  push: {
    register: "push.register",
    unregister: "push.unregister",
  },
} as const;
