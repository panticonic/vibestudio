import * as fs from "node:fs";
import * as path from "node:path";
import type { CapabilityScope } from "@vibestudio/rpc";
import type { ServiceContainer } from "@vibestudio/shared/serviceContainer";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import type { EventService } from "@vibestudio/shared/eventsService";
import type { StateLayout } from "../stateLayout.js";
import type { WorkspaceVcs } from "../vcsHost/workspaceVcs.js";
import type { PanelRuntimeCoordinator } from "../panelRuntimeCoordinator.js";
import type { AttachedHostPublisher } from "../services/attachedHostController.js";
import type { AttachedHostEndpoint } from "../services/attachedHostProtocol.js";
import type { ServerLogStore } from "../services/serverLogStore.js";
import type { WorkspaceChildHubPort } from "../workspaceChildHubPort.js";
import type { createAttachedHostPublicationPorts } from "../services/attachedHostTransport.js";

function readHostExecutionDigest(repoRoot: string): string {
  const record = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "dist", "host-build-fingerprint.json"), "utf8")
  ) as { version?: unknown; fingerprint?: unknown };
  if (record.version !== 1 || !/^[0-9a-f]{64}$/u.test(String(record.fingerprint ?? ""))) {
    throw new Error("The trusted host build fingerprint is missing or invalid");
  }
  return String(record.fingerprint);
}

export interface DevelopmentNativeBootstrapDeps {
  appRoot: string;
  container: Pick<ServiceContainer, "registerManaged">;
  workspaceId: string;
  workspaceVcs: WorkspaceVcs;
  layout: Pick<StateLayout, "development" | "blobsDir">;
  eventService: EventService;
  serverLogStore: Pick<ServerLogStore, "append">;
  getLocalGatewayUrl(context: string): string;
  createAttachedHostPublicationPorts(
    input: Parameters<typeof createAttachedHostPublicationPorts>[0]
  ): ReturnType<typeof createAttachedHostPublicationPorts>;
  attachedHostParentEndpoint: AttachedHostEndpoint;
  attachedHostPublisher: AttachedHostPublisher;
  attachedHostParentId: string;
  attachedHostAuthorityCeiling: readonly CapabilityScope[];
  workspaceChildHub: Pick<WorkspaceChildHubPort, "mintDeviceInvite">;
  panelRuntimeCoordinator: Pick<PanelRuntimeCoordinator, "resolvePresentationCallerForRuntime">;
}

