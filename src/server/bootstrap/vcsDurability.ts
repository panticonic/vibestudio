import type { ServiceContainer } from "@vibestudio/shared/serviceContainer";
import { assertPresent } from "../../lintHelpers";
import type { DODispatch } from "../doDispatch.js";
import {
  createWorkspaceSemanticPort,
  createWorkspaceSourceProviderV1,
  type WorkspaceSourceProviderRef,
} from "../workspaceSourceProvider.js";
import type { WorkspaceVcs } from "../vcsHost/workspaceVcs.js";
import type { WorkerdManager } from "../workerdManager.js";
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
  activateSemanticWorkspace(workspaceVcs: WorkspaceVcs): Promise<void>;
}

/** Attach the semantic state machine, then initialize its host materialization. */
export function wireVcsDurability(deps: VcsDurabilityBootstrapDeps): void {
  deps.container.registerManaged({
    name: "vcsAttach",
    dependencies: ["doDispatch", "workerdManager"],
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
      const workerdManager = assertPresent(resolve<WorkerdManager>("workerdManager"));
      const gadRef = deps.workspaceSourceProvider;
      const contextId = canonicalWorkspaceObjectContextId(deps.workspaceId, {
        source: gadRef.source,
        className: gadRef.className,
        key: gadRef.objectKey,
      });
      const prepared = await workerdManager.ensureDurableObjectEntity({
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
      return deps.workspaceVcs;
    },
  });

  deps.container.registerManaged({
    name: "semanticWorkspace",
    // The source provider uses the same build and runtime owners as every
    // later workspace operation. Activation publishes its initial content.
    dependencies: ["vcsAttach"],
    async start(resolve) {
      const workspaceVcs = assertPresent(resolve<WorkspaceVcs>("vcsAttach"));
      await deps.activateSemanticWorkspace(workspaceVcs);
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
      instance?.stop();
    },
  });
}
