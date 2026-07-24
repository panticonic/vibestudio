import type { ServiceContainer } from "@vibestudio/shared/serviceContainer";
import { assertPresent } from "../../lintHelpers";
import type { DODispatch } from "../doDispatch.js";
import {
  createSemanticControlPlaneCaller,
  SEMANTIC_CONTROL_PLANE,
} from "../internalDOs/controlPlane.js";
import type { WorkspaceVcs } from "../vcsHost/workspaceVcs.js";
import type { WorkerdManager } from "../workerdManager.js";
import type { VcsGcScheduler } from "../services/vcsGcScheduler.js";

export interface VcsDurabilityBootstrapDeps {
  container: Pick<ServiceContainer, "registerManaged">;
  workspaceVcs: WorkspaceVcs;
  registerControlPlanePrincipal(input: {
    targetId: string;
    source: string;
    className: string;
    objectKey: string;
    effectiveVersion: string;
    buildKey: string;
    executionDigest: string;
    authorityRequests: readonly import("@vibestudio/shared/authorityManifest").UnitAuthorityRequest[];
  }): void;
  activateSemanticWorkspace(workspaceVcs: WorkspaceVcs): Promise<void>;
}

/** Attach the semantic state machine, then initialize its host materialization. */
export function wireVcsDurability(deps: VcsDurabilityBootstrapDeps): void {
  deps.container.registerManaged({
    name: "vcsAttach",
    dependencies: ["doDispatch", "workerdManager"],
    async start(resolve) {
      const doDispatch = assertPresent(resolve<DODispatch>("doDispatch"));
      const workerdManager = assertPresent(resolve<WorkerdManager>("workerdManager"));
      const gadRef = {
        source: SEMANTIC_CONTROL_PLANE.source,
        className: SEMANTIC_CONTROL_PLANE.className,
        objectKey: SEMANTIC_CONTROL_PLANE.objectKey,
      };
      const prepared = await workerdManager.ensureDurableObjectEntity({
        source: gadRef.source,
        className: gadRef.className,
        key: gadRef.objectKey,
        contextId: `control-plane:${SEMANTIC_CONTROL_PLANE.objectKey}`,
      });
      deps.registerControlPlanePrincipal({ ...gadRef, ...prepared });
      await deps.workspaceVcs.attachGad(createSemanticControlPlaneCaller(doDispatch));
      console.log(
        `[Vcs] Attached sealed semantic control plane (${gadRef.source}:${gadRef.className})`
      );
      return deps.workspaceVcs;
    },
  });

  deps.container.registerManaged({
    name: "semanticWorkspace",
    // Activation uses only the already-sealed semantic control-plane DO. The
    // build system and remaining internal DO classes start afterward, so their
    // planned workerd restart cannot race semantic initialization.
    dependencies: ["vcsAttach"],
    async start(resolve) {
      const workspaceVcs = assertPresent(resolve<WorkspaceVcs>("vcsAttach"));
      await deps.activateSemanticWorkspace(workspaceVcs);
      return workspaceVcs;
    },
  });

  deps.container.registerManaged({
    name: "vcsGcScheduler",
    dependencies: ["semanticWorkspace"],
    async start(resolve) {
      const workspaceVcs = assertPresent(resolve<WorkspaceVcs>("semanticWorkspace"));
      const { VcsGcScheduler } = await import("../services/vcsGcScheduler.js");
      const scheduler = new VcsGcScheduler({ workspaceVcs });
      scheduler.start();
      return scheduler;
    },
    async stop(instance: VcsGcScheduler | null) {
      instance?.stop();
    },
  });
}
