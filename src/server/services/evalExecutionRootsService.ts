import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { ServiceAccessError } from "@vibestudio/shared/serviceDispatcher";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import {
  publishExecutionOwnerAsync,
  verifyExecutionArtifactRef,
  type ExecutionPublicationPort,
} from "@vibestudio/shared/execution/retention";
import { evalExecutionRootsMethods } from "@vibestudio/service-schemas/evalExecutionRoots";
import type { HeldDoDispatcher } from "@vibestudio/shared/doDispatcher";
import type { WorkspaceEntityStore } from "../workspaceEntityStore.js";

/**
 * The EvalDO cannot mutate the host publication journal directly. This narrow
 * ingress authenticates the exact admitted run, reserves the artifact in the
 * host journal, and finalizes only after the EvalDO's durable owner row commits.
 */
export function createEvalExecutionRootsService(deps: {
  doDispatch: HeldDoDispatcher;
  entityStore: WorkspaceEntityStore;
  publicationPort: ExecutionPublicationPort;
}): ServiceDefinition {
  return {
    name: "evalExecutionRoots",
    description: "Internal publication interlock for eval workspace imports",
    authority: { principals: ["session"] },
    methods: evalExecutionRootsMethods,
    handler: defineServiceHandler("evalExecutionRoots", evalExecutionRootsMethods, {
      retain: async (ctx, [runId, moduleSpecifier, artifactInput]) => {
        const execution = ctx.caller.executionSession;
        const entity = deps.entityStore.cache.resolveActive(ctx.caller.runtime.id);
        if (
          !execution ||
          execution.executor.kind !== "eval" ||
          execution.executor.runtimeId !== ctx.caller.runtime.id ||
          execution.executor.evalRunId !== runId ||
          !ctx.caller.runtime.id.startsWith("do:vibestudio/internal:EvalDO:") ||
          entity?.kind !== "do" ||
          entity.source.repoPath !== "vibestudio/internal" ||
          entity.className !== "EvalDO" ||
          entity.contextId !== execution.contextId
        ) {
          throw new ServiceAccessError(
            "evalExecutionRoots",
            "retain",
            "Eval import does not belong to the authenticated execution session",
            "EACCES"
          );
        }
        const artifact = verifyExecutionArtifactRef(artifactInput);
        const objectKey = ctx.caller.runtime.id.slice("do:vibestudio/internal:EvalDO:".length);
        const ownerId = `${ctx.caller.runtime.id}:${runId}:${moduleSpecifier}`;
        await publishExecutionOwnerAsync(
          deps.publicationPort,
          {
            owner: "eval-run",
            ownerId,
            artifacts: [
              {
                buildKey: artifact.buildKey,
                executionDigest: artifact.executionDigest,
              },
            ],
          },
          () =>
            deps.doDispatch
              .dispatch(
                {
                  source: "vibestudio/internal",
                  className: "EvalDO",
                  objectKey,
                },
                "retainExecutionRoot",
                runId,
                moduleSpecifier,
                artifact
              )
              .then(() => undefined)
        );
        return { retained: true as const };
      },
    }),
  };
}
