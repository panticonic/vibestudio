import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
import { authorityMethods } from "@vibestudio/service-schemas/authority";
import type { AcquisitionCoordinator } from "./acquisitionCoordinator.js";

export function createAuthorityService(deps: {
  dispatcher: ServiceDispatcher;
  acquisitions: AcquisitionCoordinator;
}): ServiceDefinition {
  return {
    name: "authority",
    description: "Acquisition lifecycle and side-effect-free authority inspection",
    authority: { principals: ["host", "user", "code", "session", "mission"] },
    methods: authorityMethods,
    handler: defineServiceHandler("authority", authorityMethods, {
      awaitDecision: (ctx, [input]) => {
        return deps.acquisitions.awaitDecision({
          acquisitionId: input.acquisitionId,
          ownerRuntimeId: ctx.caller.runtime.id,
        });
      },
      preflight: (ctx, [input]) =>
        deps.dispatcher.preflightAuthority(ctx, input.service, input.method, input.args),
    }),
  };
}
