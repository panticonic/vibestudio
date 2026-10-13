import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { requirementForPrincipals } from "@vibestudio/shared/authorityRequirements";
import { selectedPreparedAuthorityRequirement } from "@vibestudio/shared/typedServiceClient";

export const PrepareNativeLocalModelParamsSchema = z
  .object({
    providerId: z.literal("local"),
    modelId: z.string().min(1).max(512),
    endpoint: z.string().min(1).max(2048).nullable(),
  })
  .strict();
export type PrepareNativeLocalModelParams = z.infer<typeof PrepareNativeLocalModelParamsSchema>;

export const PREPARE_NATIVE_LOCAL_MODEL_AUTHORITY_RESOLVER =
  "localModelRuntime.prepareNativeModel.model" as const;

export const localModelRuntimeMethods = defineServiceMethods({
  prepareNativeModel: {
    website: {
      kind: "eligible",
      rationale:
        "Prepares only the exact active authenticated native local-model invocation; runtime secrets remain in the host egress boundary.",
    } as const,
    capability: "localModelRuntime.prepareNativeModel",
    tier: {
      tier: "open",
      session: "family",
      residency: "secret",
      family: "credentials.read",
      rationale:
        "The host validates the retained native invocation and returns only its current secret-free endpoint.",
    },
    description:
      "Prepare the exact local model selected by an active native model invocation and return its current endpoint. The host injects loopback authorization at egress time.",
    args: z.tuple([PrepareNativeLocalModelParamsSchema]),
    returns: z.object({ baseUrl: z.string().url() }).strict(),
    access: { sensitivity: "write" as const },
    authority: {
      requirement: requirementForPrincipals(
        ["website", "user", "host", "code"],
        "service:localModelRuntime.prepareNativeModel"
      ),
      resource: {
        kind: "literal" as const,
        key: "service:localModelRuntime.prepareNativeModel",
      },
      prepared: {
        resolver: PREPARE_NATIVE_LOCAL_MODEL_AUTHORITY_RESOLVER,
        leaves: [
          {
            capability: "model.use",
            requirement: selectedPreparedAuthorityRequirement(["website", "user", "host", "code"]),
            tier: { selectedFrom: ["gated"] as const },
          },
        ],
      },
    },
    examples: [
      {
        args: [{ providerId: "local", modelId: "lfm2.5-1.2b", endpoint: null }],
      },
    ],
  },
});
