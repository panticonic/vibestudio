import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { GovernanceRecordSchema } from "@vibestudio/shared/governance/schemas";
import { governanceListQuerySchema } from "./governanceQuery.js";

export const governanceMethods = defineServiceMethods({
  list: {
    website: {
      kind: "closed",
      reason:
        "The governanceService receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    capability: "governance.read",
    tier: {
      tier: "gated",
      session: "family",
      residency: "grant-authority",
      family: "governance.read",
      rationale: "G4: privacy or authority-map read; §2 default {code, session} family",
    },
    presentation: {
      title: "View workspace governance settings",
      action: "view workspace governance settings",
      description: "Allows {requesterKind} to view workspace governance settings.",
      group: "approvals",
      authorityCategory: {
        domain: "safety",
        verb: "see",
      },
    },
    description:
      "List host governance records (approval resolutions + membership events) newest-first, optionally filtered by record kind, acting user, approval kind, membership op, workspace, or grant outcome.",
    args: z.tuple([governanceListQuerySchema.optional()]),
    returns: z.array(GovernanceRecordSchema),
    access: { sensitivity: "read" as const },
    examples: [{ args: [{ filter: { recordKind: "approval" }, limit: 50 }] }],
  },
});
