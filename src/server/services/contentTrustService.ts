import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { contentTrustMethods } from "@vibestudio/service-schemas/contentTrust";
import type { ContextIntegrityStore } from "./contextIntegrityStore.js";

export function createContentTrustService(deps: {
  store: ContextIntegrityStore;
}): ServiceDefinition {
  return {
    name: "contentTrust",
    description: "Human-owned exact content vouches and bounded trust policies",
    authority: { principals: ["user", "host"] },
    methods: contentTrustMethods,
    handler: defineServiceHandler("contentTrust", contentTrustMethods, {
      status: () => ({
        ready: deps.store.isCutoverComplete(),
        grandfatherRoot: deps.store.cutoverRoot(),
      }),
      list: () => deps.store.listTrust(),
      vouch: (ctx, [input]) => ({
        id: deps.store.vouch({ ...input, decidedBy: humanUser(ctx) }),
      }),
      addPolicy: (ctx, [input]) => ({
        id: deps.store.addTrustPolicy({ ...input, decidedBy: humanUser(ctx) }),
      }),
      revoke: (ctx, [id]) => {
        humanUser(ctx);
        return deps.store.revoke(id);
      },
    }),
  };
}

function humanUser(ctx: Parameters<ServiceDefinition["handler"]>[0]): string {
  const userId = ctx.caller.subject?.userId;
  if (!userId || userId === "system") {
    throw Object.assign(new Error("Content trust decisions require a human user"), {
      code: "EACCES",
    });
  }
  return userId;
}
