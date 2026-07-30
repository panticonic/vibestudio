import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import {
  fixedPreparedAuthoritySelection,
  preparedAuthorityState,
} from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { productBuiltinByIdentity } from "@vibestudio/shared/productBuiltinCatalog.generated";
import {
  reviewedClosureActivationSchema,
  reviewedClosureMethods,
} from "@vibestudio/service-schemas/reviewedClosure";
import type { ReviewedClosureRegistry } from "./reviewedClosureRegistry.js";

const ACTIVATE = "reviewed-closure.activate";

export function createReviewedClosureService(deps: {
  registry: ReviewedClosureRegistry;
}): ServiceDefinition {
  return {
    name: "reviewedClosure",
    description: "Kernel record for digest-bound reviewed execution authority",
    authority: { principals: ["code"] },
    methods: reviewedClosureMethods,
    authorityPreparation: {
      "reviewedClosure.activate.presentation": (ctx, args) => {
        requireBuiltinPublisher(ctx.caller.runtime.id);
        const input = reviewedClosureActivationSchema.parse(args[0]);
        return preparedAuthorityState([
          fixedPreparedAuthoritySelection({
            capability: ACTIVATE,
            resourceKey: `closure:${input.closureDigest}`,
            tier: "gated",
            challenge: {
              title: input.presentation.title,
              description: input.presentation.description,
              deniedReason: "The reviewed automation was not activated.",
              resource: {
                type: input.body.sourceDocument.kind,
                label: "Source document",
                value: input.body.sourceDocument.id,
              },
              operation: {
                kind: "runtime",
                verb: "activate reviewed automation",
                object: {
                  type: "reviewed-closure",
                  label: "Reviewed automation",
                  value: input.body.sourceDocument.id,
                },
              },
              substance: {
                kind: "custom",
                summary: input.presentation.summary,
                ...(input.presentation.detail ? { detail: input.presentation.detail } : {}),
                ...(input.presentation.facts ? { facts: input.presentation.facts } : {}),
              },
            },
          }),
        ]);
      },
    },
    handler: defineServiceHandler("reviewedClosure", reviewedClosureMethods, {
      activate: (ctx, [input]) =>
        deps.registry.activate({
          body: input.body,
          closureDigest: input.closureDigest,
          publisher: ctx.caller.runtime.id,
          decidedBy: decidedBy(ctx),
        }),
      suspend: (_ctx, [subject]) => deps.registry.suspend(subject),
      retire: (_ctx, [subject]) => deps.registry.retire(subject),
      bindSession: (ctx, [input]) =>
        deps.registry.bindSession({ ...input, binderId: ctx.caller.runtime.id }),
      finishSession: (ctx, [input]) =>
        deps.registry.finishSession(input.sessionId, ctx.caller.runtime.id),
    }),
  };
}

function requireBuiltinPublisher(runtimeId: string): void {
  const match = /^do:([^:]+):([^:]+):/u.exec(runtimeId);
  if (!match?.[1] || !match[2] || !productBuiltinByIdentity(match[1], match[2])) {
    throw Object.assign(
      new Error("Reviewed closure presentation must come from a cataloged builtin"),
      { code: "EACCES" }
    );
  }
}

function decidedBy(ctx: Parameters<ServiceDefinition["handler"]>[0]): `user:${string}` {
  const userId = ctx.authorizingCaller?.subject?.userId ?? ctx.caller.subject?.userId;
  if (!userId || userId === "system") {
    throw Object.assign(new Error("Reviewed closure activation requires a human decision"), {
      code: "EACCES",
    });
  }
  return `user:${userId}`;
}
