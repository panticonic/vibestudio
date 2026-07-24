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
import { isAuthorizedChrome } from "./chromeTrust.js";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import { describeCapability } from "@vibestudio/shared/authorityPresentation";

export const WORKERD_INSPECTOR_CAPABILITY = "runtime.inspect";
const WORKERD_INSPECTOR_AUTHORITY_RESOLVER = "workerdInspector.getEndpoint.target";

export interface WorkerdInspectorServiceDeps {
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
      authority: {
        requirement: requirementForPrincipals(
          ["user", "host", "code"],
          WORKERD_INSPECTOR_CAPABILITY
        ),
        resource: { kind: "literal" as const, key: WORKERD_INSPECTOR_CAPABILITY },
        prepared: {
          resolver: WORKERD_INSPECTOR_AUTHORITY_RESOLVER,
          leaves: [
            {
              capability: WORKERD_INSPECTOR_CAPABILITY,
              requirement: { kind: "selected" as const, principals: ["code" as const] },
              tier: "gated" as const,
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
      [WORKERD_INSPECTOR_AUTHORITY_RESOLVER]: (ctx, [rawTargetPath]) => {
        if (
          isAuthorizedChrome(ctx.caller, { hasAppCapability: deps.hasAppCapability }) ||
          (!ctx.caller.code && !ctx.caller.executionSession)
        ) {
          return [];
        }
        const targetPath = String(rawTargetPath);
        const copy = describeCapability(WORKERD_INSPECTOR_CAPABILITY);
        const resource = {
          type: "workspace-process",
          label: "Workspace process",
          value: targetPath,
        };
        return [
          {
            capability: WORKERD_INSPECTOR_CAPABILITY,
            resourceKey: `caller:${ctx.caller.runtime.id}`,
            challenge: {
              title: copy.title,
              description: copy.description,
              deniedReason: "Inspecting this workspace process was not allowed",
              dedupKey: `runtime-inspect:${ctx.caller.runtime.id}`,
              resource,
              operation: {
                kind: "inspection",
                verb: copy.action,
                object: resource,
                groupKey: `runtime-inspect:${ctx.caller.runtime.id}`,
              },
              details: [{ label: "Workspace process", value: targetPath }],
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
