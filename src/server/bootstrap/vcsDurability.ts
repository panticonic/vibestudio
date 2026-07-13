import type { ServiceContainer } from "@vibestudio/shared/serviceContainer";
import type { WorkspaceDeclarations } from "@vibestudio/workspace/singletonRegistry";
import { assertPresent } from "../../lintHelpers";
import type { DODispatch } from "../doDispatch.js";
import type { VcsGcScheduler } from "../services/vcsGcScheduler.js";
import { resolveVcsStoreBinding } from "../userlandServices.js";
import type { WorkspaceVcs } from "../vcsHost/workspaceVcs.js";
import type { WorkerdManager } from "../workerdManager.js";

export interface VcsDurabilityBootstrapDeps {
  container: Pick<ServiceContainer, "registerManaged">;
  workspaceDeclarations: WorkspaceDeclarations;
  workspaceVcs: WorkspaceVcs;
  startupBarrier: Promise<void>;
  systemOwnerUserId: string;
  activateDurableObject(
    doDispatch: DODispatch,
    workerdManager: WorkerdManager,
    ref: {
      source: string;
      className: string;
      objectKey: string;
      buildRef: string;
      ownerUserId: string;
    }
  ): Promise<void>;
}

/** Register durable VCS attachment and its post-attachment maintenance chain. */
export function wireVcsDurability(deps: VcsDurabilityBootstrapDeps): void {
  deps.container.registerManaged({
    name: "vcsAttach",
    dependencies: ["doDispatch", "workerdManager"],
    async start(resolve) {
      const binding = resolveVcsStoreBinding(deps.workspaceDeclarations);
      if (!binding) {
        console.error(
          "[Vcs] meta/vibestudio.yml declares no singleton-DO-backed `vcs` service " +
            "(protocol vibestudio.vcs.v1 with a matching singletonObjects row) — durable VCS " +
            "store disabled (no durable commits, context forks, or builds provenance)"
        );
        return deps.workspaceVcs;
      }

      const doDispatch = assertPresent(resolve<DODispatch>("doDispatch"));
      const workerdManager = assertPresent(resolve<WorkerdManager>("workerdManager"));
      const gadRef = {
        source: binding.source,
        className: binding.className,
        objectKey: binding.objectKey,
        buildRef: "main",
      };
      // Activate identity before the DO can call back into host services.
      await deps.activateDurableObject(doDispatch, workerdManager, {
        ...gadRef,
        ownerUserId: deps.systemOwnerUserId,
      });
      await deps.workspaceVcs.attachGad({
        call: <T>(
          method: string,
          input: unknown,
          opts?: { invocationToken?: string }
        ): Promise<T> =>
          (opts?.invocationToken
            ? doDispatch.dispatchOnBehalf(gadRef, method, [input], opts.invocationToken)
            : doDispatch.dispatch(gadRef, method, input)) as Promise<T>,
      });
      deps.workspaceVcs.memory.enable({ startupBarrier: deps.startupBarrier });
      console.log(`[Vcs] Attached to VCS store DO (${binding.source}:${binding.className})`);
      return deps.workspaceVcs;
    },
  });

  deps.container.registerManaged({
    name: "vcsGcScheduler",
    dependencies: ["vcsAttach"],
    async start(resolve) {
      const { VcsGcScheduler } = await import("../services/vcsGcScheduler.js");
      const attachedVcs = assertPresent(resolve<WorkspaceVcs>("vcsAttach"));
      const scheduler = new VcsGcScheduler({
        workspaceVcs: attachedVcs,
        startupBarrier: deps.startupBarrier,
      });
      scheduler.start();
      return scheduler;
    },
    async stop(instance: VcsGcScheduler | null) {
      instance?.stop();
    },
  });
}
