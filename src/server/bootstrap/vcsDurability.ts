import type { ServiceContainer } from "@vibestudio/shared/serviceContainer";
import { canonicalEntityId } from "@vibestudio/shared/runtime/entitySpec";
import { assertPresent } from "../../lintHelpers";
import type { DODispatch } from "../doDispatch.js";
import {
  createWorkspaceSemanticPort,
  type WorkspaceSourceProviderRef,
} from "../workspaceSourceProvider.js";
import type { WorkspaceVcs } from "../vcsHost/workspaceVcs.js";
import type { WorkspaceHistorySource } from "../vcsHost/workspaceHistoryHost.js";
import type { RuntimeManager } from "../runtimeManager.js";
import type { GcEpochCoordinator } from "../services/gcEpochCoordinator.js";
import type { BuildSystemV2 } from "../buildV2/index.js";
import type { ExecutionPublicationJournal } from "../executionPublicationJournal.js";
import { canonicalWorkspaceObjectContextId } from "./workspaceObjectIdentity.js";

export interface VcsDurabilityBootstrapDeps {
  container: Pick<ServiceContainer, "registerManaged">;
  workspaceVcs: WorkspaceVcs;
  executionPublicationJournal: ExecutionPublicationJournal;
  workspaceSourceProvider: WorkspaceSourceProviderRef;
  workspaceId: string;
  /** The state captured before semantic initialization may mutate the source root. */
  bootstrapStateHash: string;
  sharedHistorySeed?: Omit<Parameters<WorkspaceVcs["initializeSharedHistory"]>[0], "dispatch" | "canonical"> & {
    remember(): Promise<void>;
  };
  exportSharedHistorySeed?: (history: WorkspaceHistorySource) => Promise<void>;
  publishWorkspaceSourceEntity(input: {
    targetId: string;
    source: string;
    className: string;
    objectKey: string;
    effectiveVersion: string;
    buildKey: string;
    executionDigest: string;
    authority: import("@vibestudio/shared/authorityManifest").UnitAuthorityManifest;
    contextId: string;
  }): Promise<void>;
  readWorkspaceHistoryOwner(targetId: string): Promise<{ contextId: string } | null>;
  readProtectedMainEventId(): string | null;
  activateSemanticWorkspace(workspaceVcs: WorkspaceVcs): Promise<void>;
}

/** Initialize or reopen the canonical history for the workspace's native runtime. */
async function attachNativeWorkspaceHistory(
  deps: VcsDurabilityBootstrapDeps,
  dispatch: DODispatch,
  runtime: RuntimeManager,
): Promise<void> {
  const canonical = {
    source: deps.workspaceSourceProvider.source,
    className: "GadHistoryDO",
    objectKey: "canonical",
  };
  if (!runtime.declaresRemoteDoltClass(canonical.source, canonical.className)) {
    throw new Error("Workspace startup requires the native Dolt history class");
  }
  const target = { source: canonical.source, className: canonical.className, key: canonical.objectKey };
  const targetId = canonicalEntityId({ kind: "do", ...target });
  const owner = await deps.readWorkspaceHistoryOwner(targetId);
  if (!owner && deps.readProtectedMainEventId() !== null) {
    throw new Error("Workspace has saved history in an older format. This release requires a native workspace.");
  }
  const contextId = canonicalWorkspaceObjectContextId(deps.workspaceId, target);
  if (owner && owner.contextId !== contextId) {
    throw new Error("The canonical participant history has a different runtime lifetime");
  }
  const prepared = await runtime.ensureDurableObjectEntity({
    ...target, ref: deps.bootstrapStateHash, contextId,
  });
  if (prepared.targetId !== targetId)
    throw new Error("The runtime prepared a different canonical participant history");
  await deps.publishWorkspaceSourceEntity({ ...canonical, contextId, ...prepared });
  const history = { dispatch, canonical };
  const attachment = {
    ...history,
    infrastructureContextId: contextId,
    destroyRetiredStorage: (owner: WorkspaceSourceProviderRef) => runtime.destroyRetiredDOStorage(owner),
  };
  if (deps.sharedHistorySeed) {
    const destination = await runtime.workspaceNodeEndpoint();
    if (destination.nodeId === deps.sharedHistorySeed.seed.sourceNodeId) {
      throw new Error("The workspace seed destination must have its own node identity");
    }
    await deps.workspaceVcs.initializeSharedHistory({ ...deps.sharedHistorySeed, ...history });
    await deps.sharedHistorySeed.remember();
  } else if (!await deps.workspaceVcs.initializeFreshHistory(history)) {
    throw new Error("Workspace startup requires a native root template and native workspace history");
  }
  await deps.workspaceVcs.attachParticipantHistory(attachment);
  await deps.exportSharedHistorySeed?.(history);
  if (!deps.sharedHistorySeed) console.log("[Vcs] Attached native root workspace history");
}

