import { isEvalHost, requireEvalKernel, type HostsEvalKernel } from "./evalKernelAuthority.js";
import { entityHostRef } from "@vibestudio/shared/evalRuntimeIdentity";
import type { AgentExecutionSessionRegistry } from "./agentExecutionSessionRegistry.js";
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
 * The eval kernel cannot mutate the host publication journal directly. This narrow
 * ingress authenticates the exact admitted run, reserves the artifact in the
 * host journal, and finalizes only after the eval kernel's durable owner row commits.
 */
export function createEvalExecutionRootsService(deps: {
  doDispatch: HeldDoDispatcher;
  entityStore: WorkspaceEntityStore;
  publicationPort: ExecutionPublicationPort;
  executionSessions: Pick<AgentExecutionSessionRegistry, "resolve" | "resolveInvocation">;
  /** Classes that host their own kernel (§6.11.6) are eval hosts like a session entity. */
  hostsEvalKernel?: HostsEvalKernel;
}): ServiceDefinition {
  return {
    name: "evalExecutionRoots",
    description: "Internal publication interlock for eval workspace imports",
    authority: { principals: ["code"] },
    methods: evalExecutionRootsMethods,
    handler: defineServiceHandler("evalExecutionRoots", evalExecutionRootsMethods, {
      retain: async (ctx, [runId, moduleSpecifier, artifactInput]) => {
        const admitted = deps.executionSessions.resolve(ctx.caller.runtime.id);
        const execution = admitted
          ? deps.executionSessions.resolveInvocation(ctx.caller.runtime.id, admitted.nonce)
          : null;
        const entity = requireEvalKernel(
          ctx.caller,
          deps.entityStore.cache,
          "evalExecutionRoots",
          "retain",
          deps.hostsEvalKernel
        );
        if (
          !execution ||
          execution.executor.kind !== "dynamic-code" ||
          execution.executor.runtimeId !== ctx.caller.runtime.id ||
          execution.executor.runId !== runId ||
          !entity ||
          !isEvalHost(entity, deps.hostsEvalKernel) ||
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
        const host = entityHostRef(entity)!;
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
              .dispatch(host, "retainExecutionRoot", runId, moduleSpecifier, artifact)
              .then(() => undefined)
        );
        return { retained: true as const };
      },
    }),
  };
}
