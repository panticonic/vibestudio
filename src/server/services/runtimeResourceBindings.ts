import type { AuthorityGrant, ResourceScope } from "@vibestudio/rpc";
import { capabilityPatternCovers } from "@vibestudio/shared/authorityManifest";
import { codePrincipal } from "@vibestudio/shared/authority/codePrincipal";
import { panelAccessSeverityForTarget } from "@vibestudio/shared/panelAccessPolicy";
import { isAboutSource } from "@vibestudio/workspace-contracts/aboutNamespace";
import type {
  EntityRecord,
  RuntimeResourceBindingInput,
} from "@vibestudio/shared/runtime/entitySpec";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { contextBoundaryResourceKey } from "./contextBoundary.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";

export const RUNTIME_RESOURCE_BINDING_SURFACE = "runtime-resource-binding";
const ISSUER = "host:vibestudio";
const LINEAGE_CLASSES = ["channel-external", "email", "external", "none", "web"] as const;

export interface RuntimeResourceBindingDeps {
  grantStore: CapabilityGrantStore;
  resolvePanel(slotId: string): Promise<{ source: string | null; contextId: string | null }>;
  confirmPrivilegedPanel(input: {
    slotId: string;
    source: string | null;
    contextId: string;
    record: EntityRecord;
  }): Promise<boolean>;
}

export interface PreparedRuntimeResourceBindings {
  contextId: string;
  bind(record: EntityRecord): Promise<AuthorityGrant[]>;
}

function declares(record: EntityRecord, capability: string): boolean {
  return Boolean(
    record.activeAuthority?.requests.some((request) =>
      capabilityPatternCovers(request.capability, capability)
    )
  );
}

function severity(source: string | null): "standard" | "severe" {
  if (source === null) return "severe";
  return panelAccessSeverityForTarget({
    id: "runtime-resource-binding",
    ...(isAboutSource(source) ? { privileged: true } : {}),
  });
}

function bindingSurface(entityId: string, resourceKind?: string, resourceId?: string): string {
  const prefix = `${RUNTIME_RESOURCE_BINDING_SURFACE}:${entityId}`;
  return resourceKind && resourceId
    ? `${prefix}:${resourceKind}:${encodeURIComponent(resourceId)}`
    : prefix;
}

export async function prepareRuntimeResourceBindings(
  deps: RuntimeResourceBindingDeps,
  input: {
    bindings: RuntimeResourceBindingInput[];
    initiatingCaller: VerifiedCaller;
  }
): Promise<PreparedRuntimeResourceBindings> {
  if (!input.initiatingCaller.subject) {
    throw new Error("A runtime resource binding requires an authenticated user gesture");
  }
  if (input.bindings.length === 0) {
    throw new Error("A runtime resource binding request must not be empty");
  }
  const resolved: Array<{
    binding: RuntimeResourceBindingInput;
    panel: { source: string | null; contextId: string };
  }> = [];
  const resourceKeys = new Set<string>();
  for (const binding of input.bindings) {
    if (binding.resource.kind !== "panel-slot") {
      throw new Error(`Unsupported runtime resource kind: ${binding.resource.kind}`);
    }
    const resourceKey = `${binding.resource.kind}:${binding.resource.id}`;
    if (resourceKeys.has(resourceKey)) {
      throw new Error(`Duplicate runtime resource binding: ${resourceKey}`);
    }
    resourceKeys.add(resourceKey);
    if (binding.scope.kind === "entity") {
      if (binding.capabilities.length !== 0) {
        throw new Error("An entity lifecycle binding cannot grant capabilities");
      }
    } else if (binding.capabilities.length !== 1 || binding.capabilities[0] !== "panel.inspect") {
      throw new Error("An agent-channel panel binding may grant only panel.inspect");
    }
    const panel = await deps.resolvePanel(binding.resource.id);
    if (!panel.contextId) throw new Error(`Panel slot is not open: ${binding.resource.id}`);
    resolved.push({ binding, panel: { source: panel.source, contextId: panel.contextId } });
  }
  const contextId = resolved[0]!.panel.contextId;
  if (resolved.some(({ panel }) => panel.contextId !== contextId)) {
    throw new Error("Runtime resource bindings must resolve to one semantic context");
  }

  return {
    contextId,
    bind: async (record) => {
      const issued: AuthorityGrant[] = [];
      for (const { binding, panel } of resolved) {
        if (record.contextId !== panel.contextId) {
          throw new Error("Runtime resource context does not match the target entity context");
        }
        if (binding.scope.kind === "entity") continue;
        if (!record.agentBinding || record.agentBinding.channelId !== binding.scope.channelId) {
          throw new Error("A panel binding must name the target runtime's own agent channel");
        }
        if (!record.activeAuthority || !declares(record, "panel.inspect")) {
          throw new Error(
            "The target runtime did not declare the requested panel inspection binding"
          );
        }
        if (
          severity(panel.source) === "severe" &&
          !(await deps.confirmPrivilegedPanel({
            slotId: binding.resource.id,
            source: panel.source,
            contextId: panel.contextId,
            record,
          }))
        ) {
          throw new Error("Panel resource binding was denied");
        }
        const subject = codePrincipal(record.source);
        const constraints = {
          sessionId: binding.scope.channelId,
          lineageAtConsent: [...LINEAGE_CLASSES],
        };
        const shared = {
          effect: "allow" as const,
          subject,
          scope: "session" as const,
          constraints,
          issuedBy: ISSUER,
          provenance: "acquisition" as const,
          decidedBy: `user:${input.initiatingCaller.subject!.userId}`,
          decisionSurface: bindingSurface(record.id, binding.resource.kind, binding.resource.id),
          createdAt: Date.now(),
        };
        const resources: Array<{ capability: string; resource: ResourceScope }> = [
          { capability: "panel.inspect", resource: { kind: "exact", key: "panel.inspect" } },
        ];
        if (declares(record, "context.boundary")) {
          resources.push({
            capability: "context.boundary",
            resource: {
              kind: "prefix",
              prefix: contextBoundaryResourceKey(panel.contextId, ""),
            },
          });
        }
        issued.push(
          ...deps.grantStore.transaction(() =>
            resources.map(({ capability, resource }) =>
              deps.grantStore.issue({ ...shared, capability, resource })
            )
          )
        );
      }
      return issued;
    },
  };
}

export function revokeRuntimeResourceBindings(
  grantStore: CapabilityGrantStore,
  entityId: string,
  now = Date.now()
): number {
  return grantStore.transaction(() => {
    let revoked = 0;
    for (const grant of grantStore.listActiveAuthorityGrants(now)) {
      if (!grant.decisionSurface?.startsWith(`${bindingSurface(entityId)}:`)) continue;
      if (grant.id && grantStore.revoke(grant.id, now)) revoked += 1;
    }
    return revoked;
  });
}
