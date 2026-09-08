import { websiteHostingMethods } from "@vibestudio/service-schemas/websiteHosting";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { WebsiteDocuments } from "./websiteDocuments.js";

export function createWebsiteHostingService(
  documents: WebsiteDocuments,
  slotOfRuntime: (runtimeId: string) => string | null
): ServiceDefinition {
  const host = (ctx: ServiceContext) => {
    // The presentation transport itself must attest the document. A delegated
    // user's identity or an operation's authorizing caller cannot attest a host.
    if (!ctx.caller.subject || ctx.caller.website || ctx.caller.code || ctx.caller.agentBinding)
      throw new Error("Browser document attestation requires an authenticated presentation host");
    return { hostId: ctx.caller.runtime.id, user: ctx.caller.subject };
  };
  return {
    name: "websiteHosting",
    description: "Native browser document admission and lifetime",
    methods: websiteHostingMethods,
    authority: { principals: ["user"] },
    handler: defineServiceHandler("websiteHosting", websiteHostingMethods, {
      list: async () =>
        documents.list().map((doc) => ({ ...doc, slotId: slotOfRuntime(doc.runtimeId) })),
      begin: async (ctx, [input]) => documents.begin({ ...input, ...host(ctx) }),
      connect: async (ctx, [input]) =>
        documents.connect(input.runtimeId, input.documentId, host(ctx).hostId),
      end: async (ctx, [input]) =>
        documents.end(input.runtimeId, input.documentId, host(ctx).hostId),
    }),
  };
}
