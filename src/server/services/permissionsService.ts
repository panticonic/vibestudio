import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { ServiceError } from "@vibestudio/shared/serviceDispatcher";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import {
  permissionsMethods,
  type SavedPermissionGrant,
} from "@vibestudio/service-schemas/permissions";
import type { AuthorityGrant, AuthorityGrantSubject, ResourceScope } from "@vibestudio/rpc";
import { describeCapability } from "@vibestudio/shared/authorityPresentation";
import {
  AUTHORITY_DOMAINS,
  AUTHORITY_VERBS,
  capabilityDomain,
  type AuthorityDomainId,
  type AuthorityVerb,
} from "@vibestudio/shared/authority/capabilityDomains";
import { resourcePhrase } from "@vibestudio/shared/authority/authorityRows";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import {
  credentialUseGrantId,
  type CredentialUseGrantStoreLike,
} from "./credentialUseGrantStore.js";
import { browserEnvironmentIdentityFromContext } from "../browserEnvironmentIdentity.js";
import type { BrowserPermissionGrantStore } from "./browserPermissionsService.js";

const SERVICE = "permissions";

export function createPermissionsService(deps: {
  capabilityGrants: CapabilityGrantStore;
  credentialUseGrants: CredentialUseGrantStoreLike;
  browserPermissions: BrowserPermissionGrantStore;
  workspaceId: string;
}): ServiceDefinition {
  return {
    name: SERVICE,
    description: "Trusted review and revocation of durable permission grants",
    authority: { principals: ["user", "host", "code"] },
    methods: permissionsMethods,
    handler: defineServiceHandler(SERVICE, permissionsMethods, {
      list: async (ctx) => {
        await deps.browserPermissions.ensureLoaded();
        const identity = browserEnvironmentIdentityFromContext(deps.workspaceId, ctx);
        const capability: SavedPermissionGrant[] = deps.capabilityGrants
          .listActiveAuthorityGrants()
          .filter((grant) => !grant.capability.startsWith("userland.choice/"))
          .map(savedAuthorityGrant);
        const userland: SavedPermissionGrant[] = deps.capabilityGrants
          .listPersistentUserland()
          .map(({ id, grant }) => ({
            id,
            kind: "userland",
            callerLabel: grant.principal.repoPath || grant.principal.callerId,
            scopeLabel:
              grant.scope === "version"
                ? `Remembered choice: ${grant.choice} (this version)`
                : `Remembered choice: ${grant.choice}`,
            capability: grant.subject.label ?? "Agent choice",
            resource: grant.subject.id,
            ...(grant.principal.repoPath ? { repoPath: grant.principal.repoPath } : {}),
            ...(grant.principal.effectiveVersion
              ? { effectiveVersion: grant.principal.effectiveVersion }
              : {}),
            grantedAt: grant.grantedAt,
          }));
        const credentialUse: SavedPermissionGrant[] = deps.credentialUseGrants
          .listAll()
          .map((grant) => ({
            id: credentialUseGrantId(grant),
            kind: "credential-use",
            callerLabel: grant.scope === "agent" ? grant.agentId : grant.repoPath,
            scopeLabel:
              grant.scope === "agent" ? "Trusted for this agent" : "Trusted for this code version",
            capability: `Credential ${grant.use}: ${grant.action}`,
            resource: grant.resource,
            ...(grant.scope === "version"
              ? { repoPath: grant.repoPath, effectiveVersion: grant.effectiveVersion }
              : {}),
            grantedAt: grant.grantedAt,
          }));
        const browserSites: SavedPermissionGrant[] = deps.browserPermissions
          .list(identity.environmentKey, identity.ownerUserId)
          .map((grant) => ({
            id: deps.browserPermissions.idFor(identity.environmentKey, identity.ownerUserId, grant),
            kind: "browser-site",
            callerLabel: grant.origin,
            scopeLabel:
              grant.decision === "block"
                ? "Blocked for this browser environment"
                : grant.scope === "session"
                  ? "Allowed for this session"
                  : "Always allowed",
            capability: `Website ${grant.capability}`,
            resource: grant.origin,
            grantedAt: grant.updatedAt,
          }));
        return [...capability, ...userland, ...credentialUse, ...browserSites].sort(
          (a, b) => (b.grantedAt ?? 0) - (a.grantedAt ?? 0)
        );
      },
      revoke: async (ctx, [{ kind, id }]) => {
        if (kind === "browser-site") {
          await deps.browserPermissions.ensureLoaded();
          const identity = browserEnvironmentIdentityFromContext(deps.workspaceId, ctx);
          const removed = await deps.browserPermissions.revokeById(
            identity.environmentKey,
            identity.ownerUserId,
            id
          );
          if (!removed)
            throw new ServiceError(SERVICE, "revoke", "Permission grant not found", "ENOENT");
          return;
        }
        const removed =
          kind === "capability"
            ? deps.capabilityGrants.revoke(id)
            : kind === "userland"
              ? deps.capabilityGrants.revokePersistentUserland(id)
              : await deps.credentialUseGrants.revoke(id);
        if (!removed)
          throw new ServiceError(SERVICE, "revoke", "Permission grant not found", "ENOENT");
      },
      listAgentProfiles: async () => {
        deps.capabilityGrants.suspendIdleAgentGrants();
        return agentProfiles(deps.capabilityGrants);
      },
      updateAgentProfile: async (_ctx, [request]) => {
        let changed = false;
        if (request.action === "revoke-grant") {
          changed = deps.capabilityGrants.revoke(request.id);
        } else if (request.action === "restore-grant") {
          changed = deps.capabilityGrants.restore(request.id);
        } else if (request.action === "unlock") {
          changed = deps.capabilityGrants.revokeLock(request.id);
        } else {
          const result = deps.capabilityGrants.resetAgentAuthority(request.bindingId, {
            keepLocks: request.keepLocks,
          });
          changed = result.grants > 0 || result.locks > 0;
        }
        if (!changed) {
          throw new ServiceError(
            SERVICE,
            "updateAgentProfile",
            "Agent permission setting not found",
            "ENOENT"
          );
        }
      },
    }),
  };
}

