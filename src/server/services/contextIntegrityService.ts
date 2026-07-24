import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { contextIntegrityMethods } from "@vibestudio/service-schemas/contextIntegrity";
import type { ContextIntegrityStore } from "./contextIntegrityStore.js";

export function createContextIntegrityService(deps: {
  store: ContextIntegrityStore;
  resolveMessageClass: (input: {
    channelId: string;
    messageId: string;
  }) => Promise<"internal" | "external" | "unknown">;
}): ServiceDefinition {
  return {
    name: "contextIntegrity",
    description: "Monotone per-session content-ingestion latch",
    authority: { principals: ["code"] },
    methods: contextIntegrityMethods,
    handler: defineServiceHandler("contextIntegrity", contextIntegrityMethods, {
      ingest: async (ctx, [input]) => {
        const sessionId = ownSession(ctx);
        if (input.classification === "external") {
          return deps.store.ingest({
            sessionId,
            key: input.key,
            class: "external",
            via: input.via,
          });
        }
        const derivedClass = await resolveDerivedClass(input.key, deps);
        return deps.store.ingestResolved({
          sessionId,
          key: input.key,
          via: input.via,
          derivedClass,
        });
      },
      fact: (ctx) => deps.store.fact(ownSession(ctx)),
      explain: (ctx, [input]) =>
        deps.store.explainLineage({
          sessionId: ownSession(ctx),
          ...(input?.key ? { key: input.key } : {}),
          ...(input?.cursor ? { cursor: input.cursor } : {}),
          ...(input?.limit ? { limit: input.limit } : {}),
        }),
    }),
  };
}

async function resolveDerivedClass(
  key: string,
  deps: {
    store: ContextIntegrityStore;
    resolveMessageClass: (input: {
      channelId: string;
      messageId: string;
    }) => Promise<"internal" | "external" | "unknown">;
  }
): Promise<"internal" | "external" | "unknown"> {
  if (key.startsWith("session:")) {
    const contentClass = deps.store.factIfKnown(key.slice("session:".length))?.class;
    return contentClass === "internal" || contentClass === "external" ? contentClass : "unknown";
  }
  if (key.startsWith("msg:")) {
    const separator = key.indexOf("/", "msg:".length);
    if (separator < 0) return "unknown";
    return deps.resolveMessageClass({
      channelId: key.slice("msg:".length, separator),
      messageId: key.slice(separator + 1),
    });
  }
  return "unknown";
}

function ownSession(ctx: Parameters<ServiceDefinition["handler"]>[0]): string {
  const sessionId = ctx.authorization?.agentBinding?.channelId;
  if (!sessionId) {
    throw Object.assign(new Error("Context integrity is scoped to the calling session"), {
      code: "EACCES",
    });
  }
  return sessionId;
}
