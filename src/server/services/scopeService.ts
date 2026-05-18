import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";
import { doTargetId, type RpcCallerLike } from "@natstack/shared/userlandServiceRpc";

const scopeEntrySchema = z.object({
  id: z.string(),
  channelId: z.string(),
  panelId: z.string(),
  data: z.string(),
  serializedKeys: z.array(z.string()),
  droppedPaths: z.array(z.object({ path: z.string(), reason: z.string() })),
  partialKeys: z.array(z.string()),
  createdAt: z.number(),
});

export function createScopeService(deps: { rpc: RpcCallerLike }): ServiceDefinition {
  const ref = {
    source: INTERNAL_DO_SOURCE,
    className: "ScopeStoreDO",
    objectKey: "global",
  };

  return {
    name: "scope",
    description: "REPL scope persistence backed by an internal Durable Object",
    policy: { allowed: ["panel", "worker", "extension", "shell", "server"] },
    methods: {
      upsert: { args: z.tuple([scopeEntrySchema]) },
      loadCurrent: { args: z.tuple([z.string(), z.string()]) },
      get: { args: z.tuple([z.string()]) },
      list: { args: z.tuple([z.string()]) },
    },
    handler: (_ctx, method, args) => deps.rpc.call(doTargetId(ref), method, ...args),
  };
}
