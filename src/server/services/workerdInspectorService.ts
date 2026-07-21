/**
 * workerdInspector service — approval-gated userland access to the workerd
 * V8 inspector for profiling workers and Durable Objects.
 *
 * Not dev-gated: Vibestudio is a continuous-development system, so the
 * inspector stays available; the approvals flow (capability
 * "workerd.inspector", grantable per caller) is the access control, matching
 * the panelCdp model. The inspector socket itself binds loopback and is only
 * reachable through the WorkerdInspectorBridge with a single-use grant token.
 */
import { z } from "zod";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { AppCapability } from "@vibestudio/shared/unitManifest";
import type { WorkerdInspectorTarget } from "../workerdInspectorBridge.js";
import {
  requestCapabilityPermission,
  type CapabilityPermissionDeps,
} from "./capabilityPermission.js";
import { isAuthorizedChrome } from "./chromeTrust.js";

export const WORKERD_INSPECTOR_CAPABILITY = "workerd.inspector";

export interface WorkerdInspectorServiceDeps extends CapabilityPermissionDeps {
  hasAppCapability?: (callerId: string, capability: AppCapability) => boolean;
  listTargets(): Promise<WorkerdInspectorTarget[]>;
  getEndpoint(
    targetPath: string,
    principalId: string
  ): { wsEndpoint: string; token: string } | null;
}

export function createWorkerdInspectorService(
  deps: WorkerdInspectorServiceDeps
): ServiceDefinition {
  const methods = {
    listTargets: { args: z.tuple([]), access: { sensitivity: "read" as const } },
    getEndpoint: {
      args: z.tuple([z.string()]),
      access: { sensitivity: "admin" as const },
    },
  };

  return {
    name: "workerdInspector",
    description: "Approval-gated workerd V8 inspector access for profiling workers and DOs",
    authority: { principals: ["user", "host", "code"] },
    methods,
    handler: defineServiceHandler("workerdInspector", methods, {
      listTargets: () => deps.listTargets(),
      getEndpoint: async (ctx, [targetPath]) => {
        const caller = ctx.caller;
        if (!isAuthorizedChrome(caller, { hasAppCapability: deps.hasAppCapability })) {
          const permission = await requestCapabilityPermission(deps, {
            caller,
            capability: WORKERD_INSPECTOR_CAPABILITY,
            dedupKey: `workerd-inspector:${caller.runtime.id}`,
            resource: {
              type: "workerd-inspector",
              label: "Workerd inspector target",
              value: targetPath,
              // One grant covers all targets for the caller — targets are
              // ephemeral per-service paths, not meaningful trust boundaries.
              key: `caller:${caller.runtime.id}`,
            },
            operation: {
              kind: "inspection",
              verb: "Inspect workerd",
              object: {
                type: "workerd-inspector",
                label: "Target",
                value: targetPath,
              },
              groupKey: `workerd-inspector:${caller.runtime.id}`,
            },
            title: `Inspect ${targetPath}`,
            description:
              `Allow ${caller.runtime.kind} ${caller.runtime.id} to attach the V8 inspector ` +
              `to workerd (CPU profiles, heap inspection of workers and durable objects).`,
            details: [
              { label: "Caller", value: `${caller.runtime.kind} ${caller.runtime.id}` },
              { label: "Target", value: targetPath },
            ],
            deniedReason: "Workerd inspector access denied",
          });
          if (!permission.allowed) {
            throw new Error(permission.reason ?? "Workerd inspector access denied");
          }
        }
        const endpoint = deps.getEndpoint(targetPath, caller.runtime.id);
        if (!endpoint) {
          throw new Error(
            "Workerd inspector is unavailable (disabled via VIBESTUDIO_DISABLE_WORKERD_INSPECTOR or workerd not running)"
          );
        }
        return endpoint;
      },
    }),
  };
}
