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
} from "@vibestudio/shared/authority/authorityDomains";
import { resourcePhrase } from "@vibestudio/shared/authority/authorityRows";
import { parseCodePrincipal, type CodeIdentity } from "@vibestudio/shared/authority/codePrincipal";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { RUNTIME_RESOURCE_BINDING_SURFACE } from "./runtimeResourceBindings.js";
import {
  credentialUseGrantId,
  type CredentialUseGrantStoreLike,
} from "./credentialUseGrantStore.js";
import { browserEnvironmentIdentityFromContext } from "../browserEnvironmentIdentity.js";
import type { BrowserPermissionGrantProjection } from "./browserPermissionsService.js";

const SERVICE = "permissions";

export function createPermissionsService(deps: {
  capabilityGrants: CapabilityGrantStore;
  credentialUseGrants: CredentialUseGrantStoreLike;
  browserPermissions: BrowserPermissionGrantProjection;
  workspaceId: string;
  /**
   * Which decision admitted a code grant's part, for §7.7's origin line.
   * Absent in tests that never assert on provenance; every row then falls back
   * to the general "came with the part" wording rather than inventing a source.
   */
  admissionProvenance?: UnitAdmissionProvenanceLookup;
  pendingAcquisitionCount?: () => number;
  activeAgentBindingCount?: () => number;
  activeAgentBindings?: () => readonly string[];
  interruptAgent?: (bindingId: string, reason: string) => Promise<void>;
  resumeAgent?: (bindingId: string) => Promise<void>;
  interruptAllAgents?: (reason: string) => Promise<void>;
  closeAgentAcquisitions?: (bindingId: string) => number;
  closeAllAcquisitions?: () => number;
}): ServiceDefinition {
  const safetyStatus = () => ({
    workspaceLocked: deps.capabilityGrants.workspaceAuthorityLocked(),
    activeAgentCount: deps.activeAgentBindingCount?.() ?? 0,
    pendingAcquisitionCount: deps.pendingAcquisitionCount?.() ?? 0,
  });
  return {
    name: SERVICE,
    description: "Trusted review and revocation of durable permission grants",
    authority: { principals: ["user", "host", "code"] },
    methods: permissionsMethods,
    handler: defineServiceHandler(SERVICE, permissionsMethods, {
      list: async (ctx) => {
        const identity = browserEnvironmentIdentityFromContext(deps.workspaceId, ctx);
        const reviewingUserId = ctx.caller.subject?.userId;
        const capability: SavedPermissionGrant[] = deps.capabilityGrants
          .listActiveAuthorityGrants()
          .map((grant) => savedAuthorityGrant(grant, reviewingUserId, deps.admissionProvenance));
        const credentialUse: SavedPermissionGrant[] = deps.credentialUseGrants
          .listAll()
          .map((grant) => ({
            id: credentialUseGrantId(grant),
            kind: "credential-use",
            callerLabel: grant.scope === "agent" ? grant.agentId : grant.repoPath,
            scopeLabel:
              grant.scope === "agent" ? "Remembered for this agent" : "Remembered for this version",
            capability: `Credential ${grant.use}: ${grant.action}`,
            resource: grant.resource,
            ...(grant.scope === "version"
              ? { repoPath: grant.repoPath, effectiveVersion: grant.effectiveVersion }
              : {}),
            grantedAt: grant.grantedAt,
            why: `Lets this ${grant.scope === "agent" ? "agent" : "installed code version"} use the selected account for ${grant.action} access.`,
            approvedBy: humanizeDecisionPrincipal(grant.grantedBy, reviewingUserId),
            duration:
              grant.scope === "agent"
                ? "Until you revoke it, or the agent is retired"
                : "Until this exact installed version changes or you revoke it",
            revokeEffect:
              "Future account use will ask again; an active request from this agent is stopped.",
          }));
        const siteGrants = new Map<string, ReturnType<BrowserPermissionGrantProjection["list"]>>();
        for (const grant of deps.browserPermissions.list(
          identity.environmentKey,
          identity.ownerUserId
        )) {
          const grants = siteGrants.get(grant.origin);
          if (grants) grants.push(grant);
          else siteGrants.set(grant.origin, [grant]);
        }
        const browserSites: SavedPermissionGrant[] = [...siteGrants.entries()].map(
          ([origin, grants]) => {
            const representative = grants[0];
            if (!representative) throw new Error(`Browser site grant set is empty: ${origin}`);
            const blocked = grants.filter((grant) => grant.decision === "block");
            const allowed = grants.filter((grant) => grant.decision === "allow");
            const labels = [
              ...(allowed.length > 0
                ? [
                    `allows ${allowed
                      .map((grant) => grant.capability)
                      .sort()
                      .join(", ")}`,
                  ]
                : []),
              ...(blocked.length > 0
                ? [
                    `blocks ${blocked
                      .map((grant) => grant.capability)
                      .sort()
                      .join(", ")}`,
                  ]
                : []),
            ];
            const hasSessionGrant = grants.some((grant) => grant.scope === "session");
            return {
              id: deps.browserPermissions.idFor(
                identity.environmentKey,
                identity.ownerUserId,
                representative
              ),
              kind: "browser-site",
              callerLabel: origin,
              scopeLabel: labels.join("; "),
              capability: "Website capabilities",
              resource: origin,
              grantedAt: Math.max(...grants.map((grant) => grant.updatedAt)),
              why: "Records which browser features this website may use.",
              approvedBy: "You",
              duration: hasSessionGrant
                ? "Session choices end with this browser session; durable choices last until revoked"
                : "Until you revoke it",
              revokeEffect:
                "Every saved decision for this website is removed, so each feature must ask again.",
            };
          }
        );
        return [...capability, ...credentialUse, ...browserSites].sort(
          (a, b) => (b.grantedAt ?? 0) - (a.grantedAt ?? 0)
        );
      },
      revoke: async (ctx, [{ kind, id }]) => {
        if (kind === "browser-site") {
          const identity = browserEnvironmentIdentityFromContext(deps.workspaceId, ctx);
          const removed = deps.browserPermissions.revokeById(
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
            : await deps.credentialUseGrants.revoke(id);
        if (!removed)
          throw new ServiceError(SERVICE, "revoke", "Permission grant not found", "ENOENT");
      },
      listAgentProfiles: async (ctx) => {
        deps.capabilityGrants.suspendIdleAgentGrants();
        return agentProfiles(
          deps.capabilityGrants,
          deps.activeAgentBindings?.() ?? [],
          ctx.caller.subject?.userId
        );
      },
      safetyStatus: async () => safetyStatus(),
      updateAgentProfile: async (ctx, [request]) => {
        let changed = false;
        const decidedBy = ctx.caller.subject ? `user:${ctx.caller.subject.userId}` : "user:system";
        if (request.action === "revoke-grant") {
          changed = deps.capabilityGrants.revoke(request.id);
        } else if (request.action === "restore-grant") {
          changed = deps.capabilityGrants.restore(request.id);
        } else if (request.action === "unlock") {
          changed = deps.capabilityGrants.revokeLock(request.id);
        } else if (request.action === "pause-agent") {
          deps.capabilityGrants.setAgentPaused(request.bindingId, true, decidedBy);
          deps.closeAgentAcquisitions?.(request.bindingId);
          await deps.interruptAgent?.(request.bindingId, "The user paused this agent.");
          changed = true;
        } else if (request.action === "resume-agent") {
          deps.capabilityGrants.setAgentPaused(request.bindingId, false, decidedBy);
          await deps.resumeAgent?.(request.bindingId);
          changed = true;
        } else {
          deps.capabilityGrants.resetAgentAuthority(request.bindingId, {
            keepLocks: true,
          });
          await deps.credentialUseGrants.revokeForAgent(request.bindingId);
          deps.closeAgentAcquisitions?.(request.bindingId);
          await deps.interruptAgent?.(
            request.bindingId,
            "The user revoked all authority for this agent."
          );
          changed = true;
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
      setWorkspaceAuthorityLock: async (ctx, [{ locked }]) => {
        const decidedBy = ctx.caller.subject ? `user:${ctx.caller.subject.userId}` : "user:system";
        deps.capabilityGrants.setWorkspaceAuthorityLocked(locked, decidedBy);
        if (locked) {
          deps.closeAllAcquisitions?.();
          await deps.interruptAllAgents?.(
            "The user engaged the emergency workspace authority lock."
          );
        }
        return safetyStatus();
      },
    }),
  };
}

type AgentAuthorityProfile =
  import("@vibestudio/service-schemas/permissions").AgentAuthorityProfile;

function agentProfiles(
  store: CapabilityGrantStore,
  activeBindingIds: readonly string[],
  reviewingUserId?: string
): AgentAuthorityProfile[] {
  const grants = store.listAgentAuthorityGrants();
  const locks = store.listLocks().filter((lock) => lock.revokedAt === undefined);
  const bindingIds = new Set<string>();
  for (const bindingId of activeBindingIds) bindingIds.add(bindingId);
  for (const grant of grants) bindingIds.add(grant.subject.slice("agent:".length));
  for (const lock of locks) {
    if (lock.agentBindingId !== "*") bindingIds.add(lock.agentBindingId);
  }
  return [...bindingIds]
    .sort()
    .map((bindingId) => agentProfile(bindingId, grants, locks, reviewingUserId));
}

function agentProfile(
  bindingId: string,
  allGrants: readonly AuthorityGrant[],
  allLocks: readonly import("@vibestudio/rpc").AuthorityLock[],
  reviewingUserId?: string
): AgentAuthorityProfile {
  const grants = allGrants.filter((grant) => grant.subject === `agent:${bindingId}`);
  const locks = allLocks.filter((lock) => lock.agentBindingId === bindingId);
  const paused = locks.some((lock) => lock.level === "agent");
  const cells: AgentAuthorityProfile["cells"] = [];
  for (const domain of Object.keys(AUTHORITY_DOMAINS) as AuthorityDomainId[]) {
    for (const verb of Object.keys(AUTHORITY_VERBS) as AuthorityVerb[]) {
      const cellGrants = grants.filter((grant) => {
        const category = capabilityDomain(grant.capability);
        return category?.domain === domain && category.verb === verb;
      });
      const cellLocks = locks.filter((lock) => {
        if (lock.level === "agent" || lock.level === "workspace") return false;
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
            why: "You chose lasting access after this agent requested the action.",
            approvedBy: humanizeDecisionPrincipal(
              grant.decidedBy ?? grant.issuedBy,
              reviewingUserId
            ),
            duration: "Until you revoke it, or after 3 months without use",
            revokeEffect:
              "The next matching action asks again, and active protected work is stopped.",
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
          why: "You chose “Never” for this action or permission area.",
          approvedBy: humanizeDecisionPrincipal(lock.decidedBy, reviewingUserId),
          duration: "Until you unlock it",
          revokeEffect: "The agent may ask for this action again.",
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
  return { bindingId, name, summary, paused, cells };
}

function agentBindingLabel(bindingId: string): string {
  const entity = bindingId.split("@", 1)[0] ?? bindingId;
  const tail = entity.split(":").at(-1) ?? entity;
  return tail.replace(/[-_]+/g, " ").replace(/\b\w/g, (value) => value.toUpperCase());
}

function savedAuthorityGrant(
  grant: AuthorityGrant,
  reviewingUserId?: string,
  admissionProvenance?: UnitAdmissionProvenanceLookup
): SavedPermissionGrant {
  if (!grant.id) throw new Error("Persisted authority grant has no id");
  const code = codeSubject(grant.subject);
  const origin = authorityGrantOrigin(grant, code, admissionProvenance);
  const sessionScoped = Boolean(grant.constraints?.sessionId);
  return {
    id: grant.id,
    kind: "capability",
    callerLabel: authoritySubjectLabel(grant.subject),
    scopeLabel:
      grant.effect === "deny"
        ? sessionScoped
          ? "Blocked until you close Vibestudio"
          : "Blocked for this version"
        : sessionScoped
          ? "Allowed until you close Vibestudio"
          : "Remembered for this version",
    capability: describeCapability(grant.capability).title,
    resource: authorityResourceLabel(grant.resource),
    ...(code ? { repoPath: code.repoPath, effectiveVersion: code.effectiveVersion } : {}),
    grantedAt: grant.createdAt,
    ...(grant.lastUsedAt ? { lastUsedAt: grant.lastUsedAt } : {}),
    ...(grant.expiresAt ? { expiresAt: grant.expiresAt } : {}),
    why: authorityGrantReason(grant),
    ...(origin ? { origin } : {}),
    approvedBy: humanizeDecisionPrincipal(grant.decidedBy ?? grant.issuedBy, reviewingUserId),
    duration: authorityGrantDuration(grant),
    revokeEffect:
      grant.scope === "agent"
        ? "The next matching action asks again, and this agent's active protected work is stopped."
        : "The next matching action asks again; work using this permission can no longer continue.",
  };
}

/** What the admission store can tell Permissions about a code grant's part. */
export type UnitAdmissionProvenanceLookup = (
  repoPath: string,
  effectiveVersion: string
) => {
  origin: string;
  sourceUrl: string | null;
  sourceSelfName?: string | null;
  sourceVersion?: string | null;
} | null;

/**
 * §7.7's origin line: which decision this permission arrived with.
 *
 * This is the half that makes Permissions the place an install-time choice is
 * revisited *in both directions*. `why` says what the permission does; it says
 * nothing about whether the person picked it or a part came holding it, and
 * without that a row minted by a review reads exactly like one they answered a
 * prompt for.
 */
function authorityGrantOrigin(
  grant: AuthorityGrant,
  code: { repoPath: string; effectiveVersion: string } | null,
  lookup?: UnitAdmissionProvenanceLookup
): string | undefined {
  if (grant.effect === "deny") return "You chose not to allow this";
  // The Quickfire agent's grants are not answers to a prompt — for an ordinary panel
  // nothing was ever asked. Naming the surface is the only honest origin: the
  // person opened the overlay over a panel, and that gesture is what this row
  // records. Revoking it here shuts the debug tools off immediately.
  if (grant.decisionSurface?.startsWith(`${RUNTIME_RESOURCE_BINDING_SURFACE}:`)) {
    return "When you attached an agent to a workspace resource";
  }
  if (grant.provenance !== "install") return "You allowed this when it was needed";
  const provenance = code ? lookup?.(code.repoPath, code.effectiveVersion) : null;
  // The template's own name when the admission recorded one — `Added with News
  // 1.2.0` names the thing the person actually added, which no description of
  // our own machinery can. The name is self-asserted and appears only here,
  // attributed to the template, never in a position that reads as a verified
  // publisher (§7.6.3).
  const template = provenance?.sourceSelfName
    ? `${provenance.sourceSelfName}${provenance.sourceVersion ? ` ${provenance.sourceVersion}` : ""}`
    : null;
  switch (provenance?.origin) {
    case "host-build":
    case "chrome":
      return "Part of Vibestudio";
    case "workspace-creation":
      return template ? `Added with ${template}` : "Added with your workspace's base";
    case "template-install":
      return template ? `Added with ${template}` : "Added with a template";
    case "launch-gate":
      return "Allowed when you started this workspace";
    default:
      // `publication`, and any record written before the source fields existed.
      // Both mean the same thing to a reader: it came with the part rather than
      // from a prompt — and naming a specific source we do not hold would be
      // worse than naming the general one we do.
      return template ? `Added with ${template}` : "Added when this part arrived";
  }
}

function authorityGrantReason(grant: AuthorityGrant): string {
  if (grant.effect === "deny") return "Remembers a decision not to allow this action.";
  if (grant.decisionSurface?.startsWith(`${RUNTIME_RESOURCE_BINDING_SURFACE}:`)) {
    return "Lets one agent conversation use the workspace resource you attached to it.";
  }
  if (grant.provenance === "install") {
    return "Provides the access declared and reviewed for this exact installed code version.";
  }
  if (grant.provenance === "preauthorization") {
    return "Allows one action covered by the task you approved.";
  }
  return "Allows the protected action you reviewed when it was requested.";
}

function authorityGrantDuration(grant: AuthorityGrant): string {
  if (grant.expiresAt) return "Until the shown expiry time or until you revoke it";
  switch (grant.scope) {
    case "once":
      return "For one matching action";
    case "task":
      return "For the current approved task";
    case "session":
      return "Until this session ends or you revoke it";
    case "agent":
      return "Until you revoke it, or after 3 months without use";
    case "mission":
      return "Until the reviewed automation changes, ends, or you revoke it";
    case "version":
      return "Until this exact installed version changes or you revoke it";
    default:
      return "Until you revoke it";
  }
}

function humanizeDecisionPrincipal(principal: string, reviewingUserId?: string): string {
  const userId = principal.startsWith("user:") ? principal.slice("user:".length) : principal;
  if (reviewingUserId && userId === reviewingUserId) return "You";
  if (principal.startsWith("user:")) return "Another workspace member";
  if (principal.startsWith("host:")) return "Vibestudio for an approved task";
  return principal || "A workspace member";
}

function codeSubject(subject: AuthorityGrantSubject): CodeIdentity | null {
  return parseCodePrincipal(subject);
}

function authoritySubjectLabel(subject: AuthorityGrantSubject): string {
  const code = codeSubject(subject);
  if (code) return code.repoPath;
  if (subject.startsWith("session:")) return "This session";
  if (subject.startsWith("task:")) return "This task";
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