type AgentAuthorityProfile =
  import("@vibestudio/service-schemas/permissions").AgentAuthorityProfile;

function agentProfiles(store: CapabilityGrantStore): AgentAuthorityProfile[] {
  const grants = store.listAgentAuthorityGrants();
  const locks = store.listLocks().filter((lock) => lock.revokedAt === undefined);
  const bindingIds = new Set<string>();
  for (const grant of grants) bindingIds.add(grant.subject.slice("agent:".length));
  for (const lock of locks) bindingIds.add(lock.agentBindingId);
  return [...bindingIds].sort().map((bindingId) => agentProfile(bindingId, grants, locks));
}

function agentProfile(
  bindingId: string,
  allGrants: readonly AuthorityGrant[],
  allLocks: readonly import("@vibestudio/rpc").AuthorityLock[]
): AgentAuthorityProfile {
  const grants = allGrants.filter((grant) => grant.subject === `agent:${bindingId}`);
  const locks = allLocks.filter((lock) => lock.agentBindingId === bindingId);
  const cells: AgentAuthorityProfile["cells"] = [];
  for (const domain of Object.keys(AUTHORITY_DOMAINS) as AuthorityDomainId[]) {
    for (const verb of Object.keys(AUTHORITY_VERBS) as AuthorityVerb[]) {
      const cellGrants = grants.filter((grant) => {
        const category = capabilityDomain(grant.capability);
        return category?.domain === domain && category.verb === verb;
      });
      const cellLocks = locks.filter((lock) => {
        if (lock.level === "cell") return lock.domain === domain && lock.verb === verb;
        const category = lock.capability ? capabilityDomain(lock.capability) : null;
        return category?.domain === domain && category.verb === verb;
      });
      const items: AgentAuthorityProfile["cells"][number]["items"] = [
        ...cellGrants.map((grant) => {
          if (!grant.id) throw new Error("Persisted authority grant has no identity");
          return {
            id: grant.id,
            kind: "grant" as const,
            capability: grant.capability,
            action: describeCapability(grant.capability).action,
            resource: resourcePhrase(grant.resource),
            domain,
            verb,
            state: grant.suspendedAt ? ("suspended" as const) : ("active" as const),
            decidedAt: grant.createdAt,
            ...(grant.lastUsedAt ? { lastUsedAt: grant.lastUsedAt } : {}),
          };
        }),
        ...cellLocks.map((lock) => ({
          id: lock.id,
          kind: "lock" as const,
          ...(lock.capability ? { capability: lock.capability } : {}),
          action: lock.capability
            ? describeCapability(lock.capability).action
            : `${AUTHORITY_VERBS[verb].label.toLowerCase()} ${AUTHORITY_DOMAINS[domain].label.toLowerCase()}`,
          ...(lock.resource ? { resource: resourcePhrase(lock.resource) } : {}),
          domain,
          verb,
          state: "locked" as const,
          decidedAt: lock.createdAt,
          attemptCount: lock.attemptCount,
          ...(lock.lastAttemptAt ? { lastAttemptAt: lock.lastAttemptAt } : {}),
        })),
      ];
      const activeCount = cellGrants.filter((grant) => !grant.suspendedAt).length;
      cells.push({
        domain,
        verb,
        state:
          domain === "safety"
            ? "not-available"
            : cellLocks.some((lock) => lock.level === "cell")
              ? "never"
              : activeCount > 0
                ? "allowed"
                : "asks-first",
        allowanceCount: activeCount,
        items,
      });
    }
  }
  const allowedDomains = new Set(
    cells.filter((cell) => cell.state === "allowed").map((cell) => cell.domain)
  );
  const name = agentBindingLabel(bindingId);
  const summary =
    allowedDomains.size === 0
      ? `${name} asks before using protected parts of your workspace. It can never change your safety controls.`
      : `${name} has saved access to ${[...allowedDomains]
          .map((domain) => AUTHORITY_DOMAINS[domain].label.toLowerCase())
          .join(", ")}. It can never change your safety controls.`;
  return { bindingId, name, summary, cells };
}

