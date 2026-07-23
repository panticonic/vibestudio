import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import type { ServiceAuthorityPolicy } from "@vibestudio/shared/serviceAuthority";

const TRUSTED_CHROME: ServiceAuthorityPolicy = {
  principals: ["user", "code"],
};

export const systemAgentConversationSchema = z
  .object({
    channelId: z.string().min(1),
    entityId: z.string().min(1),
    contextId: z.string().min(1),
  })
  .strict();

export const systemAgentMethods = defineServiceMethods({
  resolveConversation: {
    description:
      "Resolve the current human's product-owned System Agent conversation. User, device, workspace, code version, context, channel, and agent identity are derived by the host; the caller supplies no identity coordinates.",
    args: z.tuple([]),
    returns: systemAgentConversationSchema,
    authority: TRUSTED_CHROME,
    access: { sensitivity: "write" },
    capability: "system-agent.conversation",
    tier: {
      tier: "open",
      session: "family",
      rationale:
        "Resolving the caller's own product-owned conversation is chrome lifecycle setup; exact user membership and the pinned code roster remain independently enforced.",
    },
  },
});

export type SystemAgentConversation = z.infer<typeof systemAgentConversationSchema>;
