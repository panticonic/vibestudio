import { z } from "zod";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import {
  defineServiceMethods,
  fixedPreparedAuthorityRequirement,
} from "@vibestudio/shared/typedServiceClient";
export const workerdInspectorMethods = defineServiceMethods({
  listTargets: {
    website: {
      kind: "closed",
      reason:
        "The workerdInspectorService receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "observability",
      family: "workerdInspector.read",
      rationale: "Read-only discovery of inspectable processes; attaching remains gated",
    },
    args: z.tuple([]),
    returns: z.array(
      z
        .object({ id: z.string(), title: z.string(), type: z.string(), targetPath: z.string() })
        .strict()
    ),
    access: { sensitivity: "read" as const },
  },
  getEndpoint: {
    website: {
      kind: "closed",
      reason:
        "The workerdInspectorService receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    capability: "runtime.inspect",
    tier: {
      tier: "open",
      session: "family",
      residency: "observability",
      family: "workerdInspector.read",
      rationale:
        "The transport is open; non-chrome code receives one prepared gated runtime.inspect leaf",
    },
    presentation: {
      title: "Inspect workspace runtimes",
      action: "inspect workspace runtimes",
      description: "Allows {requesterKind} to inspect workspace runtimes.",
      group: "runtime",
      authorityCategory: {
        domain: "computer",
        verb: "see",
      },
    },
    args: z.tuple([z.string()]),
    returns: z.object({ wsEndpoint: z.string(), token: z.string() }).strict(),
    authority: {
      requirement: requirementForPrincipals(["user", "host", "code"], "runtime.inspect"),
      resource: { kind: "literal" as const, key: "runtime.inspect" },
      prepared: {
        resolver: "workerdInspector.getEndpoint.target",
        leaves: [
          {
            capability: "runtime.inspect",
            requirement: fixedPreparedAuthorityRequirement(
              requirementForPrincipals(["code"], "runtime.inspect")
            ),
            tier: "gated" as const,
          },
        ],
      },
    },
    access: { sensitivity: "admin" as const },
  },
});
