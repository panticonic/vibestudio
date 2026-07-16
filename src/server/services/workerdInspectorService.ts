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
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { hasPanelHostingAuthority } from "@vibestudio/shared/serviceAuthorityChecks";
import type { WorkerdInspectorTarget } from "../workerdInspectorBridge.js";

export const WORKERD_INSPECTOR_CAPABILITY = "workerd.inspector";

export interface WorkerdInspectorServiceDeps {
  listTargets(): Promise<WorkerdInspectorTarget[]>;
  getEndpoint(
    targetPath: string,
    principalId: string
  ): { wsEndpoint: string; token: string } | null;
}

export function createWorkerdInspectorService(
  deps: WorkerdInspectorServiceDeps
): ServiceDefinition {
  const inspectorRequirement = requirementForPrincipals(
    ["host", "user", "code", "entity"],
    WORKERD_INSPECTOR_CAPABILITY
  );
  const methods = {
    listTargets: { args: z.tuple([]), access: { sensitivity: "read" as const } },
    getEndpoint: {
      args: z.tuple([z.string()]),
      authority: {
        requirement: requirementForPrincipals(
          ["host", "user", "code"],
          "service:workerdInspector.getEndpoint"
        ),
        resource: { kind: "literal" as const, key: "service:workerdInspector.getEndpoint" },
        prepared: {
          resolver: "workerdInspector.getEndpoint",
          leaves: [
            {
              capability: WORKERD_INSPECTOR_CAPABILITY,
              requirement: inspectorRequirement,
              evalAcquisition: {
                kind: "approval" as const,
                title: "Inspect workerd",
                description: "Attach the V8 inspector to workerd for profiling and debugging.",
                operation: { kind: "inspection", verb: "Inspect workerd" },
                grantScopes: ["run", "session", "version"] as const,
              },
            },
          ],
        },
      },
      access: { sensitivity: "admin" as const },
    },
  };

  return {
    name: "workerdInspector",
    description: "Approval-gated workerd V8 inspector access for profiling workers and DOs",
    authority: { principals: ["user", "host", "code"] },
    methods,
    authorityPreparation: {
      "workerdInspector.getEndpoint": async (ctx, args) => {
        if (await hasPanelHostingAuthority(ctx)) return [];
        const targetPath = String(args[0]);
        const caller = ctx.caller;
        return [
          {
            capability: WORKERD_INSPECTOR_CAPABILITY,
            resourceKey: `caller:${caller.runtime.id}`,
            challenge: {
              dedupKey: `workerd-inspector:${caller.runtime.id}`,
              resource: {
                type: "workerd-inspector",
                label: "Workerd inspector target",
                value: targetPath,
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
            },
          },
        ];
      },
    },
    handler: defineServiceHandler("workerdInspector", methods, {
      listTargets: () => deps.listTargets(),
      getEndpoint: async (ctx, [targetPath]) => {
        const caller = ctx.caller;
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
