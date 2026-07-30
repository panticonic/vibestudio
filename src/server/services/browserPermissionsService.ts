import { createHash } from "node:crypto";
import type { AuthorityGrant } from "@vibestudio/rpc";
import type { BrowserSitePermissionCapability } from "@vibestudio/shared/approvals";
import type { EventService } from "@vibestudio/shared/eventsService";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { browserPermissionsMethods } from "@vibestudio/service-schemas/browserPermissions";
import { browserEnvironmentIdentityFromContext } from "../browserEnvironmentIdentity.js";
import type { ApprovalQueue, BrowserPermissionApprovalDecision } from "./approvalQueue.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";

export type BrowserPermissionCapability = BrowserSitePermissionCapability;
export type BrowserPermissionGrant = {
  origin: string;
  capability: BrowserPermissionCapability;
  decision: "allow" | "block";
  scope: "session" | "always" | "block";
  updatedAt: number;
};

const CAPABILITY_PREFIX = "browser.";
const RESOURCE_PREFIX = "browser-origin:v1:";
const PERSISTENT_EPOCH = "persistent";

type ParsedBrowserGrant = BrowserPermissionGrant & {
  environmentKey: string;
  ownerUserId: string;
  sessionEpoch: string | null;
  authorityGrantId: string;
};

/**
 * Browser permission view over the canonical authority store. The adapter owns
 * only browser-specific resource encoding and projection; it does not persist
 * a second source of authority.
 */
export class BrowserPermissionGrantProjection {
  constructor(private readonly grants: CapabilityGrantStore) {}

  list(
    environmentKey: string,
    ownerUserId: string,
    sessionEpoch?: string
  ): BrowserPermissionGrant[] {
    const selected = new Map<string, ParsedBrowserGrant>();
    for (const grant of this.parsedActiveGrants()) {
      if (
        grant.environmentKey !== environmentKey ||
        grant.ownerUserId !== ownerUserId ||
        (grant.sessionEpoch !== null &&
          sessionEpoch !== undefined &&
          grant.sessionEpoch !== sessionEpoch)
      ) {
        continue;
      }
      const compound = `${grant.origin}\0${grant.capability}`;
      const prior = selected.get(compound);
      if (!prior || grant.decision === "block") selected.set(compound, grant);
    }
    return [...selected.values()].map(({ origin, capability, decision, scope, updatedAt }) => ({
      origin,
      capability,
      decision,
      scope,
      updatedAt,
    }));
  }

  get(
    environmentKey: string,
    ownerUserId: string,
    sessionEpoch: string,
    origin: string,
    capability: BrowserPermissionCapability
  ): BrowserPermissionGrant | undefined {
    return this.list(environmentKey, ownerUserId, sessionEpoch).find(
      (grant) => grant.origin === origin && grant.capability === capability
    );
  }

  remember(
    environmentKey: string,
    ownerUserId: string,
    sessionEpoch: string,
    grants: BrowserPermissionGrant[]
  ): void {
    const subject = userSubject(ownerUserId);
    for (const grant of grants) {
      this.revokeMatching(
        (candidate) =>
          candidate.environmentKey === environmentKey &&
          candidate.ownerUserId === ownerUserId &&
          candidate.origin === grant.origin &&
          candidate.capability === grant.capability
      );
      const epoch = grant.scope === "session" ? sessionEpoch : PERSISTENT_EPOCH;
      this.grants.issue({
        effect: grant.decision === "block" ? "deny" : "allow",
        capability: `${CAPABILITY_PREFIX}${grant.capability}`,
        resource: {
          kind: "exact",
          key: browserPermissionResourceKey(environmentKey, epoch, grant.origin),
        },
        subject,
        constraints: { lineageAtConsent: [] },
        issuedBy: subject,
        provenance: "acquisition",
        createdAt: grant.updatedAt,
        scope: "system",
        decidedBy: subject,
        decisionSurface: "browser-permission",
      });
    }
  }

