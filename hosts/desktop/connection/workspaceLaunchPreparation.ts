import { createTemplatesClient } from "@vibestudio/service-schemas/clients/templatesClient";
import { hubControlMethods } from "@vibestudio/service-schemas/hubControl";
import { vcsMethods } from "@vibestudio/service-schemas/vcs";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { readDefaultWorkspaceTemplates } from "@vibestudio/workspace/templateRelease";
import { readWorkspaceSources } from "@vibestudio/workspace/workspaceSources";
import type { Call } from "@vibestudio/client-host-core";
import type { ConnectedSession, ConnectedWorkspace } from "../main/serverSession.js";
import type { ClientLaunchHostDeps } from "./clientLaunchHost.js";
import type { ClientLaunchNotice } from "./connectionProtocol.js";
import { reconcileWorkspaceLaunchUpdates } from "./workspaceLaunchUpdates.js";

/** Local product updates are part of the ordinary admitted client launch. */
export async function createWorkspaceLaunchPreparation(
  session: ConnectedSession,
  workspace: (workspaceId: string) => Promise<ConnectedWorkspace>,
  env: NodeJS.ProcessEnv = process.env
): Promise<Pick<ClientLaunchHostDeps, "prepare" | "companions">> {
  if (session.connectionMode !== "local") return {};
  const appRoot = env["VIBESTUDIO_APP_ROOT"];
  if (!appRoot) throw new Error("Workspace launch preparation requires VIBESTUDIO_APP_ROOT");
  const targets = [
    ...Object.values(readDefaultWorkspaceTemplates(appRoot, env)),
    ...readWorkspaceSources(env).map((source) => source.pin),
  ];
  const members = await createTypedServiceClient(
    "hubControl",
    hubControlMethods,
    session.hubControlClient.call.bind(session.hubControlClient)
  ).listWorkspaces();
  const owners = members.filter((member) => member.privateRole);
  const calls = owners.map(
    (owner): Call =>
      async (service, method, args) => {
        const connection = await workspace(owner.workspaceId);
        return connection.serverClient.call(service, method, args);
      }
  );
  type Preparation = Awaited<ReturnType<NonNullable<ClientLaunchHostDeps["prepare"]>>>;
  let inFlight: Promise<Preparation> | undefined;
  const prepare = (): Promise<Preparation> => {
    if (inFlight) return inFlight;
    const run = async (): Promise<Preparation> => {
      // Each workspace owns a protected main; all independent publications are
      // joined before resolving the client build. Templates orders its own roots.
      // An update is an improvement to source the workspace already has, so a
      // failed one leaves that workspace on its installed version and is
      // reported to the person; it never keeps the client from launching.
      const results = await Promise.allSettled(
        owners.map((owner, index) =>
          reconcileWorkspaceLaunchUpdates({
            client: createTemplatesClient(calls[index]!),
            mainState: () => createTypedServiceClient("vcs", vcsMethods, calls[index]!).mainState(),
            targets,
            log: (receipt) =>
              console.info(
                `[WorkspaceUpdates] ${JSON.stringify({ workspaceId: owner.workspaceId, ...receipt })}`
              ),
          })
        )
      );
      return {
        notices: results.flatMap((result, index): ClientLaunchNotice[] => {
          const owner = owners[index]!;
          const name = owner.displayName ?? owner.name;
          if (result.status === "rejected") {
            console.error(
              `[WorkspaceUpdates] ${owner.workspaceId} stays on its installed version:`,
              result.reason
            );
            return [
              {
                id: `workspace-update-failed:${owner.workspaceId}`,
                title: "Workspace update didn't finish",
                message:
                  `${name} is staying on its installed version for now. ` +
                  (result.reason instanceof Error ? result.reason.message : String(result.reason)),
              },
            ];
          }
          return result.value
            .filter((outcome) => outcome.status === "conflicts")
            .map((outcome) => ({
              id: `workspace-update:${outcome.operationId}`,
              title: "Workspace update needs review",
              message:
                `Local changes need review before ${name} can update. ` +
                `Resume Templates update ${outcome.operationId}.`,
            }));
        }),
      };
    };
    const operation = run();
    inFlight = operation;
    void operation
      .finally(() => {
        if (inFlight === operation) inFlight = undefined;
      })
      .catch(() => undefined);
    return operation;
  };
  return {
    prepare,
    companions: calls.filter((_call, index) => owners[index]!.workspaceId !== session.workspaceId),
  };
}