/** Wire the exact native effects consumed by the userland development builtin. */
export async function wireDevelopmentNative(deps: DevelopmentNativeBootstrapDeps): Promise<void> {
  const { DevelopmentExecutor } = await import("../services/developmentExecutor.js");
  const { IsolatedDevelopmentHostExecutor } =
    await import("../services/isolatedDevelopmentHostExecutor.js");
  const { DevelopmentClientExecutorRegistry } =
    await import("../services/developmentClientExecutorService.js");
  const { createNativeDevelopmentController } =
    await import("../services/nativeDevelopmentComposition.js");
  const { createNativeDevelopmentSemanticAdapter } =
    await import("../services/nativeDevelopmentSemanticAdapter.js");

  let developmentNativeDefinition: ServiceDefinition | null = null;
  let developmentExecutor: InstanceType<typeof DevelopmentExecutor> | null = null;
  let nativeDevelopmentController:
    | import("../services/developmentNativeService.js").ExactNativeDevelopmentController
    | null = null;
  const logs = new Map<string, Array<{ stream: "stdout" | "stderr"; line: string }>>();
  const isolatedInstanceId = process.env["VIBESTUDIO_INSTANCE"];
  const isolatedGenerationId = process.env["VIBESTUDIO_DEVELOPMENT_INSTANCE_GENERATION"];
  const clientExecutors = new DevelopmentClientExecutorRegistry({
    eventService: deps.eventService,
    ...(process.env["VIBESTUDIO_DEVELOPMENT_PARENT_RUN"] &&
    isolatedInstanceId &&
    isolatedGenerationId
      ? {
          isolatedHost: {
            instanceId: isolatedInstanceId,
            generationId: isolatedGenerationId,
          },
        }
      : {}),
  });
  let clientExecutorDefinition: ServiceDefinition | null = null;

  deps.container.registerManaged({
    name: "developmentClientExecutor",
    dependencies: [],
    async start() {
      clientExecutorDefinition = clientExecutors.definition();
    },
    getServiceDefinition() {
      if (!clientExecutorDefinition) {
        throw new Error("development client executor service not initialized");
      }
      return clientExecutorDefinition;
    },
  });

  deps.container.registerManaged({
    name: "developmentNative",
    dependencies: ["developmentClientExecutor", "attachedHosts"],
    async start() {
      const hostExecutionDigest = readHostExecutionDigest(deps.appRoot);
      const semantic = createNativeDevelopmentSemanticAdapter(deps.workspaceVcs);
      const appendLog = (runId: string, stream: "stdout" | "stderr", line: string, origin = "") => {
        const current = logs.get(runId) ?? [];
        current.push({ stream, line });
        logs.set(runId, current);
        deps.serverLogStore.append("info", [`[development:${runId}:${origin}${stream}] ${line}`]);
      };
      developmentExecutor = new DevelopmentExecutor({
        workspaceId: deps.workspaceId,
        hostExecutionDigest,
        root: deps.layout.development.runsDir,
        planSource: (input) => deps.workspaceVcs.planExactContextRepository(input),
        materializeSource: (plan, destination) =>
          deps.workspaceVcs.materializeExactRepositoryPlan(plan, destination),
        onLog: (runId, stream, line) => appendLog(runId, stream, line),
      });
      nativeDevelopmentController = await createNativeDevelopmentController({
        executorId: `local:${hostExecutionDigest}`,
        root: deps.layout.development.nativeSessionsDir,
        blobsDir: deps.layout.blobsDir,
        semantic,
        planSource: ({ developmentContextId, repositoryId }) =>
          deps.workspaceVcs.planExactContextRepository({
            contextId: developmentContextId,
            repositoryId,
            requiredFiles: [],
          }),
        materializeSource: (plan, destination) =>
          deps.workspaceVcs.materializeExactRepositoryPlan(plan, destination),
      });
      const { createDevelopmentNativeService } =
        await import("../services/developmentNativeService.js");
      const { TemplateRepositoryExchangeExecutor } =
        await import("../services/templateRepositoryExchangeExecutor.js");
      const templateExchange = new TemplateRepositoryExchangeExecutor({
        root: path.join(deps.layout.development.root, "template-exchanges"),
        blobsDir: deps.layout.blobsDir,
        semantic,
        planSource: (input) => deps.workspaceVcs.planExactContextRepository(input),
        materializeSource: (plan, destination) =>
          deps.workspaceVcs.materializeExactRepositoryPlan(plan, destination),
      });
      const isolatedExecutor = new IsolatedDevelopmentHostExecutor({
        controlRepoRoot: deps.appRoot,
        parentGatewayUrl: deps.getLocalGatewayUrl("attached development host callback"),
        buildExecutor: developmentExecutor,
        onLog: (runId, stream, line) => appendLog(runId, stream, line, "isolated:"),
        createAttachmentPorts: (input) =>
          deps.createAttachedHostPublicationPorts({
            ...input,
            parentEndpoint: deps.attachedHostParentEndpoint,
          }),
      });
      developmentNativeDefinition = createDevelopmentNativeService({
        native: nativeDevelopmentController,
        executor: developmentExecutor,
        isolatedExecutor,
        clientExecutors,
        templateExchange,
        mintCurrentHostInvite: (input) => deps.workspaceChildHub.mintDeviceInvite(input),
        resolveClientExecutorRuntime: (ctx) => {
          for (const caller of [ctx.caller, ctx.authorizingCaller, ctx.transportCaller]) {
            if (!caller) continue;
            if (caller.runtime.kind === "shell") return caller.runtime.id;
            const presentation = deps.panelRuntimeCoordinator.resolvePresentationCallerForRuntime(
              caller.runtime.id
            );
            if (presentation) return presentation;
          }
          return null;
        },
        attachedHostPublisher: deps.attachedHostPublisher,
        attachedHostParentId: deps.attachedHostParentId,
        attachedHostAuthorityCeiling: deps.attachedHostAuthorityCeiling,
        takeLogs: (runId) => {
          const current = logs.get(runId) ?? [];
          logs.delete(runId);
          return current;
        },
      });
    },
    getServiceDefinition() {
      if (!developmentNativeDefinition) {
        throw new Error("development native service not initialized");
      }
      return developmentNativeDefinition;
    },
  });
}
