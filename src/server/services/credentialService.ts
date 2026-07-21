import { randomUUID } from "node:crypto";
import type { EventService } from "@vibestudio/shared/eventsService";
import type { ServiceRouteDecl } from "../routeRegistry.js";
import type { AuditLog } from "@vibestudio/credential-client/audit";
import {
  ClientConfigStore,
  type ClientConfigRecord,
} from "@vibestudio/credential-client/clientConfigStore";
import { CredentialStore } from "@vibestudio/credential-client/store";
import { credentialLifecycle } from "@vibestudio/credential-client/credentialStatus";
import type {
  AccountIdentity,
  AuditEntry,
  ClientConfigStatus,
  Credential,
  CredentialAuditEvent,
  CredentialBinding,
  CredentialBindingUse,
  CredentialGrantAction,
  CredentialAccessGrantSummary,
  CredentialAccessSubjectSummary,
  CredentialUseGrant,
  DeleteClientConfigRequest,
  GetClientConfigStatusRequest,
  ManagedCredentialSummary,
  ProxyGitHttpRequest,
  ProxyGitHttpResponse,
  RequestCredentialInputRequest,
  ConfigureClientRequest,
  ResolveUrlBoundCredentialRequest,
  StoredCredentialSummary,
  StoreUrlBoundCredentialRequest,
  UrlAudience,
} from "@vibestudio/credential-client/types";
import type { EntityRecord, EntityKind } from "../../../packages/shared/src/runtime/entitySpec.js";
import {
  findMatchingUrlAudience,
  normalizeCredentialInjection,
  normalizeUrlAudiences,
} from "@vibestudio/credential-client/urlAudience";
import type {
  DeferredResult,
  ServiceContext,
} from "../../../packages/shared/src/serviceDispatcher.js";
import type { AppCapability } from "../../../packages/shared/src/unitManifest.js";
import type { ServiceDefinition } from "../../../packages/shared/src/serviceDefinition.js";
import { defineServiceHandler } from "../../../packages/shared/src/serviceHandlers.js";
import {
  credentialsMethods,
  type AuditParams,
  type ConfigureClientParams,
  type CredentialIdParams,
  type DeleteClientConfigParams,
  type GetClientConfigStatusParams,
  type ProxyFetchParams,
  type ProxyGitHttpParams,
  type RequestClientConfigParams,
  type RequestCredentialInputParams,
  type ResolveCredentialParams,
  type StoreUrlBoundCredentialParams,
} from "@vibestudio/service-schemas/credentials";
import type { EgressProxy } from "./egressProxy.js";
import type { ApprovalQueue, GrantedDecision } from "./approvalQueue.js";
import { CredentialLifecycle } from "./credentialLifecycle.js";
import { isAuthorizedChrome } from "./chromeTrust.js";
import {
  CredentialSessionGrantStore,
  type CredentialSessionGrantResource,
  type CredentialSessionGrantScope,
} from "./credentialSessionGrants.js";
import type { CredentialUseGrantStoreLike } from "./credentialUseGrantStore.js";
import { assertPresent } from "../../lintHelpers";
import { serializeGitHttpResponse } from "./gitHttpRpc.js";
import type { DisposableGitRemoteManager } from "./disposableGitRemoteManager.js";
import { throwIfAborted } from "./credentialMechanisms/async.js";
import { OAuthConnectionError } from "./credentialMechanisms/errors.js";
import { basicAuthHeader } from "./credentialMechanisms/oauth2.js";
import { normalizeAccountIdentity } from "./credentialMechanisms/tokens.js";
import {
  buildCredentialRuntimeIndex,
  findNearestCredentialPanelEntity,
  resolvePanelSlotForCredentialEntity,
  type CredentialRuntimeIndex,
  type CredentialRuntimeInspector,
  type CredentialRuntimePanelInfo,
} from "./credentialRuntimeContext.js";
import {
  createCredentialConnectionCoordinator,
  type SessionCredentialCapture,
} from "./credentialConnectionCoordinator.js";
import {
  canonicalCredentialUrl as canonicalUrl,
  validateCredentialClientConfigUrls as validateClientConfigUrls,
} from "./credentialClientConfig.js";

interface CredentialUseContext {
  binding: CredentialBinding;
  resource: string;
  action: CredentialGrantAction;
  sessionResource: CredentialSessionGrantResource;
  gitOperation?: {
    action: "read" | "write";
    label: string;
    remote: string;
    service?: string;
    force?: boolean;
    overwrites?: {
      count: number;
      commits: Array<{ sha: string; summary: string }>;
    };
  };
}

export type { CredentialRuntimeInspector, CredentialRuntimePanelInfo, SessionCredentialCapture };

export interface CredentialServiceDeps {
  credentialStore?: CredentialStore;
  clientConfigStore?: ClientConfigStore;
  auditLog?: AuditLog;
  eventService?: Pick<EventService, "emit" | "emitToCaller" | "emitToConnection">;
  connectionLookup?: {
    getAuthorizingShell(principalId: string): {
      caller: { runtime: { id: string; kind: string } };
      connectionId: string;
    } | null;
  };
  egressProxy?: Pick<EgressProxy, "forwardProxyFetch" | "forwardGitHttp">;
  disposableGitHttp?: Pick<DisposableGitRemoteManager, "matches" | "handle">;
  approvalQueue?: ApprovalQueue;
  sessionGrantStore?: CredentialSessionGrantStore;
  credentialUseGrantStore?: CredentialUseGrantStoreLike;
  credentialLifecycle?: CredentialLifecycle;
  sessionCredentialCapture?: SessionCredentialCapture;
  /**
   * Completes a pending server→shell capture roundtrip (the
   * `credential:capture-request` event). Wired from credentialCaptureBridge.
   */
  completeCapture?: (captureId: string, response: Record<string, unknown>) => void;
  hasAppCapability?: (callerId: string, capability: AppCapability) => boolean;
  runtimeInspector?: CredentialRuntimeInspector;
  /**
   * Announce a pending relay-routed OAuth transaction to the apex relay over the
   * backhaul so the callback can be handed back to this server (§7). `desktop`
   * transactions are pushed down the backhaul; `mobile` transactions are only
   * registered so a failed deep-link renders a truthful "open the app" page.
   */
  relayOAuthRegistrar?: {
    register(transactionId: string, platform: "mobile" | "desktop"): void;
  };
}

