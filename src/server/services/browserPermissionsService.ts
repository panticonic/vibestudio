import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { browserPermissionsMethods } from "@vibestudio/service-schemas/browserPermissions";
import { browserEnvironmentIdentityFromContext } from "../browserEnvironmentIdentity.js";
import type { ApprovalQueue, BrowserPermissionApprovalDecision } from "./approvalQueue.js";

export type BrowserPermissionCapability = "camera" | "microphone" | "geolocation" | "notifications";
export type BrowserPermissionGrant = {
  origin: string;
  capability: BrowserPermissionCapability;
  decision: "allow" | "block";
  scope: "session" | "always" | "block";
  updatedAt: number;
};

export class BrowserPermissionGrantStore {
  private readonly durable = new Map<string, BrowserPermissionGrant>();
  private readonly session = new Map<string, BrowserPermissionGrant>();
  private readonly filePath: string;
  private loaded: Promise<void> | null = null;
  private persist: Promise<void> = Promise.resolve();

  constructor(statePath: string) {
    this.filePath = path.join(statePath, "browser-permission-grants.json");
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return this.loaded;
    this.loaded = (async () => {
      try {
        const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8")) as {
          version?: unknown;
          grants?: Array<
            BrowserPermissionGrant & { environmentKey?: string; ownerUserId?: string }
          >;
        };
        if (parsed.version !== 1 || !Array.isArray(parsed.grants)) return;
        for (const grant of parsed.grants) {
          if (
            typeof grant.environmentKey !== "string" ||
            typeof grant.ownerUserId !== "string" ||
            !isCapability(grant.capability) ||
            (grant.decision !== "allow" && grant.decision !== "block") ||
            (grant.scope !== "always" && grant.scope !== "block")
          )
            continue;
          try {
            const origin = normalizeWebOrigin(grant.origin);
            this.durable.set(
              key(grant.environmentKey, grant.ownerUserId, origin, grant.capability),
              { ...grant, origin }
            );
          } catch {
            // Ignore malformed persisted grants; permission state fails closed.
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    })();
    return this.loaded;
  }

  list(environmentKey: string, ownerUserId: string): BrowserPermissionGrant[] {
    const prefix = `${environmentKey}\0${ownerUserId}\0`;
    const merged = new Map<string, BrowserPermissionGrant>();
    for (const target of [this.durable, this.session]) {
      for (const [compound, grant] of target) {
        if (compound.startsWith(prefix)) merged.set(compound, { ...grant });
      }
    }
    return [...merged.values()];
  }

  get(
    environmentKey: string,
    ownerUserId: string,
    origin: string,
    capability: BrowserPermissionCapability
  ): BrowserPermissionGrant | undefined {
    const compound = key(environmentKey, ownerUserId, origin, capability);
    return this.session.get(compound) ?? this.durable.get(compound);
  }

  async remember(
    environmentKey: string,
    ownerUserId: string,
    grants: BrowserPermissionGrant[]
  ): Promise<void> {
    for (const grant of grants) {
      const target = grant.scope === "session" ? this.session : this.durable;
      target.set(key(environmentKey, ownerUserId, grant.origin, grant.capability), grant);
    }
    if (grants.some((grant) => grant.scope !== "session")) await this.save();
  }

  async revoke(
    environmentKey: string,
    ownerUserId: string,
    origin: string,
    capability?: BrowserPermissionCapability
  ): Promise<number> {
    let count = 0;
    for (const target of [this.session, this.durable]) {
      for (const [compound, grant] of target) {
        if (
          compound.startsWith(`${environmentKey}\0${ownerUserId}\0`) &&
          grant.origin === origin &&
          (!capability || grant.capability === capability)
        ) {
          target.delete(compound);
          count += 1;
        }
      }
    }
    await this.save();
    return count;
  }

  idFor(environmentKey: string, ownerUserId: string, grant: BrowserPermissionGrant): string {
    return createHash("sha256")
      .update(key(environmentKey, ownerUserId, grant.origin, grant.capability))
      .digest("base64url");
  }

  async revokeById(environmentKey: string, ownerUserId: string, id: string): Promise<boolean> {
    for (const grant of this.list(environmentKey, ownerUserId)) {
      if (this.idFor(environmentKey, ownerUserId, grant) === id) {
        await this.revoke(environmentKey, ownerUserId, grant.origin, grant.capability);
        return true;
      }
    }
    return false;
  }

  private durableEntries(): Array<
    BrowserPermissionGrant & { environmentKey: string; ownerUserId: string }
  > {
    return [...this.durable.entries()].map(([compound, grant]) => {
      const [environmentKey, ownerUserId] = compound.split("\0", 2) as [string, string];
      return { ...grant, environmentKey, ownerUserId };
    });
  }

  private save(): Promise<void> {
    const write = async () => {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify({ version: 1, grants: this.durableEntries() }), {
        mode: 0o600,
      });
      await fs.rename(temporary, this.filePath);
    };
    this.persist = this.persist.then(write, write);
    return this.persist;
  }
}

export function createBrowserPermissionsService(deps: {
  approvalQueue: ApprovalQueue;
  workspaceId: string;
  grantStore: BrowserPermissionGrantStore;
}): ServiceDefinition {
  return {
    name: "browserPermissions",
    description: "Owner-scoped browser website permission grants",
    authority: { principals: ["host"] },
    methods: browserPermissionsMethods,
    handler: defineServiceHandler("browserPermissions", browserPermissionsMethods, {
      snapshot: async (ctx) => {
        await deps.grantStore.ensureLoaded();
        const identity = browserEnvironmentIdentityFromContext(deps.workspaceId, ctx);
        return {
          environmentKey: identity.environmentKey,
          grants: deps.grantStore.list(identity.environmentKey, identity.ownerUserId),
        };
      },
      request: async (ctx, [request]) => {
        await deps.grantStore.ensureLoaded();
        const identity = browserEnvironmentIdentityFromContext(deps.workspaceId, ctx);
        const origin = normalizeWebOrigin(request.origin);
        const topLevelUrl = new URL(request.topLevelUrl);
        if (topLevelUrl.origin !== origin) {
          throw new Error("Browser permission requesting and top-level origins do not match");
        }
        const capabilities = [...new Set(request.capabilities)];
        const existing = capabilities.map((capability) =>
          deps.grantStore.get(identity.environmentKey, identity.ownerUserId, origin, capability)
        );
        if (existing.some((grant) => grant?.decision === "block")) {
          return {
            decision: "block" as const,
            granted: false,
            grants: deps.grantStore.list(identity.environmentKey, identity.ownerUserId),
          };
        }
        if (existing.every((grant) => grant?.decision === "allow")) {
          return {
            decision: "session" as const,
            granted: true,
            grants: deps.grantStore.list(identity.environmentKey, identity.ownerUserId),
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
          await deps.grantStore.remember(
            identity.environmentKey,
            identity.ownerUserId,
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
          grants: deps.grantStore.list(identity.environmentKey, identity.ownerUserId),
        };
      },
      revoke: async (ctx, [request]) => {
        await deps.grantStore.ensureLoaded();
        const identity = browserEnvironmentIdentityFromContext(deps.workspaceId, ctx);
        const origin = normalizeWebOrigin(request.origin);
        return deps.grantStore.revoke(
          identity.environmentKey,
          identity.ownerUserId,
          origin,
          request.capability
        );
      },
    }),
  };
}

function key(
  environmentKey: string,
  ownerUserId: string,
  origin: string,
  capability: BrowserPermissionCapability
) {
  return `${environmentKey}\0${ownerUserId}\0${origin}\0${capability}`;
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
  return ["camera", "microphone", "geolocation", "notifications"].includes(String(value));
}
