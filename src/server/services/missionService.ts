import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { missionMethods } from "@vibestudio/service-schemas/mission";
import type { MissionRegistry } from "./missionRegistry.js";

export function createMissionService(deps: {
  registry: MissionRegistry;
  contextIntegrityReady: () => boolean;
}): ServiceDefinition {
  return {
    name: "mission",
    description: "Content-addressed charters for recurring and unattended agents",
    authority: { principals: ["user", "host"] },
    methods: missionMethods,
    handler: defineServiceHandler("mission", missionMethods, {
      list: () => deps.registry.list(),
      get: (_ctx, [missionId]) => deps.registry.get(missionId),
      createDraft: (ctx, [input]) => {
        const owner = humanOwner(ctx);
        return deps.registry.createDraft({ ...input, owner });
      },
      edit: (ctx, [missionId, input]) =>
        deps.registry.edit(missionId, { ...input, forkOwner: humanOwner(ctx) }),
      approve: (ctx, [missionId, permissions]) =>
        deps.registry.approve({
          missionId,
          permissions,
          decidedBy: `user:${humanOwner(ctx).userId}`,
          contextIntegrityReady: deps.contextIntegrityReady(),
        }),
      pause: (_ctx, [missionId]) => deps.registry.pause(missionId),
      resume: (_ctx, [missionId]) => deps.registry.resume(missionId),
      retire: (_ctx, [missionId]) => deps.registry.retire(missionId),
      startSession: (_ctx, [input]) => deps.registry.startSession(input),
      finishSession: (_ctx, [input]) => {
        deps.registry.finishSession(input);
      },
    }),
  };
}

function humanOwner(ctx: Parameters<ServiceDefinition["handler"]>[0]): {
  userId: string;
  deviceId: string;
} {
  const userId = ctx.caller.subject?.userId;
  if (!userId || userId === "system") {
    throw Object.assign(new Error("Mission changes require a human user"), { code: "EACCES" });
  }
  return { userId, deviceId: ctx.caller.runtime.id };
}