export function createCredentialService(deps: CredentialServiceDeps = {}): ServiceDefinition & {
  /** Resolve a desktop OAuth transaction pushed down the relay backhaul. */
  resolveRelayOAuthCallback: (frame: {
    transactionId: string;
    state?: string;
    code?: string;
    error?: string;
  }) => Promise<void>;
} {
  const credentialStore = deps.credentialStore ?? new CredentialStore();
  const clientConfigStore = deps.clientConfigStore ?? new ClientConfigStore();
  const auditLog = deps.auditLog;
  const eventService = deps.eventService;
  const connectionLookup = deps.connectionLookup;
  const egressProxy = deps.egressProxy;
  const approvalQueue = deps.approvalQueue;
  const sessionGrantStore = deps.sessionGrantStore ?? new CredentialSessionGrantStore();
  const credentialUseGrantStore = deps.credentialUseGrantStore ?? null;
  const runtimeInspector = deps.runtimeInspector;
  const credentialLifecycle =
    deps.credentialLifecycle ??
    new CredentialLifecycle({
      credentialStore,
      clientConfigStore,
    });

  type UserlandRuntimeContext = ServiceContext & {
    caller: ServiceContext["caller"] & {
      runtime: ServiceContext["caller"]["runtime"] & {
        kind: "panel" | "app" | "worker" | "do";
      };
    };
  };

  function isUserlandRuntimeCaller(ctx: ServiceContext): ctx is UserlandRuntimeContext {
    return (
      ctx.caller.runtime.kind === "panel" ||
      ctx.caller.runtime.kind === "app" ||
      ctx.caller.runtime.kind === "worker" ||
      ctx.caller.runtime.kind === "do"
    );
  }

  const connectionCoordinator = createCredentialConnectionCoordinator({
    credentialStore,
    clientConfigStore,
    approvalQueue,
    eventService,
    connectionLookup,
    sessionCredentialCapture: deps.sessionCredentialCapture,
    runtimeInspector,
    relayOAuthRegistrar: deps.relayOAuthRegistrar,
    storeCredential,
    resolveApprovalIdentity,
    requestCredentialApproval,
    loadActiveCredential,
    authorizeCredentialSubjectUse,
    findReplacementCandidate,
    validateCredentialBindings(bindings, fallback) {
      normalizeCredentialBindings(bindings, fallback);
    },
    appendAudit,
  });

  async function storeCredential(
    ctx: ServiceContext,
    params: StoreUrlBoundCredentialParams & Pick<Credential, "oauthRefresh" | "refreshToken">,
    opts: {
      approvalDecision?: Exclude<GrantedDecision, "deny">;
      preapprovedUseDecision?: Exclude<GrantedDecision, "deny">;
      replaceCredentialId?: string;
      replacementCredentialLabel?: string;
    } = {}
  ): Promise<StoredCredentialSummary> {
    const request = params as StoreUrlBoundCredentialRequest &
      Pick<Credential, "oauthRefresh" | "refreshToken">;
    const replaced = opts.replaceCredentialId
      ? await credentialStore.loadUrlBound(opts.replaceCredentialId)
      : null;
    if (opts.replaceCredentialId && !replaced) {
      throw new Error("Credential selected for replacement no longer exists; retry the connection");
    }
    const id = replaced?.id ?? randomUUID();
    const audience = normalizeUrlAudiences(request.audience);
    const injection = normalizeCredentialInjection(request.injection);
    const bindings = normalizeCredentialBindings(request.bindings, { audience, injection });
    const identity = ctx.caller.code ?? null;
    const now = Date.now();
    const approvalIdentity = resolveApprovalIdentity(ctx);
    if (!opts.approvalDecision) {
      await requestCredentialApproval(ctx, {
        credentialId: id,
        credentialLabel: request.label,
        audience,
        injection,
        accountIdentity: normalizeAccountIdentity(request.accountIdentity, ctx.caller.runtime.id),
        scopes: request.scopes ?? [],
        identity: approvalIdentity,
        metadata: request.metadata,
        replacementCredentialLabel: opts.replacementCredentialLabel,
      });
    }
    const owner =
      replaced?.owner ??
      ({
        sourceId: identity?.repoPath ?? ctx.caller.runtime.id,
        sourceKind: identity ? ("workspace" as const) : ("user" as const),
        label: identity?.repoPath ?? ctx.caller.runtime.id,
      } satisfies NonNullable<Credential["owner"]>);
    const accountIdentity = normalizeAccountIdentity(
      request.accountIdentity,
      ctx.caller.runtime.id
    );
    const credential: Credential = {
      id,
      label: request.label,
      owner,
      bindings,
      // Re-authentication changes secret material, not the semantic credential
      // identity. Stable id/owner/grants keep existing approved consumers
      // working while the provider session is renewed from another UI surface.
      grants: replaced?.grants ?? [],
      providerId: "url-bound",
      connectionId: id,
      connectionLabel: request.label,
      accountIdentity,
      accessToken: request.material.token,
      refreshToken: request.refreshToken,
      oauthRefresh: request.oauthRefresh,
      scopes: request.scopes ?? [],
      expiresAt: request.expiresAt,
      metadata: {
        ...(request.metadata ?? {}),
        createdAt: replaced?.metadata?.["createdAt"] ?? String(now),
        updatedAt: String(now),
        materialType: request.material.type,
      },
    };

    if (opts.preapprovedUseDecision) {
      await applyPreapprovedCredentialUseGrants(
        ctx,
        credential as Credential & { id: string },
        bindings,
        opts.preapprovedUseDecision,
        now
      );
    }

    await credentialStore.saveUrlBound(credential as Credential & { id: string });
    await appendAudit({
      type: replaced ? "connection_credential.replaced" : "connection_credential.created",
      ts: now,
      callerId: ctx.caller.runtime.id,
      providerId: "url-bound",
      connectionId: id,
      storageKind: "connection-credential",
      fieldNames: ["credential"],
    });
    return summarizeUrlBoundCredential(credential);
  }

  async function requestClientConfig(
    ctx: ServiceContext,
    params: RequestClientConfigParams
  ): Promise<ClientConfigStatus> {
    const request = params as ConfigureClientRequest;
    if (!approvalQueue || !isUserlandRuntimeCaller(ctx)) {
      throw new Error("client config approval is unavailable");
    }
    const authorizeUrl = canonicalUrl(request.authorizeUrl);
    const tokenUrl = canonicalUrl(request.tokenUrl);
    validateClientConfigUrls(authorizeUrl, tokenUrl);
    normalizeUrlAudiences([
      { url: authorizeUrl, match: "exact" },
      { url: tokenUrl, match: "exact" },
    ]);
    const identity = resolveApprovalIdentity(ctx);
    const result = await approvalQueue.requestClientConfig({
      kind: "client-config",
      callerId: ctx.caller.runtime.id,
      callerKind: ctx.caller.runtime.kind,
      ...(ctx.caller.subject ? { requestedByUserId: ctx.caller.subject.userId } : {}),
      repoPath: identity.repoPath,
      effectiveVersion: identity.effectiveVersion,
      configId: request.configId,
      authorizeUrl,
      tokenUrl,
      title: request.title,
      description: request.description,
      fields: request.fields.map((field) => ({
        name: field.name,
        label: field.label,
        type: field.type,
        required: field.required ?? false,
        description: field.description,
      })),
    });
    if (result.decision !== "submit") {
      throw new Error("client config approval denied");
    }

    const now = Date.now();
    const existing = await clientConfigStore.load(request.configId);
    if (existing) {
      if (canonicalUrl(existing.authorizeUrl) !== authorizeUrl) {
        throw new Error("client config authorizeUrl is immutable for this configId");
      }
      if (canonicalUrl(existing.tokenUrl) !== tokenUrl) {
        throw new Error("client config tokenUrl is immutable for this configId");
      }
    }
    const fields = { ...(existing?.fields ?? {}) };
    for (const field of request.fields) {
      const value = result.values[field.name]?.trim() ?? "";
      if ((field.required ?? false) && !value) {
        throw new Error(`client config field is required: ${field.name}`);
      }
      if (value) {
        fields[field.name] = {
          value,
          type: field.type,
          updatedAt: now,
        };
      }
    }
    const version = randomUUID();
    const versions = { ...(existing?.versions ?? {}) };
    const requestFlowTypes = (params as ConfigureClientRequest).flowTypes;
    const requestStatus = (params as ConfigureClientRequest).status;
    const allowRefreshWhenDisabled = (params as ConfigureClientRequest).allowRefreshWhenDisabled;
    versions[version] = {
      version,
      authorizeUrl,
      tokenUrl,
      status: requestStatus ?? existing?.status ?? "active",
      flowTypes: requestFlowTypes ?? existing?.flowTypes ?? ["oauth2-auth-code-pkce"],
      allowRefreshWhenDisabled: allowRefreshWhenDisabled ?? existing?.allowRefreshWhenDisabled,
      fields,
      createdAt: now,
    };
    const record = {
      configId: request.configId,
      currentVersion: version,
      owner: existing?.owner ?? {
        callerId: ctx.caller.runtime.id,
        callerKind: ctx.caller.runtime.kind,
        repoPath: identity.repoPath,
        effectiveVersion: identity.effectiveVersion,
      },
      authorizeUrl,
      tokenUrl,
      status: requestStatus ?? existing?.status ?? "active",
      flowTypes: requestFlowTypes ?? existing?.flowTypes ?? ["oauth2-auth-code-pkce"],
      allowRefreshWhenDisabled: allowRefreshWhenDisabled ?? existing?.allowRefreshWhenDisabled,
      fields,
      versions,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await pruneClientConfigVersions(record);
    await clientConfigStore.save(record);
    await appendAudit({
      type: "client_config.updated",
      ts: now,
      callerId: ctx.caller.runtime.id,
      configId: request.configId,
      authorizeUrl,
      tokenUrl,
      fieldNames: request.fields.map((field) => field.name),
    });
    return clientConfigStore.summarize(request.configId, record, request.fields);
  }

  async function configureClient(
    ctx: ServiceContext,
    params: ConfigureClientParams
  ): Promise<ClientConfigStatus> {
    const request = params as ConfigureClientRequest;
    const status = await requestClientConfig(ctx, request);
    return {
      ...status,
      flowTypes: request.flowTypes ?? status.flowTypes,
      status: request.status ?? status.status ?? "active",
    };
  }

  async function getClientConfigStatus(
    ctx: ServiceContext,
    params: GetClientConfigStatusParams
  ): Promise<ClientConfigStatus> {
    const request = params as GetClientConfigStatusRequest;
    const record = await clientConfigStore.load(request.configId);
    return clientConfigStore.summarize(request.configId, record, request.fields);
  }

  async function deleteClientConfig(
    ctx: ServiceContext,
    params: DeleteClientConfigParams
  ): Promise<void> {
    const request = params as DeleteClientConfigRequest;
    const existing = await clientConfigStore.load(request.configId);
    if (!existing) return;
    if (!canCallerBypassCredentialMutationApproval(ctx)) {
      if (!approvalQueue || !isUserlandRuntimeCaller(ctx)) {
        throw new Error("Client config deletion approval is unavailable for this caller");
      }
      const identity = resolveApprovalIdentity(ctx);
      const decision = await approvalQueue.request({
        kind: "capability",
        dedupKey: `delete-client-config:${request.configId}`,
        callerId: ctx.caller.runtime.id,
        callerKind: ctx.caller.runtime.kind,
        ...(ctx.caller.subject ? { requestedByUserId: ctx.caller.subject.userId } : {}),
        repoPath: identity.repoPath,
        effectiveVersion: identity.effectiveVersion,
        capability: "client-config-delete",
        operation: {
          kind: "service-setup",
          verb: "Disable service configuration",
          object: {
            type: "client-config",
            label: "Service",
            value: request.configId,
          },
          groupKey: `delete-client-config:${request.configId}`,
        },
        title: `Disable ${request.configId}`,
        description: "Delete this client config for new connections and future refreshes.",
        resource: {
          type: "client-config",
          label: "Config",
          value: request.configId,
        },
        details: [
          { label: "Sign-in origin", value: new URL(existing.authorizeUrl).origin },
          { label: "Token origin", value: new URL(existing.tokenUrl).origin },
        ],
      });
      if (decision === "deny") {
        throw new Error("Client config deletion denied");
      }
    }
    await clientConfigStore.save({
      ...existing,
      status: "deleted",
      updatedAt: Date.now(),
    });
  }

  async function requestCredentialInput(
    ctx: ServiceContext,
    params: RequestCredentialInputParams
  ): Promise<StoredCredentialSummary> {
    const request = params as RequestCredentialInputRequest;
    if (!approvalQueue || !isUserlandRuntimeCaller(ctx)) {
      throw new Error("Credential input approval is unavailable");
    }
    if (request.fields.length !== 1) {
      throw new Error("Credential input expects exactly one secret field");
    }
    const tokenField = assertPresent(request.fields[0]);
    if (tokenField.name !== request.material.tokenField) {
      throw new Error("Credential input tokenField must match the submitted secret field");
    }
    if (tokenField.type !== "secret") {
      throw new Error("Credential input tokenField must be a secret field");
    }
    if (tokenField.required !== true) {
      throw new Error("Credential input tokenField must be required");
    }
    const audience = normalizeUrlAudiences(request.credential.audience);
    const injection = normalizeCredentialInjection(request.credential.injection);
    const accountIdentity = normalizeAccountIdentity(
      request.credential.accountIdentity,
      ctx.caller.runtime.id
    );
    const identity = resolveApprovalIdentity(ctx);
    const result = await approvalQueue.requestCredentialInput({
      kind: "credential-input",
      callerId: ctx.caller.runtime.id,
      callerKind: ctx.caller.runtime.kind,
      ...(ctx.caller.subject ? { requestedByUserId: ctx.caller.subject.userId } : {}),
      repoPath: identity.repoPath,
      effectiveVersion: identity.effectiveVersion,
      title: request.title,
      description: request.description,
      credentialLabel: request.credential.label,
      audience,
      injection,
      accountIdentity,
      scopes: request.credential.scopes ?? [],
      fields: request.fields.map((field) => ({
        name: field.name,
        label: field.label,
        type: field.type,
        required: field.required ?? false,
        description: field.description,
      })),
    });
    if (result.decision !== "submit") {
      throw new Error("Credential input approval denied");
    }

    const token = result.values[request.material.tokenField]?.trim() ?? "";
    if (!token) {
      throw new Error(`Credential input field is required: ${request.material.tokenField}`);
    }

    return storeCredential(
      ctx,
      {
        label: request.credential.label,
        audience,
        injection,
        bindings: request.credential.bindings,
        material: {
          type: request.material.type,
          token,
        },
        accountIdentity,
        scopes: request.credential.scopes ?? [],
        metadata: request.credential.metadata,
      },
      { approvalDecision: "session" }
    );
  }

  async function listStoredCredentials(): Promise<StoredCredentialSummary[]> {
    const credentials = await credentialStore.listUrlBound();
    return credentials.map(summarizeUrlBoundCredential);
  }

  async function inspectStoredCredentials(): Promise<ManagedCredentialSummary[]> {
    const credentials = await credentialStore.listUrlBound();
    const runtimeIndex = await buildCredentialRuntimeIndex(runtimeInspector);
    return Promise.all(
      credentials.map((credential) => summarizeManagedCredential(credential, runtimeIndex))
    );
  }

  async function summarizeManagedCredential(
    credential: Credential,
    runtimeIndex: CredentialRuntimeIndex
  ): Promise<ManagedCredentialSummary> {
    const bindings = credentialBindings(credential);
    const grants = await Promise.all(
      (credential.grants ?? []).map((grant) =>
        summarizeCredentialGrant(bindings, grant, runtimeIndex)
      )
    );
    return {
      ...summarizeUrlBoundCredential(credential),
      grants,
    };
  }

  async function summarizeCredentialGrant(
    bindings: CredentialBinding[],
    grant: CredentialUseGrant,
    runtimeIndex: CredentialRuntimeIndex
  ): Promise<CredentialAccessGrantSummary> {
    const binding = bindings.find(
      (candidate) => candidate.id === grant.bindingId && candidate.use === grant.use
    );
    const subjects = await summarizeCredentialGrantSubjects(grant, runtimeIndex);
    return {
      id: credentialUseGrantKey(grant),
      bindingId: grant.bindingId,
      ...(binding?.label ? { bindingLabel: binding.label } : {}),
      use: grant.use,
      resource: grant.resource,
      action: grant.action,
      scope: grant.scope,
      repoPath: grant.repoPath,
      effectiveVersion: grant.effectiveVersion,
      grantedAt: grant.grantedAt,
      grantedBy: grant.grantedBy,
      subjects,
    };
  }

  async function summarizeCredentialGrantSubjects(
    grant: CredentialUseGrant,
    runtimeIndex: CredentialRuntimeIndex
  ): Promise<CredentialAccessSubjectSummary[]> {
    const subjects = runtimeIndex.activeEntities.filter(
      (entity) =>
        isCredentialAccessSubjectKind(entity.kind) &&
        entity.source.repoPath === grant.repoPath &&
        entity.source.effectiveVersion === grant.effectiveVersion
    );
    return Promise.all(
      subjects.map((entity) => summarizeCredentialSubject(entity.id, entity, runtimeIndex))
    );
  }

  function isCredentialAccessSubjectKind(
    kind: EntityKind
  ): kind is "panel" | "worker" | "do" | "app" {
    return kind === "panel" || kind === "worker" || kind === "do" || kind === "app";
  }

  async function summarizeCredentialSubject(
    id: string,
    entity: EntityRecord | null,
    runtimeIndex: CredentialRuntimeIndex
  ): Promise<CredentialAccessSubjectSummary> {
    if (!entity) {
      return {
        id,
        kind: "unknown",
        active: false,
        focusUnavailableReason: "Runtime is not active",
      };
    }
    const focusTarget = await resolveCredentialSubjectFocusTarget(entity, runtimeIndex);
    return {
      id: entity.id,
      kind: isCredentialAccessSubjectKind(entity.kind) ? entity.kind : "unknown",
      active: entity.status === "active",
      title: credentialSubjectTitle(entity, focusTarget?.panelInfo ?? null),
      source: entity.source,
      contextId: entity.contextId,
      ...(entity.parentId ? { parentId: entity.parentId } : {}),
      ...(focusTarget?.panelId ? { focusPanelId: focusTarget.panelId } : {}),
      ...(focusTarget?.panelInfo?.title ? { focusPanelTitle: focusTarget.panelInfo.title } : {}),
      ...(focusTarget?.panelInfo?.source ? { focusPanelSource: focusTarget.panelInfo.source } : {}),
      ...(!focusTarget?.panelId
        ? {
            focusUnavailableReason:
              entity.kind === "panel" ? "Panel is not open" : "No parent panel is open",
          }
        : {}),
    };
  }

  async function resolveCredentialSubjectFocusTarget(
    entity: EntityRecord,
    runtimeIndex: CredentialRuntimeIndex
  ): Promise<{ panelId: string; panelInfo: CredentialRuntimePanelInfo | null } | null> {
    const panelEntity = findNearestCredentialPanelEntity(entity, runtimeIndex);
    if (!panelEntity) return null;
    const panelId = await resolvePanelSlotForCredentialEntity(
      panelEntity.id,
      runtimeIndex,
      runtimeInspector
    );
    if (!panelId) return null;
    return {
      panelId,
      panelInfo:
        runtimeIndex.panelsByPanelId.get(panelId) ??
        runtimeIndex.panelsByRuntimeEntityId.get(panelEntity.id) ??
        null,
    };
  }

  function credentialSubjectTitle(
    entity: EntityRecord,
    panelInfo: CredentialRuntimePanelInfo | null
  ): string {
    if (entity.kind === "panel" && panelInfo?.title) return panelInfo.title;
    if (entity.kind === "do")
      return entity.className ? `${entity.className}:${entity.key}` : entity.id;
    if (entity.kind === "worker" || entity.kind === "app") return entity.source.repoPath;
    return entity.id;
  }

  async function revokeCredential(ctx: ServiceContext, params: CredentialIdParams): Promise<void> {
    const credential = await credentialStore.loadUrlBound(params.credentialId);
    if (!credential) {
      return;
    }
    await ensureCredentialRevocationApproved(ctx, credential, params.credentialId);
    try {
      await revokeProviderTokenIfConfigured(credential);
    } catch (error) {
      await appendAudit({
        type: "connection_credential.revocation_failed",
        ts: Date.now(),
        callerId: ctx.caller.runtime.id,
        providerId: credential.providerId,
        connectionId: credential.connectionId,
        storageKind: "connection-credential",
        fieldNames: ["revocation"],
      });
      void error;
    }
    await credentialStore.saveUrlBound({
      ...credential,
      id: credential.id ?? params.credentialId,
      revokedAt: Date.now(),
    } as Credential & { id: string });
  }

  async function ensureCredentialRevocationApproved(
    ctx: ServiceContext,
    credential: Credential,
    credentialId: string
  ): Promise<void> {
    if (canCallerBypassCredentialMutationApproval(ctx)) {
      return;
    }
    if (!approvalQueue || !isUserlandRuntimeCaller(ctx)) {
      throw new Error("Credential revocation approval is unavailable for this caller");
    }

    const identity = resolveApprovalIdentity(ctx);
    const targetId = credential.id ?? credentialId;
    const label = credential.label ?? credential.connectionLabel ?? targetId;
    const decision = await approvalQueue.request({
      kind: "capability",
      dedupKey: `revoke-credential:${targetId}`,
      callerId: ctx.caller.runtime.id,
      callerKind: ctx.caller.runtime.kind,
      ...(ctx.caller.subject ? { requestedByUserId: ctx.caller.subject.userId } : {}),
      repoPath: identity.repoPath,
      effectiveVersion: identity.effectiveVersion,
      capability: "credential-revoke",
      severity: "severe",
      operation: {
        kind: "credential",
        verb: "Revoke credential",
        object: {
          type: "credential",
          label: "Credential",
          value: label,
        },
        groupKey: `revoke-credential:${targetId}`,
      },
      title: `Revoke ${label}`,
      description: "Allow this requester to revoke this stored credential.",
      resource: {
        type: "credential",
        label: "Credential",
        value: label,
      },
      details: [
        { label: "Credential ID", value: targetId },
        { label: "Requester", value: ctx.caller.runtime.id },
        { label: "Source", value: identity.repoPath },
      ],
    });
    if (decision === "deny") {
      throw new Error("Credential revocation denied");
    }
  }

  async function revokeProviderTokenIfConfigured(credential: Credential): Promise<void> {
    const revocationUrl = credential.metadata?.["oauthRevocationUrl"];
    if (!revocationUrl) return;
    const token = credential.refreshToken ?? credential.accessToken;
    if (!token) return;
    const body = new URLSearchParams();
    body.set("token", token);
    body.set("token_type_hint", credential.refreshToken ? "refresh_token" : "access_token");
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    const refresh = credential.oauthRefresh;
    const configuredCredentialId = credential.metadata?.["clientConfigId"];
    const configuredCredentialVersion = credential.metadata?.["clientConfigVersion"];
    const configRef = refresh?.clientConfig;
    if (configRef || configuredCredentialId) {
      const config = configRef
        ? await clientConfigStore.loadVersion(configRef.configId, configRef.configVersion)
        : configuredCredentialId && configuredCredentialVersion
          ? await clientConfigStore.loadVersion(configuredCredentialId, configuredCredentialVersion)
          : configuredCredentialId
            ? await clientConfigStore.load(configuredCredentialId)
            : null;
      const clientId = refresh?.clientId ?? config?.fields["clientId"]?.value;
      const clientSecret = config?.fields["clientSecret"]?.value;
      const tokenAuth = refresh?.tokenAuth ?? credential.metadata?.["oauthTokenAuth"];
      if (clientId) body.set("client_id", clientId);
      if (tokenAuth === "client_secret_basic" && clientId && clientSecret) {
        headers["authorization"] = basicAuthHeader(clientId, clientSecret);
      } else if (clientSecret) {
        body.set("client_secret", clientSecret);
      }
    }
    const response = await fetch(revocationUrl, { method: "POST", headers, body });
    if (!response.ok) {
      throw new OAuthConnectionError("token_exchange_failed", "Provider token revocation failed");
    }
  }

  async function resolveCredential(
    ctx: ServiceContext,
    params: ResolveCredentialParams
  ): Promise<StoredCredentialSummary | null | DeferredResult> {
    const request = params as ResolveUrlBoundCredentialRequest;
    const use = request.use ?? "fetch";
    let credential: Credential;
    let usage: CredentialUseContext;
    if (request.credentialId) {
      credential = await loadActiveCredential(request.credentialId);
      if (!request.url) {
        const matched = providerCredentialUseContext(credential, request.providerId, use);
        if (!matched) {
          throw new Error("Credential does not match requested provider");
        }
        usage = matched;
      } else {
        const matched = credentialUseContext(credential, new URL(request.url), use);
        if (!matched) {
          throw new Error("Credential audience does not match requested URL");
        }
        usage = matched;
      }
    } else if (request.url) {
      const found = await findUrlBoundCredentialForUrl(new URL(request.url), use);
      if (!found) return null;
      credential = found.credential;
      usage = found.usage;
    } else if (request.providerId) {
      const found = await findUrlBoundCredentialForProvider(request.providerId, use);
      if (!found) return null;
      credential = found.credential;
      usage = found.usage;
    } else {
      return null;
    }

    // Already permitted — summarize inline (fast path, unchanged).
    if (canCallerUseStoredCredential(ctx, credential, usage)) {
      return summarizeUrlBoundCredential(credential);
    }

    // Approval needed. A hibernatable DO caller defers so it need not hold its
    // inbound request open across the (human) approval wait — the summary is
    // delivered out-of-band via onDeferredResult once the user decides.
    const produce = async (signal?: AbortSignal): Promise<StoredCredentialSummary> => {
      await authorizeCredentialUse(ctx, credential, usage, signal);
      return summarizeUrlBoundCredential(credential);
    };
    if (ctx.deferral?.canDefer) {
      return ctx.deferral.run(produce);
    }
    return produce();
  }

  async function proxyFetch(
    ctx: ServiceContext,
    params: ProxyFetchParams
  ): Promise<{
    status: number;
    statusText: string;
    /**
     * Headers as ordered pairs. Preserves duplicate `Set-Cookie`
     * entries (which the Fetch spec doesn't combine on iteration)
     * across the RPC boundary; a flat Record would silently drop all
     * but the last one.
     */
    headerPairs: Array<[string, string]>;
    /** Final URL after any redirects the upstream fetch followed. Mirrors `Response.url`. */
    finalUrl: string;
    /** Response body, base64-encoded. Always set; empty string for zero-byte bodies. */
    bodyBase64: string;
  }> {
    if (!egressProxy) {
      throw new Error("Egress proxy is unavailable");
    }
    const requestBody: string | Uint8Array | undefined =
      params.bodyBase64 !== undefined ? Buffer.from(params.bodyBase64, "base64") : params.body;
    const result = await egressProxy.forwardProxyFetch({
      caller: ctx.caller,
      url: params.url,
      method: params.method,
      headers: params.headers,
      body: requestBody,
      credentialId: params.credentialId,
    });
    return {
      status: result.status,
      statusText: result.statusText,
      headerPairs: result.headerPairs,
      finalUrl: result.finalUrl,
      bodyBase64: Buffer.from(result.body).toString("base64"),
    };
  }

  async function proxyGitHttp(
    ctx: ServiceContext,
    params: ProxyGitHttpParams
  ): Promise<ProxyGitHttpResponse> {
    const request = params as ProxyGitHttpRequest;
    if (deps.disposableGitHttp?.matches(request.url)) {
      return serializeGitHttpResponse(
        await deps.disposableGitHttp.handle({
          url: request.url,
          method: request.method ?? "GET",
          headers: request.headers ?? {},
          body: request.bodyBase64 ? Buffer.from(request.bodyBase64, "base64") : undefined,
        })
      );
    }
    if (!egressProxy) {
      throw new Error("Egress proxy is unavailable");
    }
    const result = await egressProxy.forwardGitHttp({
      caller: ctx.caller,
      url: request.url,
      method: request.method ?? "GET",
      headers: request.headers ?? {},
      body: request.bodyBase64 ? Buffer.from(request.bodyBase64, "base64") : undefined,
      credentialId: request.credentialId,
      gitIntent: request.gitIntent,
    });
    return serializeGitHttpResponse(result);
  }

  async function audit(params: AuditParams): Promise<AuditEntry[]> {
    const entries =
      (await auditLog?.query({
        filter: params.filter,
        limit: params.limit,
        after: params.after,
      })) ?? [];
    return entries.filter((entry): entry is AuditEntry => "workerId" in entry);
  }

  async function appendAudit(entry: CredentialAuditEvent): Promise<void> {
    await auditLog?.append(entry);
  }

  async function loadActiveCredential(credentialId: string): Promise<Credential & { id: string }> {
    let credential = await credentialStore.loadUrlBound(credentialId);
    if (!credential?.id || credential.revokedAt) {
      throw new Error("Credential is unavailable");
    }
    if (
      credential.expiresAt &&
      credential.expiresAt <= Date.now() + 30_000 &&
      credential.refreshToken
    ) {
      credential = await credentialLifecycle.refreshCredential(
        credential as Credential & { id: string }
      );
    }
    return credential as Credential & { id: string };
  }

  async function authorizeCredentialSubjectUse(
    ctx: ServiceContext,
    credential: Credential & { id: string }
  ): Promise<void> {
    const binding = credential.bindings?.[0];
    const audience = binding?.audience[0]?.url;
    if (!binding || !audience) {
      throw new OAuthConnectionError(
        "client_not_authorized",
        "Subject credential has no usable binding"
      );
    }
    const usage = credentialUseContext(credential, new URL(audience), binding.use);
    if (!usage) {
      throw new OAuthConnectionError(
        "client_not_authorized",
        "Subject credential binding cannot be authorized"
      );
    }
    await authorizeCredentialUse(ctx, credential, usage);
  }

  function resolveApprovalIdentity(ctx: ServiceContext): {
    callerId: string;
    repoPath: string;
    effectiveVersion: string;
  } {
    const identity = ctx.caller.code;
    const entity = identity ? null : resolveRuntimeEntityForApproval(ctx.caller.runtime.id);
    return {
      callerId: identity?.callerId ?? entity?.id ?? ctx.caller.runtime.id,
      repoPath: identity?.repoPath ?? entity?.source.repoPath ?? ctx.caller.runtime.id,
      effectiveVersion: identity?.effectiveVersion ?? entity?.source.effectiveVersion ?? "unknown",
    };
  }

  function resolveRuntimeEntityForApproval(callerId: string): EntityRecord | null {
    if (!runtimeInspector) return null;
    try {
      const active = runtimeInspector.listActiveEntities();
      if (!Array.isArray(active)) return null;
      return active.find((entity) => entity.id === callerId && entity.status === "active") ?? null;
    } catch {
      return null;
    }
  }

  async function requestCredentialApproval(
    ctx: ServiceContext,
    params: {
      credentialId: string;
      credentialLabel: string;
      audience: UrlAudience[];
      injection: CredentialBinding["injection"];
      accountIdentity: Credential["accountIdentity"];
      scopes: string[];
      identity: { repoPath: string; effectiveVersion: string };
      metadata?: Record<string, string>;
      replacementCredentialLabel?: string;
      signal?: AbortSignal;
    }
  ): Promise<Exclude<GrantedDecision, "deny">> {
    throwIfAborted(params.signal);
    if (!approvalQueue || !isUserlandRuntimeCaller(ctx)) {
      return "session";
    }
    const oauthAuthorizeOrigin = params.metadata?.["oauthAuthorizeOrigin"];
    const oauthTokenOrigin = params.metadata?.["oauthTokenOrigin"];
    const oauthUserinfoOrigin = params.metadata?.["oauthUserinfoOrigin"];
    if (!params.injection) {
      throw new Error("Credential injection is required");
    }
    const decision = await approvalQueue.request({
      ...(params.signal ? { signal: params.signal } : {}),
      callerId: ctx.caller.runtime.id,
      callerKind: ctx.caller.runtime.kind,
      ...(ctx.caller.subject ? { requestedByUserId: ctx.caller.subject.userId } : {}),
      repoPath: params.identity.repoPath,
      effectiveVersion: params.identity.effectiveVersion,
      credentialId: params.credentialId,
      credentialLabel: params.credentialLabel,
      audience: params.audience ?? [],
      injection: params.injection,
      accountIdentity: params.accountIdentity,
      scopes: params.scopes,
      oauthAuthorizeOrigin,
      oauthTokenOrigin,
      oauthUserinfoOrigin,
      oauthAudienceDomainMismatch: hasOAuthAudienceDomainMismatch(params.audience ?? [], [
        oauthAuthorizeOrigin,
        oauthTokenOrigin,
      ]),
      replacementCredentialLabel: params.replacementCredentialLabel,
    });
    if (decision === "deny") {
      throw new Error("Credential approval denied");
    }
    return decision;
  }

  /**
   * Locate the single URL-bound credential matching `targetUrl` (lookup only —
   * authorization is applied by the caller, so the call can be deferred). Throws
   * on ambiguity; returns null when nothing matches.
   */
  async function findUrlBoundCredentialForUrl(
    targetUrl: URL,
    use: CredentialBindingUse = "fetch"
  ): Promise<{ credential: Credential; usage: CredentialUseContext } | null> {
    const credentials = (await credentialStore.listUrlBound()).filter(
      (credential) => !credential.revokedAt && !!findCredentialBinding(credential, targetUrl, use)
    );
    if (credentials.length > 1) {
      throw new Error("Multiple credentials match requested URL; choose an explicit credential");
    }
    const credential = credentials[0] ?? null;
    if (!credential) return null;
    const active = credential.id ? await loadActiveCredential(credential.id) : credential;
    const usage = credentialUseContext(active, targetUrl, use);
    if (!usage) {
      throw new Error("Credential audience does not match requested URL");
    }
    return { credential: active, usage };
  }

  async function findUrlBoundCredentialForProvider(
    providerId: string,
    use: CredentialBindingUse = "fetch"
  ): Promise<{ credential: Credential; usage: CredentialUseContext } | null> {
    const credentials = (await credentialStore.listUrlBound()).filter((credential) => {
      if (credential.revokedAt) return false;
      if (
        credential.metadata?.["providerId"] !== providerId &&
        credential.metadata?.["modelProviderId"] !== providerId &&
        credential.providerId !== providerId
      ) {
        return false;
      }
      return credential.bindings?.some((binding) => binding.use === use) ?? false;
    });
    if (credentials.length > 1) {
      throw new Error(
        "Multiple credentials match requested provider; choose an explicit credential"
      );
    }
    const credential = credentials[0] ?? null;
    if (!credential) return null;
    const active = credential.id ? await loadActiveCredential(credential.id) : credential;
    const usage = providerCredentialUseContext(active, providerId, use);
    if (!usage) {
      throw new Error("Credential provider does not match requested provider");
    }
    return { credential: active, usage };
  }

  function providerCredentialUseContext(
    credential: Credential,
    providerId: string | undefined,
    use: CredentialBindingUse
  ): CredentialUseContext | null {
    if (
      providerId &&
      credential.metadata?.["providerId"] !== providerId &&
      credential.metadata?.["modelProviderId"] !== providerId &&
      credential.providerId !== providerId
    ) {
      return null;
    }
    const binding = credential.bindings?.find((candidate) => candidate.use === use);
    const audience = binding?.audience[0];
    if (!binding || !audience) return null;
    const action: CredentialGrantAction = use === "git-http" || use === "git-ssh" ? "read" : "use";
    return {
      binding,
      resource: audience.url,
      action,
      sessionResource: {
        bindingId: binding.id,
        resource: audience.url,
        action,
      },
      gitOperation: undefined,
    };
  }

  async function findReplacementCandidate(
    ctx: ServiceContext,
    candidate: {
      label: string;
      audience: UrlAudience[];
      metadata?: Record<string, string>;
      accountIdentity: Partial<AccountIdentity>;
    }
  ): Promise<(Credential & { id: string }) | null> {
    const account = normalizeAccountIdentity(candidate.accountIdentity, ctx.caller.runtime.id);
    if (!account.providerUserId || account.providerUserId === ctx.caller.runtime.id) {
      return null;
    }
    const providerKey =
      candidate.metadata?.["providerId"] ??
      candidate.metadata?.["modelProviderId"] ??
      candidate.label;
    const audienceKey = normalizedAudienceKey(candidate.audience);
    const existing = await credentialStore.listUrlBound();
    return (
      existing.find(
        (credential): credential is Credential & { id: string } =>
          !!credential.id &&
          !credential.revokedAt &&
          credential.accountIdentity?.providerUserId === account.providerUserId &&
          (credential.metadata?.["providerId"] ??
            credential.metadata?.["modelProviderId"] ??
            credential.label) === providerKey &&
          normalizedAudienceKey(summarizeUrlBoundCredential(credential).audience) === audienceKey
      ) ?? null
    );
  }

  async function pruneClientConfigVersions(record: ClientConfigRecord): Promise<void> {
    if (!record.versions) return;
    const keep = new Set<string>();
    if (record.currentVersion) keep.add(record.currentVersion);
    const credentials = await credentialStore.listUrlBound();
    for (const credential of credentials) {
      const refreshConfig = credential.oauthRefresh?.clientConfig;
      if (refreshConfig?.configId === record.configId) {
        keep.add(refreshConfig.configVersion);
      } else if (credential.metadata?.["clientConfigId"] === record.configId) {
        // OAuth1 client material is not an OAuth2 refresh recipe.
        const oauth1Version = credential.metadata["clientConfigVersion"];
        if (oauth1Version) keep.add(oauth1Version);
      }
    }
    record.versions = Object.fromEntries(
      Object.entries(record.versions).filter(([version]) => keep.has(version))
    );
  }

  async function authorizeCredentialUse(
    ctx: ServiceContext,
    credential: Credential,
    usage: CredentialUseContext,
    signal?: AbortSignal
  ): Promise<void> {
    if (canCallerUseStoredCredential(ctx, credential, usage)) {
      return;
    }
    if (
      !approvalQueue ||
      (ctx.caller.runtime.kind !== "panel" &&
        ctx.caller.runtime.kind !== "app" &&
        ctx.caller.runtime.kind !== "worker" &&
        ctx.caller.runtime.kind !== "do" &&
        ctx.caller.runtime.kind !== "extension")
    ) {
      throw new Error("Credential caller is not granted");
    }
    if (!credential.id) {
      throw new Error("Credential is missing URL-bound metadata");
    }
    const credentialId = credential.id;
    const identity = resolveApprovalIdentity(ctx);
    const decision = await approvalQueue.request({
      // When the caller deferred, this signal is aborted on TTL expiry so the
      // pending approval is cancelled cleanly instead of leaking a waiter.
      ...(signal ? { signal } : {}),
      callerId: ctx.caller.runtime.id,
      callerKind: ctx.caller.runtime.kind,
      ...(ctx.caller.subject ? { requestedByUserId: ctx.caller.subject.userId } : {}),
      repoPath: identity.repoPath,
      effectiveVersion: identity.effectiveVersion,
      credentialId: credential.id,
      credentialLabel: credential.label ?? credential.connectionLabel,
      audience: usage.binding.audience,
      injection: usage.binding.injection,
      accountIdentity: credential.accountIdentity,
      scopes: credential.scopes,
      credentialUse: usage.binding.use,
      bindingLabel: usage.binding.label,
      gitOperation: usage.gitOperation,
      grantResource: usage.sessionResource,
      oauthAuthorizeOrigin: credential.metadata?.["oauthAuthorizeOrigin"],
      oauthTokenOrigin: credential.metadata?.["oauthTokenOrigin"],
      oauthUserinfoOrigin: credential.metadata?.["oauthUserinfoOrigin"],
      oauthAudienceDomainMismatch: hasOAuthAudienceDomainMismatch(usage.binding.audience, [
        credential.metadata?.["oauthAuthorizeOrigin"],
        credential.metadata?.["oauthTokenOrigin"],
      ]),
    });
    if (decision === "deny") {
      throw new Error("Credential approval denied");
    }
    const now = Date.now();
    if (decision === "once") {
      if (!ctx.deferral?.canDefer) {
        return;
      }
      // A deferrable caller cannot consume a one-shot grant inline: it parks,
      // returns to the runner, then resolves credentials again during resume.
      // Treat that deferred one-shot approval as a session grant for the same
      // caller/resource so the approved turn can actually continue.
      grantSessionCredentialUse(credentialId, identity, usage.sessionResource);
      resolvePendingCredentialUseGrants(credentialId, identity, "session", usage);
      return;
    }
    if (decision === "session") {
      grantSessionCredentialUse(credentialId, identity, usage.sessionResource);
      resolvePendingCredentialUseGrants(credentialId, identity, decision, usage);
      return;
    }
    await persistCredentialUseGrant(
      credential as Credential & { id: string },
      grantForDecision(identity, decision, now, usage),
      now
    );
    resolvePendingCredentialUseGrants(credentialId, identity, decision, usage);
  }

  function canCallerUseStoredCredential(
    ctx: ServiceContext,
    credential: Credential,
    usage: CredentialUseContext
  ): boolean {
    if (isAuthorizedChrome(ctx.caller, { hasAppCapability: deps.hasAppCapability })) {
      return true;
    }
    return (
      hasPersistentCredentialUse(ctx, credential, usage) ||
      hasSessionCredentialUse(ctx, credential, usage)
    );
  }

  function canCallerBypassCredentialMutationApproval(ctx: ServiceContext): boolean {
    return isAuthorizedChrome(ctx.caller, { hasAppCapability: deps.hasAppCapability });
  }

  function grantSessionCredentialUse(
    credentialId: string,
    identity: CredentialSessionGrantScope,
    resource: CredentialSessionGrantResource
  ): void {
    sessionGrantStore.grant(credentialId, identity, resource);
  }

  function resolvePendingCredentialUseGrants(
    credentialId: string,
    identity: { callerId?: string; repoPath: string; effectiveVersion: string },
    decision: Exclude<GrantedDecision, "deny" | "once">,
    usage: CredentialUseContext
  ): void {
    if (typeof approvalQueue?.resolveMatching !== "function") return;
    approvalQueue.resolveMatching((approval) => {
      if (approval.kind !== "credential") return false;
      if (approval.credentialId !== credentialId) return false;
      if (!approval.grantResource) return false;
      if (
        approval.grantResource.bindingId !== usage.sessionResource.bindingId ||
        approval.grantResource.resource !== usage.sessionResource.resource ||
        approval.grantResource.action !== usage.sessionResource.action
      ) {
        return false;
      }
      if (decision === "session") return approval.callerId === identity.callerId;
      return (
        approval.repoPath === identity.repoPath &&
        approval.effectiveVersion === identity.effectiveVersion
      );
    }, "once");
  }

  async function applyPreapprovedCredentialUseGrants(
    ctx: ServiceContext,
    credential: Credential & { id: string },
    bindings: CredentialBinding[],
    decision: Exclude<GrantedDecision, "deny">,
    now: number
  ): Promise<void> {
    const identity = resolveApprovalIdentity(ctx);
    const usageContexts = bindings.flatMap(preapprovedUseContextsForBinding);
    if (decision === "once" || decision === "session") {
      for (const usage of usageContexts) {
        grantSessionCredentialUse(credential.id, identity, usage.sessionResource);
      }
      return;
    }
    for (const usage of usageContexts) {
      await persistCredentialUseGrant(
        credential,
        grantForDecision(identity, decision, now, usage),
        now
      );
    }
  }

  function hasSessionCredentialUse(
    ctx: ServiceContext,
    credential: Credential,
    usage: CredentialUseContext
  ): boolean {
    const credentialId = credential.id ?? credential.connectionId;
    if (!credentialId) {
      return false;
    }
    return sessionGrantStore.has(credentialId, resolveApprovalIdentity(ctx), usage.sessionResource);
  }

  function hasPersistentCredentialUse(
    ctx: ServiceContext,
    credential: Credential,
    usage: CredentialUseContext
  ): boolean {
    const identity = resolveApprovalIdentity(ctx);
    return persistentCredentialUseGrants(credential).some(
      (grant) =>
        grant.bindingId === usage.binding.id &&
        grant.use === usage.binding.use &&
        grant.resource === usage.resource &&
        grant.action === usage.action &&
        grantAppliesToIdentity(grant, identity)
    );
  }

  function persistentCredentialUseGrants(credential: Credential): CredentialUseGrant[] {
    const credentialId = credential.id ?? credential.connectionId;
    if (credentialUseGrantStore && credentialId) {
      return credentialUseGrantStore.list(credentialId);
    }
    return credential.grants ?? [];
  }

  async function persistCredentialUseGrant(
    credential: Credential & { id: string },
    grant: CredentialUseGrant,
    now: number
  ): Promise<void> {
    if (credentialUseGrantStore) {
      await credentialUseGrantStore.upsert(credential.id, grant);
      return;
    }
    const grants = upsertCredentialUseGrant(credential.grants ?? [], grant);
    credential.grants = grants;
    await credentialStore.saveUrlBound({
      ...credential,
      grants,
      metadata: {
        ...(credential.metadata ?? {}),
        updatedAt: String(now),
      },
    } as Credential & { id: string });
  }

  const definition: ServiceDefinition = {
    name: "credentials",
    description: "URL-bound userland credential storage and egress",
    authority: { principals: ["user", "code", "host"] },
    methods: credentialsMethods,
    handler: defineServiceHandler("credentials", credentialsMethods, {
      storeCredential: (ctx, [input]) => storeCredential(ctx, input),
      connect: (ctx, [input]) => connectionCoordinator.connect(ctx, input),
      configureClient: (ctx, [input]) => configureClient(ctx, input),
      requestCredentialInput: (ctx, [input]) => requestCredentialInput(ctx, input),
      getClientConfigStatus: (ctx, [input]) => getClientConfigStatus(ctx, input),
      deleteClientConfig: (ctx, [input]) => deleteClientConfig(ctx, input),
      forwardOAuthCallback: (ctx, [input]) =>
        connectionCoordinator.forwardOAuthCallback(ctx, input),
      cancelOAuth: (ctx, [input]) => connectionCoordinator.cancelOAuth(ctx, input),
      listStoredCredentials: () => listStoredCredentials(),
      inspectStoredCredentials: () => inspectStoredCredentials(),
      revokeCredential: (ctx, [input]) => revokeCredential(ctx, input),
      resolveCredential: (ctx, [input]) => resolveCredential(ctx, input),
      proxyFetch: (ctx, [input]) => proxyFetch(ctx, input),
      proxyGitHttp: (ctx, [input]) => proxyGitHttp(ctx, input),
      completeCapture: (ctx, [captureId, response]) => {
        // Only the attached desktop shell may answer a capture request.
        if (ctx.caller.runtime.kind !== "shell") {
          throw new Error("credentials.completeCapture is shell-only");
        }
        if (!deps.completeCapture) {
          throw new Error("Session credential capture is not configured on this server");
        }
        deps.completeCapture(captureId, response);
      },
      audit: (_ctx, [input]) => audit(input),
    }),
  };

  // The home server has NO public inbound HTTP surface post-WebRTC cutover, so
  // there is no server-hosted `/oauth/callback` route: desktop callbacks arrive
  // over the authenticated backhaul, mobile over the pipe, and co-located
  // loopback via the connection coordinator's ephemeral HTTP server.
  const routes: ServiceRouteDecl[] = [];

  return Object.assign(definition, {
    routes,
    resolveRelayOAuthCallback: connectionCoordinator.resolveRelayOAuthCallback,
  });
}

function summarizeUrlBoundCredential(credential: Credential): StoredCredentialSummary {
  const bindings = credentialBindings(credential);
  const primaryBinding = bindings.find((binding) => binding.use === "fetch") ?? bindings[0];
  if (!credential.id || !credential.label || !primaryBinding) {
    throw new Error("Stored credential is missing URL-bound metadata");
  }
  return {
    id: credential.id,
    label: credential.label,
    accountIdentity: credential.accountIdentity,
    audience: primaryBinding.audience,
    injection: primaryBinding.injection,
    bindings,
    owner: credential.owner,
    scopes: credential.scopes,
    lifecycle: credentialLifecycle(credential),
    expiresAt: credential.expiresAt,
    revokedAt: credential.revokedAt,
    metadata: credential.metadata,
  };
}

function normalizeCredentialBindings(
  bindings: readonly CredentialBinding[] | undefined,
  fallback: { audience: UrlAudience[]; injection: CredentialBinding["injection"] }
): CredentialBinding[] {
  if (!fallback.audience || !fallback.injection) {
    throw new Error("Credential fallback binding is missing URL-bound metadata");
  }
  const rawBindings = bindings?.length
    ? bindings
    : [
        {
          id: "fetch",
          use: "fetch" as const,
          audience: fallback.audience,
          injection: fallback.injection,
        },
      ];
  return rawBindings.map((binding) => ({
    id: binding.id,
    ...(binding.label ? { label: binding.label } : {}),
    use: binding.use,
    audience: normalizeUrlAudiences(binding.audience),
    injection: normalizeCredentialInjection(binding.injection),
    ...(binding.grantResource
      ? { grantResource: normalizeCredentialGrantResourceHint(binding.grantResource) }
      : {}),
  }));
}

function normalizeCredentialGrantResourceHint(
  hint: NonNullable<CredentialBinding["grantResource"]>
): NonNullable<CredentialBinding["grantResource"]> {
  if (hint.type === "audience") {
    return { type: "audience" };
  }
  if (
    hint.type === "url-path-prefix" &&
    Number.isInteger(hint.segmentCount) &&
    hint.segmentCount >= 1 &&
    hint.segmentCount <= 8
  ) {
    return { type: "url-path-prefix", segmentCount: hint.segmentCount };
  }
  throw new Error("Credential binding grantResource is invalid");
}

function credentialBindings(credential: Credential): CredentialBinding[] {
  if (credential.bindings?.length) {
    return credential.bindings;
  }
  return [];
}

function findCredentialBinding(
  credential: Credential,
  targetUrl: URL,
  use: CredentialBindingUse
): CredentialBinding | null {
  return (
    credentialBindings(credential).find(
      (binding) => binding.use === use && !!findMatchingUrlAudience(targetUrl, binding.audience)
    ) ?? null
  );
}

function credentialUseContext(
  credential: Credential,
  targetUrl: URL,
  use: CredentialBindingUse
): CredentialUseContext | null {
  const binding = findCredentialBinding(credential, targetUrl, use);
  if (!binding) {
    return null;
  }
  const resource =
    binding.use === "git-http" || binding.use === "git-ssh"
      ? gitRemoteFromUrl(targetUrl)
      : credentialBindingResource(binding, targetUrl);
  const gitOperation =
    binding.use === "git-http" || binding.use === "git-ssh"
      ? describeGitHttpOperation(targetUrl, "GET")
      : undefined;
  const action: CredentialGrantAction = gitOperation?.action ?? "use";
  return {
    binding,
    resource,
    action,
    sessionResource: {
      bindingId: binding.id,
      resource,
      action,
    },
    gitOperation,
  };
}

function credentialBindingResource(binding: CredentialBinding, targetUrl: URL): string {
  if (binding.grantResource?.type === "url-path-prefix") {
    return urlPathPrefixResource(targetUrl, binding.grantResource.segmentCount);
  }
  return findMatchingUrlAudience(targetUrl, binding.audience)?.url ?? targetUrl.origin;
}

function urlPathPrefixResource(targetUrl: URL, segmentCount: number): string {
  const resource = new URL(targetUrl.origin);
  const segments = targetUrl.pathname.split("/").filter(Boolean).slice(0, segmentCount);
  resource.pathname = segments.length ? `/${segments.join("/")}/` : "/";
  return resource.toString();
}

function preapprovedUseContextsForBinding(binding: CredentialBinding): CredentialUseContext[] {
  return binding.audience.map((audience) => {
    const action: CredentialGrantAction =
      binding.use === "git-http" || binding.use === "git-ssh" ? "read" : "use";
    return {
      binding,
      resource: audience.url,
      action,
      sessionResource: {
        bindingId: binding.id,
        resource: audience.url,
        action,
      },
      gitOperation: undefined,
    };
  });
}

function describeGitHttpOperation(
  targetUrl: URL,
  method: string
): CredentialUseContext["gitOperation"] {
  const service =
    targetUrl.searchParams.get("service") ?? gitHostServiceFromPath(targetUrl.pathname);
  const action = service === "git-receive-pack" ? "write" : "read";
  return {
    action,
    label: action === "write" ? "git push" : gitReadLabel(service, method),
    remote: gitRemoteFromUrl(targetUrl),
    service: service ?? undefined,
  };
}

function gitHostServiceFromPath(pathname: string): string | null {
  if (pathname.endsWith("/git-receive-pack")) return "git-receive-pack";
  if (pathname.endsWith("/git-upload-pack")) return "git-upload-pack";
  return null;
}

function gitReadLabel(service: string | null, method: string): string {
  if (service === "git-upload-pack") {
    return method.toUpperCase() === "POST" ? "git fetch" : "git clone or pull";
  }
  return "git clone or pull";
}

function gitRemoteFromUrl(targetUrl: URL): string {
  const remote = new URL(targetUrl.origin);
  let pathname = targetUrl.pathname;
  pathname = pathname.replace(/\/(?:info\/refs|git-upload-pack|git-receive-pack)$/, "");
  remote.pathname = pathname || "/";
  return remote.toString();
}

function grantForDecision(
  identity: { repoPath: string; effectiveVersion: string },
  decision: Exclude<GrantedDecision, "deny" | "once" | "session">,
  grantedAt: number,
  usage: CredentialUseContext
): CredentialUseGrant {
  const base = {
    bindingId: usage.binding.id,
    use: usage.binding.use,
    resource: usage.resource,
    action: usage.action,
    grantedAt,
    grantedBy: decision,
  };
  return {
    ...base,
    scope: "version",
    repoPath: identity.repoPath,
    effectiveVersion: identity.effectiveVersion,
  };
}

function upsertCredentialUseGrant(
  grants: CredentialUseGrant[],
  grant: CredentialUseGrant
): CredentialUseGrant[] {
  return [
    ...grants.filter((entry) => credentialUseGrantKey(entry) !== credentialUseGrantKey(grant)),
    grant,
  ];
}

function credentialUseGrantKey(grant: CredentialUseGrant): string {
  return [
    grant.bindingId,
    grant.use,
    grant.resource,
    grant.action,
    grant.scope,
    grant.repoPath,
    grant.effectiveVersion,
  ].join("\x00");
}

function grantAppliesToIdentity(
  grant: CredentialUseGrant,
  identity: { repoPath: string; effectiveVersion: string }
): boolean {
  return (
    grant.repoPath === identity.repoPath && grant.effectiveVersion === identity.effectiveVersion
  );
}

function hasOAuthAudienceDomainMismatch(
  audiences: readonly { url: string }[],
  oauthOrigins: readonly (string | undefined)[]
): boolean | undefined {
  const oauthDomains = oauthOrigins
    .filter((origin): origin is string => typeof origin === "string" && origin.length > 0)
    .map(registrableDomainForUrl)
    .filter((domain): domain is string => !!domain);
  if (oauthDomains.length === 0) {
    return undefined;
  }
  const audienceDomains = audiences
    .map((audience) => registrableDomainForUrl(audience.url))
    .filter((domain): domain is string => !!domain);
  if (audienceDomains.length === 0) {
    return undefined;
  }
  return oauthDomains.some((oauthDomain) => !audienceDomains.includes(oauthDomain));
}

function normalizedAudienceKey(audience: readonly UrlAudience[]): string {
  return normalizeUrlAudiences(audience)
    .map((entry) => `${entry.match}:${entry.url}`)
    .sort()
    .join("|");
}

function registrableDomainForUrl(raw: string): string | null {
  try {
    const hostname = new URL(raw).hostname.toLowerCase();
    if (hostname === "localhost" || /^[\d.]+$/.test(hostname) || hostname.includes(":")) {
      return hostname;
    }
    const parts = hostname.split(".").filter(Boolean);
    return parts.length >= 2 ? parts.slice(-2).join(".") : hostname;
  } catch {
    return null;
  }
}
