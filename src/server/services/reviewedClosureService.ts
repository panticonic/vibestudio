import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { reviewedClosureMethods } from "@vibestudio/service-schemas/reviewedClosure";
import type { ReviewedClosureRegistry } from "./reviewedClosureRegistry.js";

export function createReviewedClosureService(deps: {
  registry: ReviewedClosureRegistry;
}): ServiceDefinition {
  return {
    name: "reviewedClosure",
    description: "Kernel record for digest-bound installed execution authority",
    authority: { principals: ["code"] },
    methods: reviewedClosureMethods,
    handler: defineServiceHandler("reviewedClosure", reviewedClosureMethods, {
      activate: (ctx, [input]) =>
        deps.registry.activate({
          body: input.body,
          closureDigest: input.closureDigest,
          publisher: ctx.caller.runtime.id,
          decidedBy: decidedBy(ctx),
        }),
      suspend: (ctx, [subject]) => deps.registry.suspend(subject, ctx.caller.runtime.id),
      retire: (ctx, [subject]) => deps.registry.retire(subject, ctx.caller.runtime.id),
      bindSession: (ctx, [input]) =>
        deps.registry.bindSession({ ...input, binderId: ctx.caller.runtime.id }),
      finishSession: (ctx, [input]) =>
        deps.registry.finishSession(input.sessionId, ctx.caller.runtime.id),
    }),
  };
}

function decidedBy(ctx: Parameters<ServiceDefinition["handler"]>[0]): `user:${string}` {
  const authorization = ctx.authorization;
  const attributedUser =
    authorization?.actingUser ??
    authorization?.ownerChain.at(-1) ??
    [...(authorization?.initiatorChain ?? [])]
      .reverse()
      .find((principal) => principal.startsWith("user:"));
  const directUser = ctx.authorizingCaller?.subject?.userId ?? ctx.caller.subject?.userId;
  const userId =
    directUser && directUser !== "system" ? directUser : attributedUser?.slice("user:".length);
  if (!userId || userId === "system") {
    throw Object.assign(new Error("Automation installation requires user-attributed intent"), {
      code: "EACCES",
    });
  }
  return `user:${userId}`;
}
