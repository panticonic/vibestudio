import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { baseReleaseMethods } from "@vibestudio/service-schemas/baseRelease";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import { templatesMethods, type TemplateStatusRow } from "@vibestudio/service-schemas/templates";
import { createHostCaller, type ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
import type { UserSubject } from "@vibestudio/identity/types";

const BASE_URL = "git+https://github.com/panticonic/vibestudio-workspace-base.git";

export function createBaseReleaseService(deps: {
  target: WorkspaceTemplatePin;
  dispatcher: Pick<ServiceDispatcher, "dispatch">;
  systemSubject: UserSubject;
}): ServiceDefinition {
  const invokeComposer = (method: "status" | "pull", args: unknown[]) =>
    deps.dispatcher.dispatch(
      { caller: createHostCaller("server", "server", deps.systemSubject) },
      "extensions",
      "invoke",
      ["@workspace-extensions/template-composer", method, args]
    );
  const installedBase = async (): Promise<TemplateStatusRow> => {
    const rows = templatesMethods.status.returns.parse(await invokeComposer("status", []));
    const row = rows.find((candidate) => candidate.url === BASE_URL);
    if (!row) throw new Error("This workspace has no installed Vibestudio Base lineage");
    return row;
  };

  return {
    name: "baseRelease",
    description: "Verified host-to-Base release update handshake",
    authority: { principals: ["user", "host"] },
    methods: baseReleaseMethods,
    handler: defineServiceHandler("baseRelease", baseReleaseMethods, {
      check: async () => {
        const installed = await installedBase();
        return {
          alias: installed.alias,
          installed,
          target: deps.target,
          updateAvailable: installed.commit !== deps.target.commit,
        };
      },
      pull: async (_ctx, [input]) => {
        const installed = await installedBase();
        return templatesMethods.pull.returns.parse(
          await invokeComposer("pull", [
            { commandId: input.commandId, alias: installed.alias, pin: deps.target },
          ])
        );
      },
    }),
  };
}
