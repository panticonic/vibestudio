/**
 * Shell approval service — thin RPC shim over the in-memory approvalQueue.
 *
 * The renderer's ConsentApprovalBar calls `resolve` with a user decision and
 * `listPending` on mount to rehydrate. Shell callers are permitted directly.
 * Embedded Electron shell calls arrive through the trusted main-process
 * serverClient, so the server sees them as `server` callers. Panels/workers
 * remain blocked.
 */

import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { ApprovalDecision } from "@natstack/shared/approvals";
import { ServiceError } from "@natstack/shared/serviceDispatcher";
import type { ApprovalQueue } from "./approvalQueue.js";

const DECISION_VALUES = ["once", "session", "version", "repo", "deny", "dismiss"] as const;
const USERLAND_RESOLVE_VALUES = ["dismiss"] as const;
const clientConfigValuesSchema = z.record(z.string().min(1).max(128), z.string().max(4096));
const credentialInputValuesSchema = clientConfigValuesSchema;

export function createShellApprovalService(deps: {
  approvalQueue: ApprovalQueue;
}): ServiceDefinition {
  const { approvalQueue } = deps;
  const serviceName = "shellApproval";

  return {
    name: "shellApproval",
    description: "Shell-owned consent approval queue",
    policy: { allowed: ["shell", "server"] },
    methods: {
      resolve: { args: z.tuple([z.string(), z.enum(DECISION_VALUES)]) },
      resolveUserland: { args: z.tuple([z.string(), z.union([z.string().min(1).max(40), z.enum(USERLAND_RESOLVE_VALUES)])]) },
      submitClientConfig: { args: z.tuple([z.string(), clientConfigValuesSchema]) },
      submitCredentialInput: { args: z.tuple([z.string(), credentialInputValuesSchema]) },
      listPending: { args: z.tuple([]) },
    },
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "resolve": {
          const [approvalId, decision] = args as [string, ApprovalDecision];
          approvalQueue.resolve(approvalId, decision);
          return;
        }
        case "resolveUserland": {
          const [approvalId, choice] = args as [string, string | "dismiss"];
          const pending = approvalQueue.listPending().find((approval) => approval.approvalId === approvalId);
          if (!pending || pending.kind !== "userland") {
            throw new ServiceError(serviceName, method, "No pending userland approval found", "ENOENT");
          }
          if (choice === "dismiss") {
            approvalQueue.resolve(approvalId, "dismiss");
            return;
          }
          if (!pending.options.some((option) => option.value === choice)) {
            throw new ServiceError(
              serviceName,
              method,
              "Userland approval choice was not presented to the user",
              "EINVAL",
            );
          }
          approvalQueue.resolveUserland(approvalId, choice);
          return;
        }
        case "submitClientConfig": {
          const [approvalId, values] = args as [string, Record<string, string>];
          approvalQueue.submitClientConfig(approvalId, values);
          return;
        }
        case "submitCredentialInput": {
          const [approvalId, values] = args as [string, Record<string, string>];
          approvalQueue.submitCredentialInput(approvalId, values);
          return;
        }
        case "listPending": {
          return approvalQueue.listPending();
        }
        default:
          throw new ServiceError(serviceName, method, `Unknown shellApproval method: ${method}`, "ENOSYS");
      }
    },
  };
}