  revoke(
    environmentKey: string,
    ownerUserId: string,
    origin: string,
    capability?: BrowserPermissionCapability
  ): number {
    return this.revokeMatching(
      (grant) =>
        grant.environmentKey === environmentKey &&
        grant.ownerUserId === ownerUserId &&
        grant.origin === origin &&
        (!capability || grant.capability === capability)
    );
  }

  cleanupPreviousSessions(
    environmentKey: string,
    ownerUserId: string,
    currentEpoch: string
  ): number {
    return this.revokeMatching(
      (grant) =>
        grant.environmentKey === environmentKey &&
        grant.ownerUserId === ownerUserId &&
        grant.sessionEpoch !== null &&
        grant.sessionEpoch !== currentEpoch
    );
  }

  idFor(environmentKey: string, ownerUserId: string, grant: BrowserPermissionGrant): string {
    return createHash("sha256")
      .update(`${environmentKey}\0${ownerUserId}\0${grant.origin}`)
      .digest("base64url");
  }

  revokeById(environmentKey: string, ownerUserId: string, id: string): boolean {
    const grant = this.list(environmentKey, ownerUserId).find(
      (candidate) => this.idFor(environmentKey, ownerUserId, candidate) === id
    );
    return grant ? this.revoke(environmentKey, ownerUserId, grant.origin) > 0 : false;
  }

  private parsedActiveGrants(): ParsedBrowserGrant[] {
    return this.grants
      .listActiveAuthorityGrants()
      .flatMap((grant) => parseBrowserGrant(grant) ?? []);
  }

  private revokeMatching(predicate: (grant: ParsedBrowserGrant) => boolean): number {
    let count = 0;
    for (const grant of this.parsedActiveGrants()) {
      if (predicate(grant) && this.grants.revoke(grant.authorityGrantId)) count += 1;
    }
    return count;
  }
}

export function createBrowserPermissionsService(deps: {
  approvalQueue: ApprovalQueue;
  workspaceId: string;
  grantStore: BrowserPermissionGrantProjection;
  eventService: Pick<EventService, "emitToUser">;
}): ServiceDefinition {
  const publish = (
    environmentKey: string,
    ownerUserId: string,
    sessionEpoch: string
  ): BrowserPermissionGrant[] => {
    const grants = deps.grantStore.list(environmentKey, ownerUserId, sessionEpoch);
    deps.eventService.emitToUser(ownerUserId, "browser-permissions:changed", {
      environmentKey,
      grants,
    });
    return grants;
  };

  return {
    name: "browserPermissions",
    description: "Owner-scoped browser website permission grants",
    authority: { principals: ["user"] },
    methods: browserPermissionsMethods,
    handler: defineServiceHandler("browserPermissions", browserPermissionsMethods, {
      snapshot: async (ctx, [{ sessionEpoch }]) => {
        const identity = browserEnvironmentIdentityFromContext(deps.workspaceId, ctx);
        deps.grantStore.cleanupPreviousSessions(
          identity.environmentKey,
          identity.ownerUserId,
          sessionEpoch
        );
        return {
          environmentKey: identity.environmentKey,
          grants: deps.grantStore.list(identity.environmentKey, identity.ownerUserId, sessionEpoch),
        };
      },
      request: async (ctx, [request]) => {
        const identity = browserEnvironmentIdentityFromContext(deps.workspaceId, ctx);
        const origin = normalizeWebOrigin(request.origin);
        const topLevelUrl = new URL(request.topLevelUrl);
        if (topLevelUrl.origin !== origin) {
          throw new Error("Browser permission requesting and top-level origins do not match");
        }
        const capabilities = [...new Set(request.capabilities)];
        const existing = capabilities.map((capability) =>
          deps.grantStore.get(
            identity.environmentKey,
            identity.ownerUserId,
            request.sessionEpoch,
            origin,
            capability
          )
        );
        if (existing.some((grant) => grant?.decision === "block")) {
          return {
            decision: "block" as const,
            granted: false,
            grants: deps.grantStore.list(
              identity.environmentKey,
              identity.ownerUserId,
              request.sessionEpoch
            ),
          };
        }
        if (existing.every((grant) => grant?.decision === "allow")) {
          return {
            decision: "session" as const,
            granted: true,
            grants: deps.grantStore.list(
              identity.environmentKey,
              identity.ownerUserId,
              request.sessionEpoch
            ),
          };
        }
        const requestDecision = deps.approvalQueue.requestBrowserPermission;
        if (!requestDecision) throw new Error("Browser permission approvals are unavailable");
        const decision = await requestDecision({
          kind: "browser-permission",
          callerId: `browser:${request.panelId}`,
          callerKind: "system",
          repoPath: "",
          effectiveVersion: "browser-site",
          requestedByUserId: identity.ownerUserId,
          ownerUserId: identity.ownerUserId,
          workspaceId: identity.workspaceId,
          environmentKey: identity.environmentKey,
          panelId: request.panelId,
          origin,
          topLevelUrl: topLevelUrl.toString(),
          capabilities,
          deviceLabel: request.deviceLabel,
          signal: ctx.signal,
        });
        const granted = decision === "once" || decision === "session" || decision === "always";
        if (decision === "session" || decision === "always" || decision === "block") {
          deps.grantStore.remember(
            identity.environmentKey,
            identity.ownerUserId,
            request.sessionEpoch,
            capabilities.map((capability) => ({
              origin,
              capability,
              decision: decision === "block" ? "block" : "allow",
              scope: decision,
              updatedAt: Date.now(),
            }))
          );
        }
        return {
          decision: decision satisfies BrowserPermissionApprovalDecision,
          granted,
          grants: publish(identity.environmentKey, identity.ownerUserId, request.sessionEpoch),
        };
      },
      revoke: async (ctx, [request]) => {
        const identity = browserEnvironmentIdentityFromContext(deps.workspaceId, ctx);
        const origin = normalizeWebOrigin(request.origin);
        const removed = deps.grantStore.revoke(
          identity.environmentKey,
          identity.ownerUserId,
          origin,
          request.capability
        );
        publish(identity.environmentKey, identity.ownerUserId, request.sessionEpoch);
        return removed;
      },
    }),
  };
}

