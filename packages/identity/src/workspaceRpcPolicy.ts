import { z } from "zod";

const exactId = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) => value.trim() === value && !/[\u0000-\u001f\u007f*]/u.test(value),
    "Expected an exact identifier, without wildcards or control characters"
  );

/** Each scope opens one operation to one account in one other workspace. */
export const WorkspaceRpcScopeSchema = z
  .object({
    workspaceId: exactId,
    userId: exactId,
    target: exactId,
    operation: exactId,
    purpose: z.enum(["call", "discover"]),
  })
  .strict();

export type WorkspaceRpcScope = z.infer<typeof WorkspaceRpcScopeSchema>;

function compareScopes(left: WorkspaceRpcScope, right: WorkspaceRpcScope): number {
  const leftParts = [left.workspaceId, left.userId, left.target, left.operation, left.purpose];
  const rightParts = [right.workspaceId, right.userId, right.target, right.operation, right.purpose];
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index]! < rightParts[index]!) return -1;
    if (leftParts[index]! > rightParts[index]!) return 1;
  }
  return 0;
}

const WorkspaceRpcPolicyValueSchema = z
  .object({
    incoming: z.array(WorkspaceRpcScopeSchema).max(1000),
    outgoing: z.array(WorkspaceRpcScopeSchema).max(1000),
  })
  .strict()
  .superRefine((policy, ctx) => {
    for (const direction of ["incoming", "outgoing"] as const) {
      const seen = new Set<string>();
      for (const [index, scope] of policy[direction].entries()) {
        const key = JSON.stringify([
          scope.workspaceId,
          scope.userId,
          scope.target,
          scope.operation,
          scope.purpose,
        ]);
        if (seen.has(key))
          ctx.addIssue({
            code: "custom",
            path: [direction, index],
            message: "Duplicate RPC scope",
          });
        seen.add(key);
      }
    }
  });

export const WorkspaceRpcPolicySchema = WorkspaceRpcPolicyValueSchema.transform((policy) => ({
  incoming: [...policy.incoming].sort(compareScopes),
  outgoing: [...policy.outgoing].sort(compareScopes),
}));

export type WorkspaceRpcPolicy = z.infer<typeof WorkspaceRpcPolicySchema>;

export function closedWorkspaceRpcPolicy(): WorkspaceRpcPolicy {
  return { incoming: [], outgoing: [] };
}

export type WorkspaceRpcBoundaryDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: "system-ingress" | "not-exported" | "outgoing-blocked" | "incoming-blocked";
    };

/**
 * Hard ceilings, evaluated before ordinary acquisition. Only host-verified
 * workspace/account facts and the receiver's actual method metadata belong
 * here. This decision never grants method, resource or disclosure authority.
 * A reply is correlated with its admitted call, not evaluated as another call.
 */
export function evaluateWorkspaceRpcBoundary(input: {
  sourceWorkspaceId: string;
  destinationWorkspaceId: string;
  initiatingUserId: string;
  target: string;
  operation: string;
  purpose: WorkspaceRpcScope["purpose"];
  sourcePolicy: WorkspaceRpcPolicy;
  destinationPolicy: WorkspaceRpcPolicy;
  destinationRole?: "personal" | "system";
  exported: boolean;
}): WorkspaceRpcBoundaryDecision {
  if (input.sourceWorkspaceId === input.destinationWorkspaceId) return { allowed: true };
  if (input.destinationRole === "system") return { allowed: false, reason: "system-ingress" };
  if (!input.exported) return { allowed: false, reason: "not-exported" };
  const matches = (scope: WorkspaceRpcScope, peer: string) =>
    scope.workspaceId === peer &&
    scope.userId === input.initiatingUserId &&
    scope.target === input.target &&
    scope.operation === input.operation &&
    scope.purpose === input.purpose;
  if (!input.sourcePolicy.outgoing.some((scope) => matches(scope, input.destinationWorkspaceId))) {
    return { allowed: false, reason: "outgoing-blocked" };
  }
  if (!input.destinationPolicy.incoming.some((scope) => matches(scope, input.sourceWorkspaceId))) {
    return { allowed: false, reason: "incoming-blocked" };
  }
  return { allowed: true };
}
