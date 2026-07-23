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
      list: (ctx) => {
        const userId = viewerUserId(ctx);
        return userId === null ? deps.registry.list() : deps.registry.listForUser(userId);
      },
      get: (ctx, [missionId]) => {
        const userId = viewerUserId(ctx);
        return userId === null
          ? deps.registry.get(missionId)
          : deps.registry.getForUser(missionId, userId);
      },
      createDraft: (ctx, [input]) => {
        const owner = humanOwner(ctx);
        return deps.registry.createDraft({ ...input, owner });
      },
      edit: (ctx, [missionId, input]) => {
        const owner = humanOwner(ctx);
        return deps.registry.edit(missionId, {
          ...input,
          actingUserId: owner.userId,
          forkOwner: owner,
        });
      },
      approve: (ctx, [missionId, permissions]) => {
        const owner = humanOwner(ctx);
        return deps.registry.approve({
          missionId,
          permissions,
          decidedBy: `user:${owner.userId}`,
          contextIntegrityReady: deps.contextIntegrityReady(),
        });
      },
      pause: (ctx, [missionId]) => deps.registry.pause(missionId, humanUserId(ctx)),
      resume: (ctx, [missionId]) => deps.registry.resume(missionId, humanUserId(ctx)),
      retire: (ctx, [missionId]) => deps.registry.retire(missionId, humanUserId(ctx)),
      startSession: (_ctx, [input]) => deps.registry.startSession(input),
      finishSession: (_ctx, [input]) => {
        deps.registry.finishSession(input);
      },
    }),
  };
}

function viewerUserId(ctx: Parameters<ServiceDefinition["handler"]>[0]): string | null {
  if (ctx.caller.hostOriginated === true) return null;
  return humanUserId(ctx);
}

function humanUserId(ctx: Parameters<ServiceDefinition["handler"]>[0]): string {
  const userId = ctx.caller.subject?.userId;
  if (!userId || userId === "system") {
    throw Object.assign(new Error("Mission changes require a human user"), { code: "EACCES" });
  }
  return userId;
}

function humanOwner(ctx: Parameters<ServiceDefinition["handler"]>[0]): {
  userId: string;
  deviceId: string;
} {
  return {
    userId: humanUserId(ctx),
    deviceId: ctx.caller.runtime.id,
  };
}
