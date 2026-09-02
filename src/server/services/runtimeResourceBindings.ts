import type { AuthorityGrant, ResourceScope } from "@vibestudio/rpc";
import { capabilityPatternCovers } from "@vibestudio/shared/authorityManifest";
import { codePrincipal } from "@vibestudio/shared/authority/codePrincipal";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
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
const QUICKFIRE_SOURCE = "workers/quickfire-service";
const WORKSPACE_DIAGNOSTICS_RESOURCE = {
  kind: "workspace-diagnostics",
  id: "server-logs",
} as const;

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

function bindingGrantSignature(
  grant: Pick<
    AuthorityGrant,
    "capability" | "resource" | "subject" | "scope" | "constraints" | "decisionSurface"
  >
): string {
  return canonicalJson({
    capability: grant.capability,
    resource: grant.resource,
    subject: grant.subject,
    scope: grant.scope,
    constraints: grant.constraints ?? {},
    decisionSurface: grant.decisionSurface,
  });
}

export async function prepareRuntimeResourceBindings(
  deps: RuntimeResourceBindingDeps,
  input: {
    bindings: RuntimeResourceBindingInput[];
    lifecycleCaller: VerifiedCaller;
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
    panel: { source: string | null; contextId: string } | null;
  }> = [];
  const resourceKeys = new Set<string>();
  for (const binding of input.bindings) {
    const resourceKey = `${binding.resource.kind}:${binding.resource.id}`;
    if (resourceKeys.has(resourceKey)) {
      throw new Error(`Duplicate runtime resource binding: ${resourceKey}`);
    }
    resourceKeys.add(resourceKey);
    if (binding.resource.kind === "panel-slot") {
      if (
        (binding.scope.kind === "entity" && binding.capabilities.length !== 0) ||
        (binding.scope.kind === "agent-channel" &&
          (binding.capabilities.length !== 1 || binding.capabilities[0] !== "panel.inspect"))
      ) {
        throw new Error("A panel binding must either select context or grant panel.inspect");
      }
      const panel = await deps.resolvePanel(binding.resource.id);
      if (!panel.contextId) throw new Error(`Panel slot is not open: ${binding.resource.id}`);
      resolved.push({ binding, panel: { source: panel.source, contextId: panel.contextId } });
      continue;
    }
    if (
      binding.resource.kind === WORKSPACE_DIAGNOSTICS_RESOURCE.kind &&
      binding.resource.id === WORKSPACE_DIAGNOSTICS_RESOURCE.id
    ) {
      // Diagnostics are not panel authority. Quickfire's verified launcher may
      // attach this separate, lifecycle-owned resource to the same agent; the
      // resulting grant targets the agent binding used by eval authorization.
      if (
        binding.scope.kind !== "agent-channel" ||
        binding.capabilities.length !== 1 ||
        binding.capabilities[0] !== "server-logs.read" ||
        input.lifecycleCaller.code?.repoPath !== QUICKFIRE_SOURCE
      ) {
        throw new Error("Only Quickfire may bind redacted workspace diagnostics");
      }
      resolved.push({ binding, panel: null });
      continue;
    }
    throw new Error(`Unsupported runtime resource: ${resourceKey}`);
  }
  const panelBindings = resolved.filter(
    (entry): entry is typeof entry & { panel: NonNullable<typeof entry.panel> } =>
      entry.panel !== null
  );
  const contextId = panelBindings[0]?.panel.contextId;
  if (!contextId) {
    throw new Error("Runtime resource bindings require a context-owning resource");
  }
  if (panelBindings.some(({ panel }) => panel.contextId !== contextId)) {
    throw new Error("Runtime resource bindings must resolve to one semantic context");
  }

  return {
    contextId,
    bind: async (record) => {
      const preparedGrants: Array<{
        shared: {
          effect: "allow";
          issuedBy: string;
          provenance: "acquisition";
          decidedBy: string;
          decisionSurface: string;
          createdAt: number;
        };
        resources: Array<{
          capability: string;
          resource: ResourceScope;
          subject: AuthorityGrant["subject"];
          scope: AuthorityGrant["scope"];
          constraints: NonNullable<AuthorityGrant["constraints"]>;
        }>;
      }> = [];
      for (const { binding, panel } of resolved) {
        if (panel && record.contextId !== panel.contextId) {
          throw new Error("Runtime resource context does not match the target entity context");
        }
        if (binding.scope.kind === "entity") continue;
        if (!record.agentBinding || record.agentBinding.channelId !== binding.scope.channelId) {
          throw new Error("A resource binding must name the target runtime's own agent channel");
        }
        if (
          !record.activeAuthority ||
          binding.capabilities.some((capability) => !declares(record, capability))
        ) {
          throw new Error("The target runtime did not declare the requested resource binding");
        }
        const shared = {
          effect: "allow" as const,
          issuedBy: ISSUER,
          provenance: "acquisition" as const,
          decidedBy: `user:${input.initiatingCaller.subject!.userId}`,
          decisionSurface: bindingSurface(record.id, binding.resource.kind, binding.resource.id),
          createdAt: Date.now(),
        };
        const resources: Array<{
          capability: string;
          resource: ResourceScope;
          subject: AuthorityGrant["subject"];
          scope: AuthorityGrant["scope"];
          constraints: NonNullable<AuthorityGrant["constraints"]>;
        }> = panel
          ? [
              {
                capability: "panel.inspect",
                resource: { kind: "exact", key: "panel.inspect" },
                subject: codePrincipal(record.source),
                scope: "session",
                constraints: {
                  sessionId: binding.scope.channelId,
                  lineageAtConsent: [...LINEAGE_CLASSES],
                },
              },
              {
                capability: "panel.inspect",
                resource: { kind: "exact", key: "panel.inspect" },
                subject: `agent:${record.id}@${record.contextId}`,
                scope: "agent",
                constraints: { lineageAtConsent: [...LINEAGE_CLASSES] },
              },
            ]
          : [
              {
                capability: "server-logs.read",
                resource: { kind: "prefix", prefix: "" },
                subject: `agent:${record.id}@${record.contextId}`,
                scope: "agent",
                constraints: { lineageAtConsent: [...LINEAGE_CLASSES] },
              },
            ];
        if (panel && declares(record, "context.boundary")) {
          resources.push({
            capability: "context.boundary",
            resource: {
              kind: "prefix",
              prefix: contextBoundaryResourceKey(panel.contextId, ""),
            },
            subject: codePrincipal(record.source),
            scope: "session",
            constraints: {
              sessionId: binding.scope.channelId,
              lineageAtConsent: [...LINEAGE_CLASSES],
            },
          });
          resources.push({
            capability: "context.boundary",
            resource: {
              kind: "prefix",
              prefix: contextBoundaryResourceKey(panel.contextId, ""),
            },
            subject: `agent:${record.id}@${record.contextId}`,
            scope: "agent",
            constraints: { lineageAtConsent: [...LINEAGE_CLASSES] },
          });
        }
        preparedGrants.push({ shared, resources });
      }
      const prior = deps.grantStore
        .listActiveAuthorityGrants()
        .filter((grant) => grant.decisionSurface?.startsWith(`${bindingSurface(record.id)}:`));
      const expectedSignatures = preparedGrants
        .flatMap(({ shared, resources }) =>
          resources.map((resource) => bindingGrantSignature({ ...resource, ...shared }))
        )
        .sort();
      const priorSignatures = prior.map(bindingGrantSignature).sort();
      if (
        expectedSignatures.length === priorSignatures.length &&
        expectedSignatures.every((signature, index) => signature === priorSignatures[index])
      ) {
        return prior;
      }
      for (const { binding, panel } of resolved) {
        if (
          panel &&
          binding.scope.kind === "agent-channel" &&
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
      }
      return deps.grantStore.transaction(() => {
        const revokedAt = Date.now();
        for (const grant of prior) {
          if (grant.id) deps.grantStore.revoke(grant.id, revokedAt);
        }
        return preparedGrants.flatMap(({ shared, resources }) =>
          resources.map(({ capability, resource, subject, scope, constraints }) =>
            deps.grantStore.issue({
              ...shared,
              capability,
              resource,
              subject,
              scope,
              constraints,
            })
          )
        );
      });
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
