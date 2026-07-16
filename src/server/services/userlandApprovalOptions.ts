import type { UserlandApprovalOption, UserlandApprovalRequest } from "@vibestudio/shared/approvals";

/** Canonical host-owned choices for a scope-bearing userland approval. */
export function scopedUserlandApprovalOptions(
  policy: Pick<UserlandApprovalRequest, "severity" | "defaultAction">
): UserlandApprovalOption[] {
  const options: UserlandApprovalOption[] = [
    {
      value: "once",
      label: "Allow once",
      description: "Allow this request only.",
      tone: "neutral",
    },
    {
      value: "session",
      label: "Allow this session",
      description: "Remember for this caller until Vibestudio restarts.",
      tone: "neutral",
    },
    {
      value: "version",
      label: "Trust version",
      description: "Remember for this exact code version.",
      tone: "primary",
    },
    {
      value: "deny",
      label: "Deny",
      description: "Do not allow this request.",
      tone: "danger",
    },
  ];

  if (policy.severity !== "dangerous" && policy.defaultAction !== "deny") return options;
  return [...options.filter((option) => option.value === "deny"), ...options.slice(0, -1)];
}