function agentBindingLabel(bindingId: string): string {
  const entity = bindingId.split("@", 1)[0] ?? bindingId;
  const tail = entity.split(":").at(-1) ?? entity;
  return tail.replace(/[-_]+/g, " ").replace(/\b\w/g, (value) => value.toUpperCase());
}

function savedAuthorityGrant(grant: AuthorityGrant): SavedPermissionGrant {
  if (!grant.id) throw new Error("Persisted authority grant has no id");
  const code = codeSubject(grant.subject);
  const sessionScoped = Boolean(grant.constraints?.sessionId);
  return {
    id: grant.id,
    kind: "capability",
    callerLabel: authoritySubjectLabel(grant.subject),
    scopeLabel:
      grant.effect === "deny"
        ? sessionScoped
          ? "Blocked for this session"
          : "Blocked for this code version"
        : sessionScoped
          ? "Allowed for this session"
          : "Trusted for this code version",
    capability: describeCapability(grant.capability).title,
    resource: authorityResourceLabel(grant.resource),
    ...(code ? { repoPath: code.repoPath, effectiveVersion: code.executionDigest } : {}),
    grantedAt: grant.createdAt,
  };
}

function codeSubject(
  subject: AuthorityGrantSubject
): { repoPath: string; executionDigest: string } | null {
  if (!subject.startsWith("code:")) return null;
  const code = subject.slice("code:".length);
  const separator = code.lastIndexOf("@");
  if (separator <= 0 || separator === code.length - 1) return null;
  return { repoPath: code.slice(0, separator), executionDigest: code.slice(separator + 1) };
}

function authoritySubjectLabel(subject: AuthorityGrantSubject): string {
  const code = codeSubject(subject);
  if (code) return code.repoPath;
  if (subject.startsWith("session:")) return "This session";
  if (subject.startsWith("mission:")) return "This agent mission";
  if (subject.startsWith("agent:")) return "This agent";
  if (subject.startsWith("user:")) return "Your account";
  return "Vibestudio";
}

function authorityResourceLabel(resource: ResourceScope): string {
  switch (resource.kind) {
    case "exact":
      return resource.key;
    case "prefix":
      return resource.prefix ? `Anything under ${resource.prefix}` : "Any matching resource";
    case "origin":
      return resource.origin;
    case "domain":
      return resource.domain;
    case "network":
      return "All network destinations";
  }
}