function browserPermissionResourceKey(
  environmentKey: string,
  epoch: string,
  origin: string
): string {
  return `${RESOURCE_PREFIX}${encode(environmentKey)}:${encode(epoch)}:${encode(origin)}`;
}

function parseBrowserGrant(grant: AuthorityGrant): ParsedBrowserGrant | null {
  if (
    !grant.id ||
    !grant.subject.startsWith("user:") ||
    !grant.capability.startsWith(CAPABILITY_PREFIX) ||
    grant.resource.kind !== "exact" ||
    !grant.resource.key.startsWith(RESOURCE_PREFIX)
  ) {
    return null;
  }
  const capability = grant.capability.slice(CAPABILITY_PREFIX.length);
  if (!isCapability(capability)) return null;
  const encoded = grant.resource.key.slice(RESOURCE_PREFIX.length).split(":");
  if (encoded.length !== 3) return null;
  try {
    const [environmentKey, epoch, origin] = encoded.map(decode) as [string, string, string];
    return {
      environmentKey,
      ownerUserId: grant.subject.slice("user:".length),
      sessionEpoch: epoch === PERSISTENT_EPOCH ? null : epoch,
      authorityGrantId: grant.id,
      origin: normalizeWebOrigin(origin),
      capability,
      decision: grant.effect === "deny" ? "block" : "allow",
      scope: grant.effect === "deny" ? "block" : epoch === PERSISTENT_EPOCH ? "always" : "session",
      updatedAt: grant.createdAt,
    };
  } catch {
    return null;
  }
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function userSubject(ownerUserId: string): `user:${string}` {
  return `user:${ownerUserId}`;
}

function normalizeWebOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Browser permissions require an HTTP(S) origin");
  }
  if (url.username || url.password) throw new Error("Browser permission origin is invalid");
  return url.origin;
}

function isCapability(value: unknown): value is BrowserPermissionCapability {
  return [
    "camera",
    "microphone",
    "geolocation",
    "notifications",
    "downloads",
    "clipboard",
    "autofill",
    "popups",
  ].includes(String(value));
}
