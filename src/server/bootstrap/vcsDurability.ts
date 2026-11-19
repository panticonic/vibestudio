import type { ServiceContainer } from "@vibestudio/shared/serviceContainer";
import { canonicalEntityId } from "@vibestudio/shared/runtime/entitySpec";
import { assertPresent } from "../../lintHelpers";
import type { DODispatch } from "../doDispatch.js";
import {
  createWorkspaceSemanticPort,
  createWorkspaceSourceProviderV1,
  type WorkspaceSourceProviderRef,
} from "../workspaceSourceProvider.js";
import type { WorkspaceVcs } from "../vcsHost/workspaceVcs.js";
import type { RuntimeManager } from "../runtimeManager.js";
import type { GcEpochCoordinator } from "../services/gcEpochCoordinator.js";
import type { BuildSystemV2 } from "../buildV2/index.js";
import type { ExecutionPublicationJournal } from "../executionPublicationJournal.js";
import {
  migrateWorkspaceHistory,
  readWorkspaceHistoryReplayFreeze,
  readWorkspaceHistoryReplayReceipt,
  WORKSPACE_PARTICIPANT_HISTORY_MIGRATION,
} from "../vcsHost/workspaceHistoryMigration.js";
import { canonicalWorkspaceObjectContextId } from "./workspaceObjectIdentity.js";

export interface VcsDurabilityBootstrapDeps {
  container: Pick<ServiceContainer, "registerManaged">;
  workspaceVcs: WorkspaceVcs;
  executionPublicationJournal: ExecutionPublicationJournal;
  workspaceSourceProvider: WorkspaceSourceProviderRef;
  workspaceId: string;
  /** The state captured before semantic initialization may mutate the source root. */
  bootstrapStateHash: string;
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
  listWorkspaceHistorySessionOwners(contextIds: readonly string[]): Promise<Array<{ contextId: string; userId: string }>>;
  readProtectedMainEventId(): string | null;
  activateSemanticWorkspace(workspaceVcs: WorkspaceVcs): Promise<void>;
}

/** Resume only the canonical history named by this workspace's durable runtime. */
async function restoreParticipantHistory(
  deps: VcsDurabilityBootstrapDeps,
  dispatch: DODispatch,
  runtime: RuntimeManager,
  reserve = false,
): Promise<boolean> {
  const legacy = deps.workspaceSourceProvider;
  const canonical = { ...legacy, className: "GadHistoryDO", objectKey: "canonical" };
  const target = { source: canonical.source, className: canonical.className, key: canonical.objectKey };
  const targetId = canonicalEntityId({ kind: "do", ...target });
  const owner = await deps.readWorkspaceHistoryOwner(targetId);
  if (!owner && !reserve) return false;
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
  const receipt = await readWorkspaceHistoryReplayReceipt(dispatch, canonical);
  const held = await readWorkspaceHistoryReplayFreeze(dispatch, legacy);
  const expectedMainEventId = receipt?.eventId ?? deps.readProtectedMainEventId();
  if (!receipt && !held && !expectedMainEventId) return false;
  if (!receipt && !held) {
    const supportsReplay = await dispatch.dispatch(canonical, "supportsHistoryReplay");
    if (supportsReplay !== true) {
      console.warn("[Vcs] Participant history migration requires a runtime with scoped queries");
      return true;
    }
  }
  // The durable system-owned canonical lifetime is also the reservation
  // for migration. Startup can resume a stop between that reservation and
  // the source freeze using the exact protected event of this workspace.
  const freeze = held ?? (!receipt && expectedMainEventId ? {
    operationId: WORKSPACE_PARTICIPANT_HISTORY_MIGRATION,
    expectedMainEventId,
  } : null);
  if (
    freeze?.operationId !== WORKSPACE_PARTICIPANT_HISTORY_MIGRATION ||
    freeze.expectedMainEventId !== expectedMainEventId
  ) {
    throw new Error("Participant history startup requires the original held migration");
  }
  await migrateWorkspaceHistory({
    dispatch, source: legacy, destination: canonical, freeze,
  });
  await deps.workspaceVcs.attachParticipantHistory({
    dispatch, canonical, infrastructureContextId: contextId,
    listReplayedSessionOwners: deps.listWorkspaceHistorySessionOwners,
  });
  return true;
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
      deps.workspaceVcs.attachWorkspaceSourceProvider(
        createWorkspaceSourceProviderV1(doDispatch, gadRef)
      );
      phaseComplete("source-provider attachment");
      console.log(
        `[Vcs] Attached manifest-declared workspace source provider (${gadRef.source}:${gadRef.className})`
      );
      const historyChecked = await restoreParticipantHistory(deps, doDispatch, runtimeManager);
      if (deps.workspaceVcs.participantHistoryAttached) phaseComplete("installed participant history");
      deps.workspaceVcs.startSemanticInitialization(async () => {
        await deps.activateSemanticWorkspace(deps.workspaceVcs);
        if (!historyChecked && runtimeManager.declaresRemoteDoltClass(gadRef.source, "GadHistoryDO")) {
          await restoreParticipantHistory(deps, doDispatch, runtimeManager, true);
          if (deps.workspaceVcs.participantHistoryAttached) phaseComplete("installed participant history");
        }
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