/** Attach the semantic state machine, then initialize its host materialization. */
export function wireVcsDurability(deps: VcsDurabilityBootstrapDeps): void {
  deps.container.registerManaged({
    name: "vcsAttach",
    dependencies: ["doDispatch", "runtimeManager"],
    async start(resolve) {
      const startedAt = performance.now();
      let phaseStartedAt = startedAt;
      const phaseComplete = (phase: string): void => {
        const now = performance.now();
        console.log(
          `[Vcs] Bootstrap ${phase} completed in ${Math.round(now - phaseStartedAt)}ms ` +
            `(total ${Math.round(now - startedAt)}ms)`
        );
        phaseStartedAt = now;
      };
      const doDispatch = assertPresent(resolve<DODispatch>("doDispatch"));
      const runtimeManager = assertPresent(resolve<RuntimeManager>("runtimeManager"));
      const gadRef = deps.workspaceSourceProvider;
      const contextId = canonicalWorkspaceObjectContextId(deps.workspaceId, {
        source: gadRef.source,
        className: gadRef.className,
        key: gadRef.objectKey,
      });
      const prepared = await runtimeManager.ensureDurableObjectEntity({
        source: gadRef.source,
        ref: deps.bootstrapStateHash,
        className: gadRef.className,
        key: gadRef.objectKey,
        contextId,
      });
      phaseComplete("runtime binding");
      await deps.publishWorkspaceSourceEntity({ ...gadRef, contextId, ...prepared });
      phaseComplete("entity publication");
      await deps.workspaceVcs.attachGad(createWorkspaceSemanticPort(doDispatch, gadRef));
      phaseComplete("semantic port attachment");
      deps.workspaceVcs.startSemanticInitialization(async () => {
        await attachNativeWorkspaceHistory(deps, doDispatch, runtimeManager);
        phaseComplete("native participant history");
        await deps.activateSemanticWorkspace(deps.workspaceVcs);
      });
      return deps.workspaceVcs;
    },
    async stop() {
      // Attachment owns initialization even if another required service fails
      // before the background semanticWorkspace service has started.
      await deps.workspaceVcs.whenSemanticReady();
    },
  });

  deps.container.registerManaged({
    name: "semanticWorkspace",
    // The source provider uses the same build and runtime owners as every
    // later workspace operation. Activation publishes its initial content.
    dependencies: ["vcsAttach"],
    async start(resolve) {
      const workspaceVcs = assertPresent(resolve<WorkspaceVcs>("vcsAttach"));
      await workspaceVcs.whenSemanticReady();
      return workspaceVcs;
    },
  });

  deps.container.registerManaged({
    name: "gcEpochCoordinator",
    dependencies: ["semanticWorkspace", "buildSystem"],
    async start(resolve) {
      const workspaceVcs = assertPresent(resolve<WorkspaceVcs>("semanticWorkspace"));
      const buildSystem = assertPresent(resolve<BuildSystemV2>("buildSystem"));
      const { GcEpochCoordinator } = await import("../services/gcEpochCoordinator.js");
      const coordinator = new GcEpochCoordinator({
        workspaceVcs,
        buildSystem,
        publicationJournal: deps.executionPublicationJournal,
      });
      coordinator.start();
      return coordinator;
    },
    async stop(instance: GcEpochCoordinator | null) {
      await instance?.stop();
    },
  });
}
