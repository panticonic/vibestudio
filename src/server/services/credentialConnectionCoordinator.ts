import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import * as http from "node:http";
import { createDevLogger } from "@vibestudio/dev-log";
import type { EventName, EventPayloads, EventService } from "@vibestudio/shared/eventsService";
import type { ClientConfigRecord } from "@vibestudio/credential-client/clientConfigStore";
import type { CredentialStore } from "@vibestudio/credential-client/store";
import type {
  AccountIdentity,
  ConnectCredentialRequest,
  Credential,
  CredentialAuditEvent,
  CredentialBinding,
  CredentialFlowType,
  ForwardOAuthCallbackRequest,
  OAuthAccountValidationSpec,
  OAuthConnectionErrorCode,
  OAuthConnectionTransactionState,
  OAuthRefreshRecipe,
  OAuthTokenAuthMethod,
  StoredCredentialSummary,
  UrlAudience,
} from "@vibestudio/credential-client/types";
import {
  normalizeCredentialInjection,
  normalizeUrlAudiences,
} from "@vibestudio/credential-client/urlAudience";
import type { CallerKind, ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import {
  ConnectCredentialParamsSchema,
  type ConnectCredentialParams,
  type ForwardOAuthCallbackParams,
  type StoreUrlBoundCredentialParams,
} from "@vibestudio/service-schemas/credentials";
import type { ApprovalQueue, GrantedDecision } from "./approvalQueue.js";
import { CredentialLifecycleError } from "./credentialLifecycle.js";
import { abortable, anySignal, delay, throwIfAborted } from "./credentialMechanisms/async.js";
import {
  renderApiKeyMaterialTemplate,
  validateApiKeyMaterialTemplate,
} from "./credentialMechanisms/apiKey.js";
import { OAuthConnectionError, oauthConnectionError } from "./credentialMechanisms/errors.js";
import { oauth1AuthorizationHeader } from "./credentialMechanisms/oauth1.js";
import {
  applyOAuthClientAssertion,
  basicAuthHeader,
  signJwtAssertion,
} from "./credentialMechanisms/oauth2.js";
import { openSshEd25519PublicKey, sshPublicKeyFingerprint } from "./credentialMechanisms/ssh.js";
import {
  deriveAccountIdentityFromJwt,
  normalizeAccountIdentity,
  parseBearerTokenResponse,
  readNumericField,
  readStringClaim,
} from "./credentialMechanisms/tokens.js";
import {
  buildCredentialRuntimeIndex,
  findNearestCredentialPanelEntity,
  resolvePanelSlotForCredentialEntity,
  type CredentialRuntimeInspector,
} from "./credentialRuntimeContext.js";
import {
  canonicalCredentialUrl as canonicalUrl,
  validateCredentialClientConfigUrls as validateClientConfigUrls,
} from "./credentialClientConfig.js";
import { getRelayOrigin, RELAY_URL_ENV } from "./relayBackhaulClient.js";

const log = createDevLogger("CredentialConnectionCoordinator");
type BrowserHandoffCallerKind = "app" | "panel" | "shell";
type BrowserDeliveryCallerKind = "app" | "shell";
type BrowserHandoffOwnerLookupStatus =
  | "not-required"
  | "not-configured"
  | "found"
  | "missing"
  | "unsupported-kind";

interface BrowserHandoffTarget {
  deliveryCallerId: string;
  deliveryCallerKind: BrowserDeliveryCallerKind;
  deliveryConnectionId?: string;
  parentPanelId?: string;
}

interface BrowserHandoffDiagnostics {
  requestCallerId: string;
  requestCallerKind: string;
  targetCallerId: string;
  targetCallerKind: string;
  ownerLookup: BrowserHandoffOwnerLookupStatus;
  deliveryCallerId?: string;
  deliveryCallerKind?: BrowserDeliveryCallerKind;
  deliveryConnectionId?: string;
}

interface BrowserHandoffResolution {
  target: BrowserHandoffTarget | null;
  diagnostics: BrowserHandoffDiagnostics;
}

type BrowserHandoffDeliveryAttempt =
  | "event-service-missing"
  | "emit-to-caller"
  | "emit-to-connection";

interface BrowserHandoffDeliveryResult {
  delivered: boolean;
  attempt: BrowserHandoffDeliveryAttempt;
  connectionDelivered?: boolean;
  callerDelivered?: boolean;
}

type OAuthRedirectStrategy =
  | "loopback"
  | "public"
  | "client-forwarded"
  | "client-loopback"
  | "app-scheme";

/** Maximum lifetime for a pending interactive OAuth transaction. */
const PENDING_OAUTH_TTL_MS = 10 * 60 * 1000;
const OAUTH_USERINFO_TIMEOUT_MS = 15_000;
const DEFAULT_LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_CALLBACK_PATH = "/oauth/callback";
/**
 * Canonical relay OAuth callback path. The transactionId is carried as the
 * trailing path SEGMENT (`/oauth/callback/<transactionId>`), which is the single
 * shape the relay routes (`/oauth/callback*`), the AASA/assetlinks claim
 * (`/oauth/callback/*`), and the relay landing resolves. Server, relay, and the
 * mobile deep-link handler all agree on exactly this path.
 */
const RELAY_OAUTH_CALLBACK_PATH = "/oauth/callback";
const CLIENT_LOOPBACK_TIMEOUT_SKEW_MS = 5_000;
const RESERVED_OAUTH_AUTHORIZE_PARAMS = new Set([
  "client_id",
  "code_challenge",
  "code_challenge_method",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
]);

type AuthCodeConnectRequest = {
  flow: {
    authorizeUrl?: string;
    tokenUrl?: string;
    clientId?: string;
    clientConfigId?: string;
    scopes?: string[];
    extraAuthorizeParams?: Record<string, string>;
    allowMissingExpiry?: boolean;
    persistRefreshToken?: boolean;
    accountValidation?: OAuthAccountValidationSpec;
    revocationUrl?: string;
  };
  credential: ConnectCredentialRequest["credential"];
  redirect?: ConnectCredentialRequest["redirect"];
  browser?: ConnectCredentialRequest["browser"];
  tokenAuth?: "none" | "client_secret_post" | "client_secret_basic" | "private_key_jwt";
};
type InternalOAuthConnectionRequest = {
  flow: {
    authorizeUrl: string;
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    privateKeyPem?: string;
    keyId?: string;
    keyAlgorithm?: string;
    scopes?: string[];
    extraAuthorizeParams?: Record<string, string>;
    allowMissingExpiry?: boolean;
    persistRefreshToken?: boolean;
    accountValidation?: AuthCodeConnectRequest["flow"]["accountValidation"];
    revocationUrl?: string;
  };
  credential: ConnectCredentialRequest["credential"];
  redirectUri: string;
  tokenAuth: OAuthTokenAuthMethod;
  clientConfig?: OAuthRefreshRecipe["clientConfig"];
};

type StoredOAuthCredentialParams = StoreUrlBoundCredentialParams & {
  refreshToken?: string;
  oauthRefresh?: OAuthRefreshRecipe;
};

export interface SessionCredentialCapture {
  captureCookies(params: {
    signInUrl: string;
    origins: string[];
    cookieNames: string[];
    completionUrlPattern?: string;
    maxTtlSeconds?: number;
    browser?: "internal" | "external";
    signal?: AbortSignal;
  }): Promise<{
    cookieHeader: string;
    cookieSession?: Credential["cookieSession"];
    expiresAt?: number;
    accountIdentity?: Partial<AccountIdentity>;
  }>;
  captureSamlSession?(params: {
    signInUrl: string;
    spAudience: string;
    cookieNames?: string[];
    assertion?: {
      issuer: string;
      audience: string;
      recipient: string;
      persistAssertion?: boolean;
    };
    completionUrlPattern?: string;
    maxTtlSeconds?: number;
    browser?: "internal" | "external";
    signal?: AbortSignal;
  }): Promise<{
    cookieHeader?: string;
    cookieSession?: Credential["cookieSession"];
    assertion?: string;
    expiresAt?: number;
    accountIdentity?: Partial<AccountIdentity>;
  }>;
}

interface OAuthConnectionTransaction {
  id: string;
  state: OAuthConnectionTransactionState;
  createdAt: number;
  expiresAt: number;
  callerId: string;
  callerKind: CallerKind;
  repoPath: string;
  effectiveVersion: string;
  stateParam: string;
  redirectUri: string;
  redirectStrategy: OAuthRedirectStrategy;
  deliveryCallerId?: string;
  deliveryCallerKind?: BrowserDeliveryCallerKind;
  callbackUsed: boolean;
  resolve: (value: { code: string; state: string; url: string }) => void;
  reject: (error: Error) => void;
  wait: Promise<{ code: string; state: string; url: string }>;
  timer: NodeJS.Timeout;
}

export interface CredentialConnectionCoordinatorDeps {
  credentialStore: Pick<CredentialStore, "loadUrlBound" | "saveUrlBound">;
  clientConfigStore: {
    load(configId: string): Promise<ClientConfigRecord | null>;
  };
  approvalQueue?: ApprovalQueue;
  eventService?: Pick<EventService, "emitToCaller" | "emitToConnection">;
  connectionLookup?: {
    getAuthorizingShell(principalId: string): {
      caller: { runtime: { id: string; kind: string } };
      connectionId: string;
    } | null;
  };
  sessionCredentialCapture?: SessionCredentialCapture;
  runtimeInspector?: CredentialRuntimeInspector;
  relayOAuthRegistrar?: {
    register(transactionId: string, platform: "mobile" | "desktop"): void;
  };
  storeCredential(
    ctx: ServiceContext,
    params: StoredOAuthCredentialParams,
    options?: {
      approvalDecision?: Exclude<GrantedDecision, "deny">;
      preapprovedUseDecision?: Exclude<GrantedDecision, "deny">;
      replaceCredentialId?: string;
      replacementCredentialLabel?: string;
    }
  ): Promise<StoredCredentialSummary>;
  resolveApprovalIdentity(ctx: ServiceContext): {
    callerId: string;
    repoPath: string;
    effectiveVersion: string;
  };
  requestCredentialApproval(
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
  ): Promise<Exclude<GrantedDecision, "deny">>;
  loadActiveCredential(credentialId: string): Promise<Credential & { id: string }>;
  authorizeCredentialSubjectUse(
    ctx: ServiceContext,
    credential: Credential & { id: string }
  ): Promise<void>;
  findReplacementCandidate(
    ctx: ServiceContext,
    candidate: {
      label: string;
      audience: UrlAudience[];
      metadata?: Record<string, string>;
      accountIdentity: Partial<AccountIdentity>;
    }
  ): Promise<(Credential & { id: string }) | null>;
  validateCredentialBindings(
    bindings: readonly CredentialBinding[] | undefined,
    fallback: { audience: UrlAudience[]; injection: CredentialBinding["injection"] }
  ): void;
  appendAudit(entry: CredentialAuditEvent): Promise<void>;
}

export interface CredentialConnectionCoordinator {
  connect(ctx: ServiceContext, params: ConnectCredentialParams): Promise<StoredCredentialSummary>;
  forwardOAuthCallback(ctx: ServiceContext, request: ForwardOAuthCallbackRequest): Promise<void>;
  cancelOAuth(ctx: ServiceContext, request: { transactionId: string }): Promise<void>;
  resolveRelayOAuthCallback(frame: {
    transactionId: string;
    state?: string;
    code?: string;
    error?: string;
  }): Promise<void>;
}

export function createCredentialConnectionCoordinator(
  deps: CredentialConnectionCoordinatorDeps
): CredentialConnectionCoordinator {
  const {
    approvalQueue,
    clientConfigStore,
    connectionLookup,
    credentialStore,
    eventService,
    findReplacementCandidate,
    loadActiveCredential,
    requestCredentialApproval,
    resolveApprovalIdentity,
    runtimeInspector,
    sessionCredentialCapture,
    storeCredential,
    authorizeCredentialSubjectUse,
    appendAudit,
  } = deps;
  const oauthTransactions = new Map<string, OAuthConnectionTransaction>();

  function oauthRefreshMaterial(params: {
    refreshToken: string | undefined;
    tokenUrl: string;
    clientId: string;
    tokenAuth: OAuthTokenAuthMethod;
    clientConfig?: OAuthRefreshRecipe["clientConfig"];
  }): Pick<Credential, "oauthRefresh" | "refreshToken"> {
    if (!params.refreshToken) return {};
    if (params.tokenAuth !== "none" && !params.clientConfig) {
      throw new OAuthConnectionError(
        "client_config_unavailable",
        "OAuth refresh with client authentication requires an exact client config version"
      );
    }
    return {
      refreshToken: params.refreshToken,
      oauthRefresh: {
        tokenUrl: canonicalUrl(params.tokenUrl),
        clientId: params.clientId,
        tokenAuth: params.tokenAuth,
        ...(params.clientConfig ? { clientConfig: params.clientConfig } : {}),
      },
    };
  }

  function grantedOAuthScopes(params: {
    tokenScopes: string[] | undefined;
    requestedScopes: string[] | undefined;
    declaredScopes: string[] | undefined;
  }): string[] {
    // RFC 6749: when the token response omits `scope`, it is identical to the
    // requested scope. A returned scope is the provider's authoritative grant.
    return params.tokenScopes ?? params.requestedScopes ?? params.declaredScopes ?? [];
  }

  function validateOAuthCredentialRequest(
    request: InternalOAuthConnectionRequest,
    redirectStrategy: OAuthRedirectStrategy
  ): void {
    validateClientConfigUrls(
      canonicalUrl(request.flow.authorizeUrl),
      canonicalUrl(request.flow.tokenUrl)
    );
    const redirect = new URL(request.redirectUri);
    const validRedirect =
      (redirect.protocol === "http:" && isLoopbackHost(redirect.hostname)) ||
      redirect.protocol === "https:" ||
      (redirectStrategy === "app-scheme" && isAppSchemeOAuthRedirect(redirect));
    if (!validRedirect) {
      throw new Error(
        "OAuth redirectUri must be host-created loopback HTTP, public HTTPS, or vibestudio app-scheme OAuth"
      );
    }
    if (redirect.hash || redirect.search) {
      throw new Error("OAuth redirectUri must not include query parameters or a fragment");
    }
    const audience = normalizeUrlAudiences(request.credential.audience);
    const injection = normalizeCredentialInjection(request.credential.injection);
    if (injection.type !== "header") {
      throw new Error("OAuth credentials only support constrained header injection");
    }
    deps.validateCredentialBindings(request.credential.bindings, { audience, injection });
    if (request.flow.accountValidation?.userinfo?.url) {
      const userinfo = new URL(request.flow.accountValidation.userinfo.url);
      if (userinfo.protocol !== "https:") {
        throw new Error("OAuth userinfo url must use https");
      }
      if (userinfo.hash) {
        throw new Error("OAuth userinfo url must not include a fragment");
      }
    }
  }

  /**
   * Decide which redirect strategy to use when the caller doesn't specify one.
   *
   * After the WebRTC cutover the server has no public origin, so every remote
   * platform routes OAuth through the public callback relay (§7). The parity rule
   * means desktop and mobile share that one relay path rather than special-casing
   * desktop loopback, so the default is "public" — which now points the IdP at the
   * relay host (see buildRelayOAuthCallbackUrl), not the server's own URL. Genuinely
   * co-located callers may still request "loopback"/"client-loopback" explicitly.
   */
  function resolveDefaultRedirectStrategy(
    requested: OAuthRedirectStrategy | undefined
  ): OAuthRedirectStrategy {
    if (requested) return requested;
    // The "public" default routes the IdP through the callback relay (parity: desktop
    // + mobile share it). But the relay is optional — `pnpm dev` sets no
    // VIBESTUDIO_RELAY_URL — and "public" then throws redirect_unavailable on
    // every connect that doesn't pass an explicit redirect. Fall back to loopback when
    // no relay is configured so co-located dev OAuth works; production configures the
    // relay and keeps the parity path. (Remote sessions still need the relay set — a
    // server-loopback redirect is unreachable from a remote browser by design.)
    return getRelayOrigin() ? "public" : "loopback";
  }

  /**
   * Build the OAuth `redirect_uri` that lands on the public callback RELAY (§7).
   *
   * The server has no public URL of its own; the IdP redirects to
   * `<relay>/oauth/callback/<transactionId>`, and the relay does a
   * transactionId-keyed handoff back to the live server — mobile via App-Links
   * deep-link (the app forwards over the pipe), desktop via the authenticated
   * backhaul. Carrying the transactionId in the PATH (not a query param) is what
   * lets the relay landing resolve the transaction AND lets the mobile OS
   * deep-link match the `/oauth/callback/*` App-Link component. PKCE keeps the
   * relay harmless: the `codeVerifier` never leaves this server.
   *
   * Fails loud when unconfigured rather than silently falling back to a server URL
   * that no third party can reach.
   */
  function buildRelayOAuthCallbackUrl(transactionId: string): string {
    const base = getRelayOrigin();
    if (!base) {
      throw new OAuthConnectionError(
        "redirect_unavailable",
        `OAuth callback relay is not configured — set ${RELAY_URL_ENV} to the relay origin.`
      );
    }
    return `${base}${RELAY_OAUTH_CALLBACK_PATH}/${encodeURIComponent(transactionId)}`;
  }

  function isLoopbackHost(hostname: string): boolean {
    const host = hostname.toLowerCase();
    if (host === "localhost" || host === "::1" || host === "[::1]") {
      return true;
    }
    const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    return !!ipv4 && Number(ipv4[1]) === 127;
  }

  function buildClientLoopbackRedirectUri(
    redirect: NonNullable<ConnectCredentialRequest["redirect"]>
  ): string {
    const host = redirect.host ?? "localhost";
    if (host !== "localhost" && host !== "127.0.0.1") {
      throw new OAuthConnectionError(
        "redirect_unavailable",
        "client-loopback redirects require localhost or 127.0.0.1"
      );
    }
    const port = redirect.port;
    if (!port || port < 1 || port > 65535) {
      throw new OAuthConnectionError(
        "redirect_unavailable",
        "client-loopback redirects require a fixed port"
      );
    }
    const callbackPath = normalizeCallbackPath(redirect.callbackPath ?? DEFAULT_CALLBACK_PATH);
    return `http://${host}:${port}${callbackPath}`;
  }

  function buildAppSchemeRedirectUri(
    redirect: NonNullable<ConnectCredentialRequest["redirect"]>,
    request: AuthCodeConnectRequest
  ): string {
    if (redirect.callbackUri) {
      const uri = new URL(redirect.callbackUri);
      if (!isAppSchemeOAuthRedirect(uri) || uri.search || uri.hash) {
        throw new OAuthConnectionError(
          "redirect_unavailable",
          "app-scheme OAuth redirects must be vibestudio://oauth/callback/<provider> without query or fragment"
        );
      }
      return uri.toString();
    }
    const provider = oauthProviderSlugForRequest(request);
    return `vibestudio://oauth/callback/${provider}`;
  }

  function isAppSchemeOAuthRedirect(uri: URL): boolean {
    if (uri.protocol !== "vibestudio:" || uri.hostname !== "oauth") return false;
    if (!uri.pathname.startsWith("/callback/")) return false;
    const provider = uri.pathname.slice("/callback/".length).replace(/\/+$/, "");
    return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(provider) && !provider.includes("/");
  }

  function oauthProviderSlugForRequest(request: AuthCodeConnectRequest): string {
    const candidates = [
      request.credential.metadata?.["modelProviderId"],
      request.credential.metadata?.["providerId"],
      request.flow.clientConfigId,
      request.credential.label,
    ];
    for (const candidate of candidates) {
      const slug = String(candidate ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 64);
      if (slug && /^[a-z0-9]/.test(slug)) return slug;
    }
    return "credential";
  }

  function buildClientLoopbackHandoff(
    tx: OAuthConnectionTransaction,
    state: string
  ): {
    transactionId: string;
    redirectUri: string;
    host: "localhost" | "127.0.0.1";
    port: number;
    callbackPath: string;
    state: string;
    timeoutMs: number;
  } {
    const redirect = new URL(tx.redirectUri);
    const host = redirect.hostname;
    if (host !== "localhost" && host !== "127.0.0.1") {
      throw new OAuthConnectionError(
        "redirect_unavailable",
        "client-loopback handoff has an invalid host"
      );
    }
    return {
      transactionId: tx.id,
      redirectUri: tx.redirectUri,
      host,
      port: Number(redirect.port),
      callbackPath: redirect.pathname,
      state,
      timeoutMs: Math.max(1_000, tx.expiresAt - Date.now() - CLIENT_LOOPBACK_TIMEOUT_SKEW_MS),
    };
  }

  function buildAppSchemeHandoff(
    tx: OAuthConnectionTransaction,
    state: string
  ): {
    transactionId: string;
    redirectUri: string;
    callbackScheme: "vibestudio";
    state: string;
    timeoutMs: number;
    prefersEphemeral: boolean;
  } {
    const timeoutMs = Math.max(1_000, tx.expiresAt - Date.now() - CLIENT_LOOPBACK_TIMEOUT_SKEW_MS);
    return {
      transactionId: tx.id,
      redirectUri: tx.redirectUri,
      callbackScheme: "vibestudio",
      state,
      timeoutMs,
      prefersEphemeral: false,
    };
  }

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

  async function resolveBrowserHandoffTarget(
    ctx: ServiceContext,
    handoffTarget?: { callerId: string; callerKind: BrowserHandoffCallerKind }
  ): Promise<BrowserHandoffResolution> {
    const targetCallerId = handoffTarget?.callerId ?? ctx.caller.runtime.id;
    const targetCallerKind = handoffTarget?.callerKind ?? ctx.caller.runtime.kind;
    const diagnosticsBase = {
      requestCallerId: ctx.caller.runtime.id,
      requestCallerKind: ctx.caller.runtime.kind,
      targetCallerId,
      targetCallerKind,
    };
    const resolved = (
      target: BrowserHandoffTarget,
      ownerLookup: BrowserHandoffOwnerLookupStatus
    ): BrowserHandoffResolution => ({
      target,
      diagnostics: {
        ...diagnosticsBase,
        ownerLookup,
        deliveryCallerId: target.deliveryCallerId,
        deliveryCallerKind: target.deliveryCallerKind,
        deliveryConnectionId: target.deliveryConnectionId,
      },
    });
    if (targetCallerKind === "shell") {
      return resolved(
        {
          deliveryCallerId: targetCallerId,
          deliveryCallerKind: "shell",
          deliveryConnectionId:
            targetCallerId === ctx.caller.runtime.id ? ctx.connectionId : undefined,
        },
        "not-required"
      );
    }
    if (targetCallerKind === "app") {
      return resolved(
        {
          deliveryCallerId: targetCallerId,
          deliveryCallerKind: "app",
          deliveryConnectionId:
            targetCallerId === ctx.caller.runtime.id ? ctx.connectionId : undefined,
        },
        "not-required"
      );
    }
    if (targetCallerKind === "panel") {
      return resolvePanelBrowserHandoffTarget(targetCallerId, diagnosticsBase, targetCallerId);
    }
    if (!handoffTarget && (targetCallerKind === "worker" || targetCallerKind === "do")) {
      return resolveRuntimeParentBrowserHandoffTarget(ctx, diagnosticsBase);
    }
    return {
      target: null,
      diagnostics: { ...diagnosticsBase, ownerLookup: "unsupported-kind" },
    };
  }

  async function resolveRuntimeParentBrowserHandoffTarget(
    ctx: ServiceContext,
    diagnosticsBase: Omit<
      BrowserHandoffDiagnostics,
      "ownerLookup" | "deliveryCallerId" | "deliveryCallerKind" | "deliveryConnectionId"
    >
  ): Promise<BrowserHandoffResolution> {
    const runtimeIndex = await buildCredentialRuntimeIndex(runtimeInspector);
    const entity = runtimeIndex.entitiesById.get(ctx.caller.runtime.id) ?? null;
    const panelEntity = entity ? findNearestCredentialPanelEntity(entity, runtimeIndex) : null;
    if (!panelEntity) {
      return {
        target: null,
        diagnostics: { ...diagnosticsBase, ownerLookup: "missing" },
      };
    }
    const parentPanelId =
      (await resolvePanelSlotForCredentialEntity(panelEntity.id, runtimeIndex, runtimeInspector)) ??
      panelEntity.id;
    return resolvePanelBrowserHandoffTarget(panelEntity.id, diagnosticsBase, parentPanelId);
  }

  function resolvePanelBrowserHandoffTarget(
    targetCallerId: string,
    diagnosticsBase: Omit<
      BrowserHandoffDiagnostics,
      "ownerLookup" | "deliveryCallerId" | "deliveryCallerKind" | "deliveryConnectionId"
    >,
    parentPanelId: string
  ): BrowserHandoffResolution {
    const resolved = (
      target: BrowserHandoffTarget,
      ownerLookup: BrowserHandoffOwnerLookupStatus
    ): BrowserHandoffResolution => ({
      target,
      diagnostics: {
        ...diagnosticsBase,
        ownerLookup,
        deliveryCallerId: target.deliveryCallerId,
        deliveryCallerKind: target.deliveryCallerKind,
        deliveryConnectionId: target.deliveryConnectionId,
      },
    });
    const shellConnection = connectionLookup?.getAuthorizingShell(targetCallerId);
    if (!shellConnection) {
      const ownerCallerId = !connectionLookup ? targetCallerId : undefined;
      if (!ownerCallerId) {
        return {
          target: null,
          diagnostics: { ...diagnosticsBase, ownerLookup: "missing" },
        };
      }
      return resolved(
        {
          deliveryCallerId: ownerCallerId,
          deliveryCallerKind: "shell",
          parentPanelId,
        },
        "not-configured"
      );
    }
    return resolved(
      {
        deliveryCallerId: shellConnection.caller.runtime.id,
        deliveryCallerKind: "shell",
        deliveryConnectionId: shellConnection.connectionId,
        parentPanelId,
      },
      "found"
    );
  }

  function emitToBrowserTarget<E extends EventName>(
    target: { deliveryCallerId: string; deliveryConnectionId?: string },
    event: E,
    payload?: EventPayloads[E]
  ): BrowserHandoffDeliveryResult {
    if (!eventService) {
      return { delivered: false, attempt: "event-service-missing" };
    }
    if (!target.deliveryConnectionId) {
      const delivered = eventService.emitToCaller(target.deliveryCallerId, event, payload);
      return { delivered, attempt: "emit-to-caller", callerDelivered: delivered };
    }
    const delivered = eventService.emitToConnection(
      target.deliveryCallerId,
      target.deliveryConnectionId,
      event,
      payload
    );
    return {
      delivered,
      attempt: "emit-to-connection",
      connectionDelivered: delivered,
    };
  }

  function browserHandoffUnavailableMessage(
    diagnostics: BrowserHandoffDiagnostics,
    delivery?: BrowserHandoffDeliveryResult
  ): string {
    const parts = [
      "OAuth browser handoff target is not connected",
      `request=${diagnostics.requestCallerKind}:${diagnosticRuntimeId(diagnostics.requestCallerId)}`,
      `target=${diagnostics.targetCallerKind}:${diagnosticRuntimeId(diagnostics.targetCallerId)}`,
      `ownerLookup=${diagnostics.ownerLookup}`,
    ];
    if (diagnostics.deliveryCallerId) {
      parts.push(
        `delivery=${diagnostics.deliveryCallerKind ?? "unknown"}:${diagnosticRuntimeId(
          diagnostics.deliveryCallerId
        )}`
      );
    }
    if (diagnostics.deliveryConnectionId) {
      parts.push(`connection=${diagnosticRuntimeId(diagnostics.deliveryConnectionId)}`);
    }
    if (delivery) {
      parts.push(`attempt=${delivery.attempt}`, `delivered=${String(delivery.delivered)}`);
      if (typeof delivery.connectionDelivered === "boolean") {
        parts.push(`connectionDelivered=${String(delivery.connectionDelivered)}`);
      }
      if (typeof delivery.callerDelivered === "boolean") {
        parts.push(`callerDelivered=${String(delivery.callerDelivered)}`);
      }
    }
    return parts.join("; ");
  }

  function diagnosticRuntimeId(value: string): string {
    if (!value) return "<none>";
    if (value.length <= 96) return value;
    return `${value.slice(0, 48)}...${value.slice(-16)}`;
  }

  function createOAuthAuthorizeRequest(
    request: InternalOAuthConnectionRequest,
    state: string
  ): { state: string; authorizeUrl: string; codeVerifier: string } {
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const authorizeUrl = new URL(request.flow.authorizeUrl);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", request.flow.clientId);
    authorizeUrl.searchParams.set("redirect_uri", request.redirectUri);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    authorizeUrl.searchParams.set("state", state);
    if (request.flow.scopes?.length) {
      authorizeUrl.searchParams.set("scope", request.flow.scopes.join(" "));
    }
    for (const [key, value] of Object.entries(request.flow.extraAuthorizeParams ?? {})) {
      if (RESERVED_OAUTH_AUTHORIZE_PARAMS.has(key.toLowerCase())) {
        throw new Error(`OAuth extraAuthorizeParams cannot override ${key}`);
      }
      authorizeUrl.searchParams.set(key, value);
    }
    return { state, authorizeUrl: authorizeUrl.toString(), codeVerifier };
  }

  async function forwardOAuthCallback(
    ctx: ServiceContext,
    params: ForwardOAuthCallbackParams
  ): Promise<void> {
    const request = params as ForwardOAuthCallbackRequest;
    const parsed = request.url ? new URL(request.url) : null;
    const callbackState = request.state ?? parsed?.searchParams.get("state") ?? undefined;
    const tx = request.transactionId
      ? oauthTransactions.get(request.transactionId)
      : findOAuthTransactionByState(callbackState);
    if (!tx) {
      throw new OAuthConnectionError("transaction_expired");
    }
    if (tx.redirectStrategy === "client-loopback") {
      if (!request.transactionId) {
        throw new OAuthConnectionError(
          "client_not_authorized",
          "client-loopback callbacks require a transaction id"
        );
      }
      if (
        tx.deliveryCallerId !== ctx.caller.runtime.id ||
        tx.deliveryCallerKind !== ctx.caller.runtime.kind
      ) {
        throw new OAuthConnectionError("client_not_authorized");
      }
    } else if (tx.redirectStrategy === "app-scheme") {
      if (!request.transactionId) {
        throw new OAuthConnectionError(
          "client_not_authorized",
          "app-scheme callbacks require a transaction id"
        );
      }
      if (
        tx.deliveryCallerId !== ctx.caller.runtime.id ||
        tx.deliveryCallerKind !== ctx.caller.runtime.kind
      ) {
        throw new OAuthConnectionError("client_not_authorized");
      }
    } else if (tx.redirectStrategy === "client-forwarded") {
      if (tx.callerId !== ctx.caller.runtime.id) {
        throw new OAuthConnectionError("client_not_authorized");
      }
    } else {
      throw new OAuthConnectionError("redirect_mismatch");
    }
    await receiveOAuthCallback(tx, {
      code: request.code ?? parsed?.searchParams.get("code"),
      state: callbackState,
      error: parsed?.searchParams.get("error"),
      url: request.url ?? tx.redirectUri,
    });
  }

  async function cancelOAuth(
    ctx: ServiceContext,
    request: { transactionId: string }
  ): Promise<void> {
    const tx = oauthTransactions.get(request.transactionId);
    if (!tx) return;
    const privileged = ctx.caller.runtime.kind === "shell" || ctx.caller.runtime.kind === "server";
    if (
      !privileged &&
      (tx.callerId !== ctx.caller.runtime.id || tx.callerKind !== ctx.caller.runtime.kind)
    ) {
      throw new OAuthConnectionError("client_not_authorized");
    }
    oauthTransactions.delete(tx.id);
    clearTimeout(tx.timer);
    await transitionOAuthTransaction(tx, "cancelled", "approval_denied");
    tx.reject(new OAuthConnectionError("approval_denied", "Sign-in cancelled"));
  }

  async function connectCredential(
    ctx: ServiceContext,
    params: ConnectCredentialParams
  ): Promise<StoredCredentialSummary> {
    const parsedParams = ConnectCredentialParamsSchema.parse(params);
    const { request, handoffTarget } = normalizeConnectInvocation(ctx, parsedParams);
    const dispatch = (signal?: AbortSignal): Promise<StoredCredentialSummary> => {
      switch (request.flow.type) {
        case "oauth2-auth-code-pkce":
          return connectOAuth2AuthCode(
            ctx,
            normalizePkceConnectRequest(request),
            handoffTarget,
            signal
          );
        case "oauth2-device-code":
          return connectOAuthDeviceCode(ctx, request, signal);
        case "oauth2-client-credentials":
          return connectOAuthClientCredentials(ctx, request);
        case "oauth2-jwt-bearer":
          return connectOAuthJwtBearer(ctx, request);
        case "oauth2-token-exchange":
          return connectOAuthTokenExchange(ctx, request);
        case "oauth1a":
          return connectOAuth1a(ctx, request, handoffTarget, signal);
        case "aws-sigv4":
          return connectAwsSigV4(ctx, request);
        case "ssh-key":
          return connectSshKey(ctx, request);
        case "browser-cookie-session":
          return connectBrowserCookieSession(ctx, request, signal);
        case "saml-browser-session":
          return connectSamlBrowserSession(ctx, request, signal);
        case "api-key":
          return connectApiKey(ctx, request);
        default:
          throw new OAuthConnectionError("unsupported_flow");
      }
    };
    return dispatch(ctx.signal);
  }

  function normalizeConnectInvocation(
    ctx: ServiceContext,
    params: ConnectCredentialParams
  ): {
    request: ConnectCredentialRequest;
    handoffTarget?: { callerId: string; callerKind: BrowserHandoffCallerKind };
  } {
    if ("spec" in params) {
      if (ctx.caller.runtime.kind === "panel") {
        throw new OAuthConnectionError(
          "client_not_authorized",
          "Panel callers cannot specify a credential browser handoff target"
        );
      }
      return {
        request: params.spec as ConnectCredentialRequest,
        handoffTarget: params.handoffTarget,
      };
    }
    return { request: params as ConnectCredentialRequest };
  }

  function normalizePkceConnectRequest(request: ConnectCredentialRequest): AuthCodeConnectRequest {
    const flow = request.flow;
    if (flow.type !== "oauth2-auth-code-pkce") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    if (flow.clientConfigId) {
      return {
        flow: {
          clientConfigId: flow.clientConfigId,
          scopes: flow.scopes,
          extraAuthorizeParams: flow.extraAuthorizeParams,
          allowMissingExpiry: flow.allowMissingExpiry,
          persistRefreshToken: flow.persistRefreshToken,
          accountValidation: flow.accountValidation,
          revocationUrl: flow.revocationUrl,
        },
        credential: request.credential,
        redirect: request.redirect,
        browser: request.browser,
        tokenAuth: flow.tokenAuth,
      };
    }
    if (flow.tokenAuth && flow.tokenAuth !== "none") {
      throw new OAuthConnectionError("unsupported_token_auth_method");
    }
    if (!flow.authorizeUrl || !flow.tokenUrl || !flow.clientId) {
      throw new OAuthConnectionError(
        "invalid_connection_spec",
        "oauth2-auth-code-pkce requires authorizeUrl, tokenUrl, and clientId or a clientConfigId"
      );
    }
    return {
      flow: {
        authorizeUrl: flow.authorizeUrl,
        tokenUrl: flow.tokenUrl,
        clientId: flow.clientId,
        scopes: flow.scopes,
        extraAuthorizeParams: flow.extraAuthorizeParams,
        allowMissingExpiry: flow.allowMissingExpiry,
        persistRefreshToken: flow.persistRefreshToken,
        accountValidation: flow.accountValidation,
        revocationUrl: flow.revocationUrl,
      },
      credential: request.credential,
      redirect: request.redirect,
      browser: request.browser,
      tokenAuth: flow.tokenAuth ?? "none",
    };
  }

  async function connectApiKey(
    ctx: ServiceContext,
    request: ConnectCredentialRequest
  ): Promise<StoredCredentialSummary> {
    if (request.flow.type !== "api-key") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    if (!approvalQueue || !isUserlandRuntimeCaller(ctx)) {
      throw new Error("Credential input approval is unavailable");
    }
    for (const field of request.flow.fields) {
      if (field.type !== "secret" || field.required !== true) {
        throw new OAuthConnectionError(
          "invalid_connection_spec",
          "api-key fields must be required secret fields"
        );
      }
    }
    const audience = normalizeUrlAudiences(request.credential.audience);
    const injection = normalizeCredentialInjection(request.credential.injection);
    const accountIdentity = normalizeAccountIdentity(
      request.credential.accountIdentity,
      ctx.caller.runtime.id
    );
    const identity = resolveApprovalIdentity(ctx);
    validateApiKeyMaterialTemplate(
      request.flow.materialTemplate.valueTemplate,
      request.flow.fields.map((field) => field.name)
    );
    const result = await approvalQueue.requestCredentialInput({
      kind: "credential-input",
      callerId: ctx.caller.runtime.id,
      callerKind: ctx.caller.runtime.kind,
      ...(ctx.caller.subject ? { requestedByUserId: ctx.caller.subject.userId } : {}),
      repoPath: identity.repoPath,
      effectiveVersion: identity.effectiveVersion,
      title: request.flow.title ?? request.credential.label,
      description: request.flow.description,
      credentialLabel: request.credential.label,
      audience,
      injection,
      accountIdentity,
      scopes: request.credential.scopes ?? [],
      fields: request.flow.fields.map((field) => ({
        name: field.name,
        label: field.label,
        type: field.type,
        required: field.required ?? false,
        description: field.description,
      })),
    });
    if (result.decision !== "submit") {
      throw new OAuthConnectionError("approval_denied");
    }
    const material = renderApiKeyMaterialTemplate(
      request.flow.materialTemplate.valueTemplate,
      result.values
    );
    if (!material) {
      throw new OAuthConnectionError(
        "invalid_connection_spec",
        "api-key material template produced empty material"
      );
    }
    return storeCredential(
      ctx,
      {
        label: request.credential.label,
        audience,
        injection,
        bindings: request.credential.bindings,
        material: {
          type: request.flow.materialTemplate.type,
          token: material,
        },
        accountIdentity,
        scopes: request.credential.scopes ?? [],
        metadata: {
          ...(request.credential.metadata ?? {}),
          flowType: "api-key",
        },
      },
      { approvalDecision: "session" }
    );
  }

  async function connectAwsSigV4(
    ctx: ServiceContext,
    request: ConnectCredentialRequest
  ): Promise<StoredCredentialSummary> {
    if (request.flow.type !== "aws-sigv4") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    if (request.credential.injection.type !== "aws-sigv4") {
      throw new OAuthConnectionError("unsupported_injection");
    }
    if (!approvalQueue || !isUserlandRuntimeCaller(ctx)) {
      throw new Error("Credential input approval is unavailable");
    }
    const audience = normalizeUrlAudiences(request.credential.audience);
    const injection = normalizeCredentialInjection(request.credential.injection);
    const accountIdentity = normalizeAccountIdentity(
      request.credential.accountIdentity,
      ctx.caller.runtime.id
    );
    const identity = resolveApprovalIdentity(ctx);
    const fields = [
      { name: "accessKeyId", label: "Access key ID", type: "secret" as const, required: true },
      {
        name: "secretAccessKey",
        label: "Secret access key",
        type: "secret" as const,
        required: true,
      },
      { name: "sessionToken", label: "Session token", type: "secret" as const, required: false },
    ];
    const result = await approvalQueue.requestCredentialInput({
      kind: "credential-input",
      callerId: ctx.caller.runtime.id,
      callerKind: ctx.caller.runtime.kind,
      ...(ctx.caller.subject ? { requestedByUserId: ctx.caller.subject.userId } : {}),
      repoPath: identity.repoPath,
      effectiveVersion: identity.effectiveVersion,
      title: request.flow.title ?? request.credential.label,
      description: request.flow.description,
      credentialLabel: request.credential.label,
      audience,
      injection,
      accountIdentity,
      scopes: request.credential.scopes ?? [],
      fields,
    });
    if (result.decision !== "submit") {
      throw new OAuthConnectionError("approval_denied");
    }
    const accessKeyId = result.values["accessKeyId"]?.trim() ?? "";
    const secretAccessKey = result.values["secretAccessKey"]?.trim() ?? "";
    const sessionToken = result.values["sessionToken"]?.trim() ?? "";
    if (!accessKeyId || !secretAccessKey) {
      throw new OAuthConnectionError(
        "invalid_connection_spec",
        "AWS SigV4 credentials require access key ID and secret access key"
      );
    }
    const stored = await storeCredential(
      ctx,
      {
        label: request.credential.label,
        audience,
        injection,
        bindings: request.credential.bindings,
        material: { type: "aws-sigv4", token: accessKeyId },
        accountIdentity: request.credential.accountIdentity ?? {
          providerUserId: `aws:${accessKeyId}`,
        },
        scopes: request.credential.scopes ?? [],
        metadata: {
          ...(request.credential.metadata ?? {}),
          flowType: "aws-sigv4",
          awsAccessKeyId: accessKeyId,
          awsService: request.credential.injection.service,
          awsRegion: request.credential.injection.region,
        },
      },
      { approvalDecision: "session" }
    );
    const persisted = await credentialStore.loadUrlBound(stored.id);
    if (persisted?.id) {
      await credentialStore.saveUrlBound({
        ...persisted,
        awsSecretAccessKey: secretAccessKey,
        ...(sessionToken ? { awsSessionToken: sessionToken } : {}),
      } as Credential & { id: string });
    }
    return stored;
  }

  async function connectSshKey(
    ctx: ServiceContext,
    request: ConnectCredentialRequest
  ): Promise<StoredCredentialSummary> {
    if (request.flow.type !== "ssh-key") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    const bindings = request.credential.bindings;
    if (!bindings?.length || bindings.some((binding) => binding.use !== "git-ssh")) {
      throw new OAuthConnectionError(
        "invalid_connection_spec",
        "ssh-key credentials require explicit git-ssh bindings"
      );
    }
    if (request.credential.injection.type !== "ssh-key") {
      throw new OAuthConnectionError("unsupported_injection");
    }
    const audience = normalizeUrlAudiences(request.credential.audience);
    const injection = normalizeCredentialInjection(request.credential.injection);
    const identity = resolveApprovalIdentity(ctx);
    const approvalAccount = normalizeAccountIdentity(
      request.credential.accountIdentity,
      ctx.caller.runtime.id
    );
    const approvalDecision = await requestCredentialApproval(ctx, {
      credentialId: randomUUID(),
      credentialLabel: request.credential.label,
      audience,
      injection,
      accountIdentity: approvalAccount,
      scopes: request.credential.scopes ?? [],
      identity,
      metadata: {
        ...(request.credential.metadata ?? {}),
        flowType: "ssh-key",
      },
    });
    const mode = request.flow.mode ?? "generate";
    let privateKey: string;
    let publicKey: string;
    if (mode === "generate") {
      const pair = generateKeyPairSync("ed25519", {
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "der" },
      });
      privateKey = pair.privateKey;
      publicKey = openSshEd25519PublicKey(pair.publicKey);
    } else {
      if (!approvalQueue || !isUserlandRuntimeCaller(ctx)) {
        throw new Error("Credential input approval is unavailable");
      }
      const result = await approvalQueue.requestCredentialInput({
        kind: "credential-input",
        callerId: ctx.caller.runtime.id,
        callerKind: ctx.caller.runtime.kind,
        ...(ctx.caller.subject ? { requestedByUserId: ctx.caller.subject.userId } : {}),
        repoPath: identity.repoPath,
        effectiveVersion: identity.effectiveVersion,
        title: request.flow.title ?? request.credential.label,
        description: request.flow.description,
        credentialLabel: request.credential.label,
        audience,
        injection,
        accountIdentity: approvalAccount,
        scopes: request.credential.scopes ?? [],
        fields: [{ name: "privateKey", label: "SSH private key", type: "secret", required: true }],
      });
      if (result.decision !== "submit") {
        throw new OAuthConnectionError("approval_denied");
      }
      privateKey = result.values["privateKey"]?.trim() ?? "";
      if (!privateKey) {
        throw new OAuthConnectionError("invalid_connection_spec", "SSH private key is required");
      }
      publicKey = openSshEd25519PublicKey(
        createPublicKey(privateKey).export({ type: "spki", format: "der" })
      );
    }
    const fingerprint = sshPublicKeyFingerprint(publicKey);
    const stored = await storeCredential(
      ctx,
      {
        label: request.credential.label,
        audience,
        injection,
        bindings,
        material: { type: "ssh-key", token: publicKey },
        accountIdentity: request.credential.accountIdentity ?? {
          providerUserId: `ssh:${fingerprint}`,
        },
        scopes: request.credential.scopes ?? [],
        metadata: {
          ...(request.credential.metadata ?? {}),
          flowType: "ssh-key",
          sshAlgorithm: "ed25519",
          sshPublicKeyFingerprint: fingerprint,
          sshPublicKey: publicKey,
        },
      },
      {
        approvalDecision,
        preapprovedUseDecision: approvalDecision,
      }
    );
    const persisted = await credentialStore.loadUrlBound(stored.id);
    if (persisted?.id) {
      await credentialStore.saveUrlBound({
        ...persisted,
        sshPrivateKey: privateKey,
        sshPublicKey: publicKey,
      } as Credential & { id: string });
    }
    return stored;
  }

  async function connectOAuthClientCredentials(
    ctx: ServiceContext,
    request: ConnectCredentialRequest
  ): Promise<StoredCredentialSummary> {
    if (request.flow.type !== "oauth2-client-credentials") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    const config = await loadClientConfigForFlow(
      request.flow.clientConfigId,
      "oauth2-client-credentials"
    );
    const clientId = config.fields["clientId"]?.value;
    const clientSecret = config.fields["clientSecret"]?.value;
    const privateKeyPem = config.fields["privateKeyPem"]?.value;
    if (
      !clientId ||
      (request.flow.tokenAuth === "private_key_jwt" ? !privateKeyPem : !clientSecret)
    ) {
      throw new OAuthConnectionError("client_config_unavailable");
    }
    const audience = normalizeUrlAudiences(request.credential.audience);
    const injection = normalizeCredentialInjection(request.credential.injection);
    const identity = resolveApprovalIdentity(ctx);
    const approvalDecision = await requestCredentialApproval(ctx, {
      credentialId: randomUUID(),
      credentialLabel: request.credential.label,
      audience,
      injection,
      accountIdentity: normalizeAccountIdentity(
        request.credential.accountIdentity,
        request.flow.clientConfigId
      ),
      scopes: request.credential.scopes ?? request.flow.scopes ?? [],
      identity,
      metadata: {
        ...(request.credential.metadata ?? {}),
        flowType: request.flow.type,
        oauthTokenOrigin: new URL(request.flow.tokenUrl).origin,
      },
    });
    const token = await exchangeClientCredentialsToken({
      tokenUrl: request.flow.tokenUrl,
      clientId,
      clientSecret,
      privateKeyPem,
      keyId: config.fields["keyId"]?.value,
      keyAlgorithm: config.fields["algorithm"]?.value,
      tokenAuth: request.flow.tokenAuth,
      scopes: request.flow.scopes,
      audienceParam: request.flow.audienceParam,
      resourceParam: request.flow.resourceParam,
    });
    return storeCredential(
      ctx,
      {
        label: request.credential.label,
        audience,
        injection,
        bindings: request.credential.bindings,
        material: { type: "bearer-token", token: token.accessToken },
        accountIdentity: request.credential.accountIdentity ?? {
          providerUserId: `service:${request.flow.clientConfigId}`,
        },
        scopes: grantedOAuthScopes({
          tokenScopes: token.scopes,
          requestedScopes: request.flow.scopes,
          declaredScopes: request.credential.scopes,
        }),
        expiresAt: token.expiresAt,
        metadata: {
          ...(request.credential.metadata ?? {}),
          flowType: request.flow.type,
          clientConfigId: request.flow.clientConfigId,
          clientConfigVersion: config.currentVersion ?? String(config.updatedAt),
          oauthTokenAuth: request.flow.tokenAuth,
          oauthTokenOrigin: new URL(request.flow.tokenUrl).origin,
          ...(request.flow.revocationUrl ? { oauthRevocationUrl: request.flow.revocationUrl } : {}),
        },
      },
      {
        approvalDecision,
        preapprovedUseDecision: approvalDecision,
      }
    );
  }

  async function connectOAuthJwtBearer(
    ctx: ServiceContext,
    request: ConnectCredentialRequest
  ): Promise<StoredCredentialSummary> {
    if (request.flow.type !== "oauth2-jwt-bearer") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    const config = await loadClientConfigForFlow(request.flow.clientConfigId, "oauth2-jwt-bearer");
    const clientId = config.fields["clientId"]?.value;
    const privateKeyPem = config.fields["privateKeyPem"]?.value;
    if (!clientId || !privateKeyPem) {
      throw new OAuthConnectionError("client_config_unavailable");
    }
    const audience = normalizeUrlAudiences(request.credential.audience);
    const injection = normalizeCredentialInjection(request.credential.injection);
    const identity = resolveApprovalIdentity(ctx);
    const approvalDecision = await requestCredentialApproval(ctx, {
      credentialId: randomUUID(),
      credentialLabel: request.credential.label,
      audience,
      injection,
      accountIdentity: normalizeAccountIdentity(
        request.credential.accountIdentity,
        request.flow.subject ?? clientId
      ),
      scopes: request.credential.scopes ?? request.flow.scopes ?? [],
      identity,
      metadata: {
        ...(request.credential.metadata ?? {}),
        flowType: request.flow.type,
        oauthTokenOrigin: new URL(request.flow.tokenUrl).origin,
      },
    });
    const token = await exchangeJwtBearerToken({
      tokenUrl: request.flow.tokenUrl,
      clientId,
      privateKeyPem,
      keyId: config.fields["keyId"]?.value,
      keyAlgorithm: config.fields["algorithm"]?.value,
      issuer: request.flow.issuer ?? clientId,
      subject: request.flow.subject ?? clientId,
      audience: request.flow.audience ?? request.flow.tokenUrl,
      scopes: request.flow.scopes,
      persistRefreshToken: request.flow.persistRefreshToken,
    });
    const configVersion = config.currentVersion ?? String(config.updatedAt);
    return storeCredential(
      ctx,
      {
        label: request.credential.label,
        audience,
        injection,
        bindings: request.credential.bindings,
        material: { type: "bearer-token", token: token.accessToken },
        ...oauthRefreshMaterial({
          refreshToken: token.refreshToken,
          tokenUrl: request.flow.tokenUrl,
          clientId,
          tokenAuth: "private_key_jwt",
          clientConfig: { configId: request.flow.clientConfigId, configVersion },
        }),
        accountIdentity: request.credential.accountIdentity ?? {
          providerUserId: request.flow.subject ?? clientId,
        },
        scopes: grantedOAuthScopes({
          tokenScopes: token.scopes,
          requestedScopes: request.flow.scopes,
          declaredScopes: request.credential.scopes,
        }),
        expiresAt: token.expiresAt,
        metadata: {
          ...(request.credential.metadata ?? {}),
          flowType: request.flow.type,
          oauthTokenOrigin: new URL(request.flow.tokenUrl).origin,
          ...(request.flow.revocationUrl ? { oauthRevocationUrl: request.flow.revocationUrl } : {}),
        },
      },
      { approvalDecision, preapprovedUseDecision: approvalDecision }
    );
  }

  async function connectOAuthTokenExchange(
    ctx: ServiceContext,
    request: ConnectCredentialRequest
  ): Promise<StoredCredentialSummary> {
    if (request.flow.type !== "oauth2-token-exchange") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    const config = await loadClientConfigForFlow(
      request.flow.clientConfigId,
      "oauth2-token-exchange"
    );
    const clientId = config.fields["clientId"]?.value;
    const tokenAuth =
      request.flow.tokenAuth ??
      (config.fields["privateKeyPem"]?.value ? "private_key_jwt" : "client_secret_post");
    const clientSecret = config.fields["clientSecret"]?.value;
    const privateKeyPem = config.fields["privateKeyPem"]?.value;
    if (!clientId || (tokenAuth === "private_key_jwt" ? !privateKeyPem : !clientSecret)) {
      throw new OAuthConnectionError("client_config_unavailable");
    }
    const subject = await loadActiveCredential(request.flow.subjectCredentialId);
    if (subject.revokedAt || !subject.accessToken) {
      throw new OAuthConnectionError("credential_expired_reauth_required");
    }
    await authorizeCredentialSubjectUse(ctx, subject);
    const audience = normalizeUrlAudiences(request.credential.audience);
    const injection = normalizeCredentialInjection(request.credential.injection);
    const identity = resolveApprovalIdentity(ctx);
    const approvalDecision = await requestCredentialApproval(ctx, {
      credentialId: randomUUID(),
      credentialLabel: request.credential.label,
      audience,
      injection,
      accountIdentity:
        subject.accountIdentity ??
        normalizeAccountIdentity(request.credential.accountIdentity, ctx.caller.runtime.id),
      scopes: request.credential.scopes ?? request.flow.scopes ?? [],
      identity,
      metadata: {
        ...(request.credential.metadata ?? {}),
        flowType: request.flow.type,
        oauthTokenOrigin: new URL(request.flow.tokenUrl).origin,
      },
    });
    const token = await exchangeOAuthToken({
      tokenUrl: request.flow.tokenUrl,
      clientId,
      clientSecret,
      privateKeyPem,
      keyId: config.fields["keyId"]?.value,
      keyAlgorithm: config.fields["algorithm"]?.value,
      tokenAuth,
      subjectToken: subject.accessToken,
      subjectTokenType: request.flow.subjectTokenType ?? "access_token",
      requestedTokenType: request.flow.requestedTokenType,
      scopes: request.flow.scopes,
      audience: request.flow.audience,
      resource: request.flow.resource,
      persistRefreshToken: request.flow.persistRefreshToken,
    });
    const configVersion = config.currentVersion ?? String(config.updatedAt);
    return storeCredential(
      ctx,
      {
        label: request.credential.label,
        audience,
        injection,
        bindings: request.credential.bindings,
        material: { type: "bearer-token", token: token.accessToken },
        ...oauthRefreshMaterial({
          refreshToken: token.refreshToken,
          tokenUrl: request.flow.tokenUrl,
          clientId,
          tokenAuth,
          clientConfig: { configId: request.flow.clientConfigId, configVersion },
        }),
        accountIdentity: request.credential.accountIdentity ?? subject.accountIdentity,
        scopes: grantedOAuthScopes({
          tokenScopes: token.scopes,
          requestedScopes: request.flow.scopes,
          declaredScopes: request.credential.scopes,
        }),
        expiresAt: token.expiresAt,
        metadata: {
          ...(request.credential.metadata ?? {}),
          flowType: request.flow.type,
          subjectCredentialId: request.flow.subjectCredentialId,
          oauthTokenOrigin: new URL(request.flow.tokenUrl).origin,
          ...(request.flow.revocationUrl ? { oauthRevocationUrl: request.flow.revocationUrl } : {}),
        },
      },
      { approvalDecision, preapprovedUseDecision: approvalDecision }
    );
  }

  async function connectBrowserCookieSession(
    ctx: ServiceContext,
    request: ConnectCredentialRequest,
    signal?: AbortSignal
  ): Promise<StoredCredentialSummary> {
    throwIfAborted(signal);
    if (request.flow.type !== "browser-cookie-session") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    if (request.credential.injection.type !== "cookie") {
      throw new OAuthConnectionError("unsupported_injection");
    }
    if (!sessionCredentialCapture) {
      throw new OAuthConnectionError(
        "browser_unavailable",
        "Session credential capture is unavailable on this platform"
      );
    }
    const audience = normalizeUrlAudiences(request.credential.audience);
    const injection = normalizeCredentialInjection(request.credential.injection);
    const identity = resolveApprovalIdentity(ctx);
    const approvalDecision = await requestCredentialApproval(ctx, {
      credentialId: randomUUID(),
      credentialLabel: request.credential.label,
      audience,
      injection,
      accountIdentity: normalizeAccountIdentity(
        request.credential.accountIdentity,
        ctx.caller.runtime.id
      ),
      scopes: request.credential.scopes ?? [],
      identity,
      signal,
      metadata: {
        ...(request.credential.metadata ?? {}),
        flowType: request.flow.type,
        sessionSignInOrigin: new URL(request.flow.signInUrl).origin,
        capturedCookieNames: request.flow.capture.cookies.join(","),
      },
    });
    throwIfAborted(signal);
    const captured = await sessionCredentialCapture.captureCookies({
      signInUrl: request.flow.signInUrl,
      origins: request.flow.capture.origins,
      cookieNames: request.flow.capture.cookies,
      completionUrlPattern: request.flow.completionUrlPattern,
      maxTtlSeconds: request.flow.maxTtlSeconds,
      browser: request.browser ?? "internal",
      signal,
    });
    if (!captured.cookieHeader) {
      throw new OAuthConnectionError("session_capture_failed");
    }
    const stored = await storeCredential(
      ctx,
      {
        label: request.credential.label,
        audience,
        injection,
        bindings: request.credential.bindings,
        material: { type: "cookie-session", token: captured.cookieHeader },
        accountIdentity: {
          ...(captured.accountIdentity ?? {}),
          ...(request.credential.accountIdentity ?? {}),
        },
        scopes: request.credential.scopes ?? [],
        expiresAt: captured.expiresAt,
        metadata: {
          ...(request.credential.metadata ?? {}),
          flowType: request.flow.type,
          sessionSignInOrigin: new URL(request.flow.signInUrl).origin,
          capturedCookieNames: request.flow.capture.cookies.join(","),
        },
      },
      {
        approvalDecision,
        preapprovedUseDecision: approvalDecision,
      }
    );
    const persisted = await credentialStore.loadUrlBound(stored.id);
    if (persisted?.id) {
      await credentialStore.saveUrlBound({
        ...persisted,
        cookieHeader: captured.cookieHeader,
        ...(captured.cookieSession ? { cookieSession: captured.cookieSession } : {}),
      } as Credential & { id: string });
    }
    return stored;
  }

  async function connectSamlBrowserSession(
    ctx: ServiceContext,
    request: ConnectCredentialRequest,
    signal?: AbortSignal
  ): Promise<StoredCredentialSummary> {
    throwIfAborted(signal);
    if (request.flow.type !== "saml-browser-session") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    if (request.credential.injection.type !== "cookie") {
      throw new OAuthConnectionError("unsupported_injection");
    }
    if (!sessionCredentialCapture?.captureSamlSession) {
      throw new OAuthConnectionError(
        "browser_unavailable",
        "SAML session capture is unavailable on this platform"
      );
    }
    if (!request.flow.capture.cookies?.length && !request.flow.capture.assertion) {
      throw new OAuthConnectionError("invalid_connection_spec");
    }
    const audience = normalizeUrlAudiences(request.credential.audience);
    const injection = normalizeCredentialInjection(request.credential.injection);
    const identity = resolveApprovalIdentity(ctx);
    const approvalDecision = await requestCredentialApproval(ctx, {
      credentialId: randomUUID(),
      credentialLabel: request.credential.label,
      audience,
      injection,
      accountIdentity: normalizeAccountIdentity(
        request.credential.accountIdentity,
        ctx.caller.runtime.id
      ),
      scopes: request.credential.scopes ?? [],
      identity,
      signal,
      metadata: {
        ...(request.credential.metadata ?? {}),
        flowType: request.flow.type,
        sessionSignInOrigin: new URL(request.flow.signInUrl).origin,
        spAudience: request.flow.spAudience,
        capturedCookieNames: request.flow.capture.cookies?.join(",") ?? "",
      },
    });
    throwIfAborted(signal);
    const captured = await sessionCredentialCapture.captureSamlSession({
      signInUrl: request.flow.signInUrl,
      spAudience: request.flow.spAudience,
      cookieNames: request.flow.capture.cookies,
      assertion: request.flow.capture.assertion,
      completionUrlPattern: request.flow.completionUrlPattern,
      maxTtlSeconds: request.flow.maxTtlSeconds,
      browser: request.browser ?? "internal",
      signal,
    });
    if (!captured.cookieHeader && !captured.assertion) {
      throw new OAuthConnectionError("saml_assertion_failed");
    }
    const material = captured.cookieHeader ?? captured.assertion ?? "";
    const stored = await storeCredential(
      ctx,
      {
        label: request.credential.label,
        audience,
        injection,
        bindings: request.credential.bindings,
        material: { type: "saml-session", token: material },
        accountIdentity: {
          ...(captured.accountIdentity ?? {}),
          ...(request.credential.accountIdentity ?? {}),
        },
        scopes: request.credential.scopes ?? [],
        expiresAt: captured.expiresAt,
        metadata: {
          ...(request.credential.metadata ?? {}),
          flowType: request.flow.type,
          sessionSignInOrigin: new URL(request.flow.signInUrl).origin,
          spAudience: request.flow.spAudience,
          capturedCookieNames: request.flow.capture.cookies?.join(",") ?? "",
        },
      },
      {
        approvalDecision,
        preapprovedUseDecision: approvalDecision,
      }
    );
    const persisted = await credentialStore.loadUrlBound(stored.id);
    if (persisted?.id) {
      await credentialStore.saveUrlBound({
        ...persisted,
        ...(captured.cookieHeader ? { cookieHeader: captured.cookieHeader } : {}),
        ...(captured.cookieSession ? { cookieSession: captured.cookieSession } : {}),
        ...(captured.assertion ? { samlAssertion: captured.assertion } : {}),
      } as Credential & { id: string });
    }
    return stored;
  }

  async function connectOAuthDeviceCode(
    ctx: ServiceContext,
    request: ConnectCredentialRequest,
    signal?: AbortSignal
  ): Promise<StoredCredentialSummary> {
    throwIfAborted(signal);
    if (request.flow.type !== "oauth2-device-code") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    const config = request.flow.clientConfigId
      ? await loadClientConfigForFlow(request.flow.clientConfigId, "oauth2-device-code")
      : null;
    const clientId = request.flow.clientId ?? config?.fields["clientId"]?.value;
    const clientSecret = config?.fields["clientSecret"]?.value;
    const privateKeyPem = config?.fields["privateKeyPem"]?.value;
    const tokenAuth = request.flow.tokenAuth ?? (clientSecret ? "client_secret_post" : "none");
    if (!clientId) {
      throw new OAuthConnectionError("client_config_unavailable");
    }
    if (
      tokenAuth !== "none" &&
      (tokenAuth === "private_key_jwt" ? !privateKeyPem : !clientSecret)
    ) {
      throw new OAuthConnectionError("client_config_unavailable");
    }
    const audience = normalizeUrlAudiences(request.credential.audience);
    const injection = normalizeCredentialInjection(request.credential.injection);
    const identity = resolveApprovalIdentity(ctx);
    const approvalDecision = await requestCredentialApproval(ctx, {
      credentialId: randomUUID(),
      credentialLabel: request.credential.label,
      audience,
      injection,
      accountIdentity: normalizeAccountIdentity(
        request.credential.accountIdentity,
        ctx.caller.runtime.id
      ),
      scopes: request.credential.scopes ?? request.flow.scopes ?? [],
      identity,
      signal,
      metadata: {
        ...(request.credential.metadata ?? {}),
        flowType: request.flow.type,
        oauthTokenOrigin: new URL(request.flow.tokenUrl).origin,
      },
    });
    throwIfAborted(signal);
    const device = await requestDeviceAuthorization({
      deviceAuthorizationUrl: request.flow.deviceAuthorizationUrl,
      clientId,
      clientSecret,
      privateKeyPem,
      keyId: config?.fields["keyId"]?.value,
      keyAlgorithm: config?.fields["algorithm"]?.value,
      tokenAuth,
      scopes: request.flow.scopes,
      signal,
    });
    const verificationUrl = device.verificationUriComplete ?? device.verificationUri;
    if (!eventService || !verificationUrl) {
      throw new OAuthConnectionError("browser_unavailable");
    }
    if (!device.userCode) {
      // RFC 8628 requires user_code; without it the user has nothing to type
      // and we can't surface the flow meaningfully.
      throw new OAuthConnectionError("invalid_token_response");
    }
    // Present the user_code on the trusted approval bar so the operator
    // sees it even when the provider didn't embed it in
    // verification_uri_complete. Cancelling the bar entry aborts polling.
    const presentation = approvalQueue?.presentDeviceCode({
      kind: "device-code",
      callerId: ctx.caller.runtime.id,
      callerKind: isUserlandRuntimeCaller(ctx) ? ctx.caller.runtime.kind : "panel",
      repoPath: identity.repoPath,
      effectiveVersion: identity.effectiveVersion,
      credentialLabel: request.credential.label,
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      verificationUriComplete: device.verificationUriComplete,
      expiresAt:
        Date.now() + Math.max(1, request.flow.expiresInSeconds ?? device.expiresInSeconds) * 1000,
      oauthTokenOrigin: new URL(request.flow.tokenUrl).origin,
    });
    const browserResolution = await resolveBrowserHandoffTarget(ctx);
    const browserDelivery = browserResolution.target
      ? emitToBrowserTarget(browserResolution.target, "external-open:open", {
          url: verificationUrl,
          callerId: ctx.caller.runtime.id,
          callerKind: ctx.caller.runtime.kind,
        })
      : undefined;
    if (!browserResolution.target || !browserDelivery?.delivered) {
      presentation?.dispose();
      throw new OAuthConnectionError(
        "browser_unavailable",
        browserHandoffUnavailableMessage(browserResolution.diagnostics, browserDelivery)
      );
    }
    let token: Awaited<ReturnType<typeof pollDeviceToken>>;
    try {
      token = await pollDeviceToken({
        tokenUrl: request.flow.tokenUrl,
        clientId,
        clientSecret,
        privateKeyPem,
        keyId: config?.fields["keyId"]?.value,
        keyAlgorithm: config?.fields["algorithm"]?.value,
        tokenAuth,
        deviceCode: device.deviceCode,
        intervalSeconds: request.flow.pollIntervalSeconds ?? device.intervalSeconds,
        expiresInSeconds: request.flow.expiresInSeconds ?? device.expiresInSeconds,
        persistRefreshToken: request.flow.persistRefreshToken,
        cancelSignal: anySignal([presentation?.cancelled, signal]),
      });
    } finally {
      presentation?.dispose();
    }
    const clientConfig =
      config && request.flow.clientConfigId
        ? {
            configId: request.flow.clientConfigId,
            configVersion: config.currentVersion ?? String(config.updatedAt),
          }
        : undefined;
    return storeCredential(
      ctx,
      {
        label: request.credential.label,
        audience,
        injection,
        bindings: request.credential.bindings,
        material: { type: "bearer-token", token: token.accessToken },
        ...oauthRefreshMaterial({
          refreshToken: token.refreshToken,
          tokenUrl: request.flow.tokenUrl,
          clientId,
          tokenAuth,
          clientConfig,
        }),
        accountIdentity: request.credential.accountIdentity,
        scopes: grantedOAuthScopes({
          tokenScopes: token.scopes,
          requestedScopes: request.flow.scopes,
          declaredScopes: request.credential.scopes,
        }),
        expiresAt: token.expiresAt,
        metadata: {
          ...(request.credential.metadata ?? {}),
          flowType: request.flow.type,
          oauthDeviceVerificationOrigin: new URL(verificationUrl).origin,
          oauthTokenOrigin: new URL(request.flow.tokenUrl).origin,
          ...(request.flow.revocationUrl ? { oauthRevocationUrl: request.flow.revocationUrl } : {}),
        },
      },
      {
        approvalDecision,
        preapprovedUseDecision: approvalDecision,
      }
    );
  }

  async function connectOAuth1a(
    ctx: ServiceContext,
    request: ConnectCredentialRequest,
    handoffTarget?: { callerId: string; callerKind: BrowserHandoffCallerKind },
    signal?: AbortSignal
  ): Promise<StoredCredentialSummary> {
    throwIfAborted(signal);
    if (request.flow.type !== "oauth1a") {
      throw new OAuthConnectionError("unsupported_flow");
    }
    if (request.credential.injection.type !== "oauth1-signature") {
      throw new OAuthConnectionError("unsupported_injection");
    }
    const config = await loadClientConfigForFlow(request.flow.clientConfigId, "oauth1a");
    const consumerKey = config.fields["consumerKey"]?.value ?? config.fields["clientId"]?.value;
    const consumerSecret =
      config.fields["consumerSecret"]?.value ?? config.fields["clientSecret"]?.value;
    if (!consumerKey || !consumerSecret) {
      throw new OAuthConnectionError("client_config_unavailable");
    }
    const redirect = request.redirect ?? {};
    const redirectStrategy = resolveDefaultRedirectStrategy(redirect.type);
    if (redirectStrategy === "client-loopback") {
      throw new OAuthConnectionError(
        "unsupported_flow",
        "client-loopback redirects are only supported for OAuth2 flows"
      );
    }
    let callback: HostOAuthCallback | null = null;
    let tx: OAuthConnectionTransaction | null = null;
    try {
      const stateParam = randomBytes(16).toString("base64url");
      let redirectUri: string;
      let transactionId: string | undefined;
      if (redirectStrategy === "loopback") {
        callback = await createLoopbackOAuthCallback({
          host: redirect.host ?? DEFAULT_LOOPBACK_HOST,
          port: redirect.port ?? 0,
          callbackPath: redirect.callbackPath ?? DEFAULT_CALLBACK_PATH,
          allowDynamicPortFallback: redirect.fallback === "dynamic-port",
          signal,
        });
        redirectUri = callback.redirectUri;
      } else if (redirectStrategy === "public") {
        transactionId = randomUUID();
        redirectUri = buildRelayOAuthCallbackUrl(transactionId);
      } else if (redirectStrategy === "client-forwarded") {
        transactionId = randomUUID();
        redirectUri = redirect.callbackUri ?? buildRelayOAuthCallbackUrl(transactionId);
      } else {
        throw new OAuthConnectionError("redirect_unavailable");
      }
      const callbackUrl = new URL(redirectUri);
      callbackUrl.searchParams.set("state", stateParam);
      tx = await createOAuthTransaction(ctx, {
        id: transactionId,
        redirectUri,
        redirectStrategy,
        stateParam,
      });
      registerRelayOAuthIfNeeded(tx);
      const audience = normalizeUrlAudiences(request.credential.audience);
      const injection = normalizeCredentialInjection(request.credential.injection);
      const identity = resolveApprovalIdentity(ctx);
      const approvalDecision = await requestCredentialApproval(ctx, {
        credentialId: randomUUID(),
        credentialLabel: request.credential.label,
        audience,
        injection,
        accountIdentity: normalizeAccountIdentity(
          request.credential.accountIdentity,
          ctx.caller.runtime.id
        ),
        scopes: request.credential.scopes ?? [],
        identity,
        signal,
        metadata: {
          ...(request.credential.metadata ?? {}),
          flowType: request.flow.type,
          oauthAuthorizeOrigin: new URL(request.flow.authorizeUrl).origin,
        },
      });
      throwIfAborted(signal);
      await transitionOAuthTransaction(tx, "approved");
      const requestToken = await exchangeOAuth1RequestToken({
        requestTokenUrl: request.flow.requestTokenUrl,
        consumerKey,
        consumerSecret,
        callbackUrl: callbackUrl.toString(),
      });
      callback?.expectState(stateParam);
      const authorizeUrl = new URL(request.flow.authorizeUrl);
      authorizeUrl.searchParams.set("oauth_token", requestToken.token);
      const browserResolution = await resolveBrowserHandoffTarget(ctx, handoffTarget);
      const browserDelivery = browserResolution.target
        ? emitToBrowserTarget(browserResolution.target, "external-open:open", {
            url: authorizeUrl.toString(),
            callerId: ctx.caller.runtime.id,
            callerKind: ctx.caller.runtime.kind,
          })
        : undefined;
      if (!browserResolution.target || !browserDelivery?.delivered) {
        throw new OAuthConnectionError(
          "browser_unavailable",
          browserHandoffUnavailableMessage(browserResolution.diagnostics, browserDelivery)
        );
      }
      await transitionOAuthTransaction(tx, "handoff_requested");
      if (callback) {
        const callbackResult = await abortable(callback.wait, signal, () => callback?.close());
        await receiveOAuthCallback(tx, callbackResult);
      }
      const result = await abortable(tx.wait, signal);
      await transitionOAuthTransaction(tx, "exchanging");
      const access = await exchangeOAuth1AccessToken({
        accessTokenUrl: request.flow.accessTokenUrl,
        consumerKey,
        consumerSecret,
        requestToken: requestToken.token,
        requestTokenSecret: requestToken.secret,
        verifier: result.code,
      });
      const stored = await storeCredential(
        ctx,
        {
          label: request.credential.label,
          audience,
          injection,
          bindings: request.credential.bindings,
          material: { type: "bearer-token", token: access.token },
          accountIdentity: request.credential.accountIdentity,
          scopes: request.credential.scopes ?? [],
          metadata: {
            ...(request.credential.metadata ?? {}),
            flowType: request.flow.type,
            clientConfigId: request.flow.clientConfigId,
            clientConfigVersion: config.currentVersion ?? String(config.updatedAt),
            oauth1ConsumerKey: consumerKey,
            oauthAuthorizeOrigin: new URL(request.flow.authorizeUrl).origin,
          },
        },
        {
          approvalDecision,
          preapprovedUseDecision: approvalDecision,
        }
      );
      const persisted = await credentialStore.loadUrlBound(stored.id);
      if (persisted?.id) {
        await credentialStore.saveUrlBound({
          ...persisted,
          oauth1ConsumerSecret: consumerSecret,
          oauth1TokenSecret: access.secret,
        } as Credential & { id: string });
      }
      await transitionOAuthTransaction(tx, "stored");
      await transitionOAuthTransaction(tx, "completed");
      oauthTransactions.delete(tx.id);
      return stored;
    } catch (error) {
      if (tx && !["completed", "failed", "expired", "cancelled"].includes(tx.state)) {
        await transitionOAuthTransaction(tx, "failed", errorCodeForOAuthError(error));
      }
      throw error;
    } finally {
      callback?.close();
    }
  }

  async function connectOAuth2AuthCode(
    ctx: ServiceContext,
    request: AuthCodeConnectRequest,
    explicitHandoffTarget?: { callerId: string; callerKind: BrowserHandoffCallerKind },
    signal?: AbortSignal
  ): Promise<StoredCredentialSummary> {
    throwIfAborted(signal);
    const redirect = request.redirect ?? {};
    const redirectStrategy = resolveDefaultRedirectStrategy(redirect.type);
    let callback: HostOAuthCallback | null = null;
    let tx: OAuthConnectionTransaction | null = null;
    try {
      const stateParam = randomBytes(16).toString("base64url");
      let redirectUri: string;
      let transactionId: string | undefined;
      if (redirectStrategy === "loopback") {
        callback = await createLoopbackOAuthCallback({
          host: redirect.host ?? DEFAULT_LOOPBACK_HOST,
          port: redirect.port ?? 0,
          callbackPath: redirect.callbackPath ?? DEFAULT_CALLBACK_PATH,
          allowDynamicPortFallback: redirect.fallback === "dynamic-port",
          signal,
        });
        redirectUri = callback.redirectUri;
      } else if (redirectStrategy === "public") {
        transactionId = randomUUID();
        redirectUri = buildRelayOAuthCallbackUrl(transactionId);
      } else if (redirectStrategy === "client-forwarded") {
        transactionId = randomUUID();
        redirectUri = redirect.callbackUri ?? buildRelayOAuthCallbackUrl(transactionId);
      } else if (redirectStrategy === "client-loopback") {
        transactionId = randomUUID();
        redirectUri = buildClientLoopbackRedirectUri(redirect);
      } else if (redirectStrategy === "app-scheme") {
        transactionId = randomUUID();
        redirectUri = buildAppSchemeRedirectUri(redirect, request);
      } else {
        throw new OAuthConnectionError("redirect_unavailable");
      }
      tx = await createOAuthTransaction(ctx, {
        id: transactionId,
        redirectUri,
        redirectStrategy,
        stateParam,
      });
      registerRelayOAuthIfNeeded(tx);
      const oauthRequest = await resolveAuthCodeConnectionRequest(request, redirectUri);
      validateOAuthCredentialRequest(oauthRequest, redirectStrategy);
      const identity = resolveApprovalIdentity(ctx);
      const audience = normalizeUrlAudiences(oauthRequest.credential.audience);
      const injection = normalizeCredentialInjection(oauthRequest.credential.injection);
      const metadata = {
        ...(oauthRequest.credential.metadata ?? {}),
        oauthAuthorizeOrigin: new URL(oauthRequest.flow.authorizeUrl).origin,
        oauthTokenOrigin: new URL(oauthRequest.flow.tokenUrl).origin,
        ...(oauthRequest.flow.accountValidation?.userinfo?.url
          ? {
              oauthUserinfoOrigin: new URL(oauthRequest.flow.accountValidation.userinfo.url).origin,
            }
          : {}),
      };
      const approvalDecision = await requestCredentialApproval(ctx, {
        credentialId: randomUUID(),
        credentialLabel: oauthRequest.credential.label,
        audience,
        injection,
        accountIdentity: normalizeAccountIdentity(
          oauthRequest.credential.accountIdentity,
          ctx.caller.runtime.id
        ),
        scopes: oauthRequest.credential.scopes ?? oauthRequest.flow.scopes ?? [],
        identity,
        signal,
        metadata,
      });
      throwIfAborted(signal);
      await transitionOAuthTransaction(tx, "approved");
      const started = createOAuthAuthorizeRequest(oauthRequest, stateParam);
      callback?.expectState(started.state);
      const openMode = request.browser ?? "external";
      if (
        (redirectStrategy === "client-loopback" || redirectStrategy === "app-scheme") &&
        openMode !== "external"
      ) {
        throw new OAuthConnectionError(
          "unsupported_browser_mode",
          `${redirectStrategy} OAuth requires an external browser`
        );
      }
      const browserResolution = await resolveBrowserHandoffTarget(ctx, explicitHandoffTarget);
      const browserTarget = browserResolution.target;
      if (!browserTarget) {
        throw new OAuthConnectionError(
          "browser_unavailable",
          browserHandoffUnavailableMessage(browserResolution.diagnostics)
        );
      }
      if (redirectStrategy === "client-loopback" || redirectStrategy === "app-scheme") {
        tx.deliveryCallerId = browserTarget.deliveryCallerId;
        tx.deliveryCallerKind = browserTarget.deliveryCallerKind;
      }
      const openPayload = {
        url: started.authorizeUrl,
        callerId: ctx.caller.runtime.id,
        callerKind: ctx.caller.runtime.kind,
        ...(redirectStrategy === "client-loopback"
          ? { oauthLoopback: buildClientLoopbackHandoff(tx, started.state) }
          : {}),
        ...(redirectStrategy === "app-scheme"
          ? { oauthAppScheme: buildAppSchemeHandoff(tx, started.state) }
          : {}),
      };
      let browserDelivery: BrowserHandoffDeliveryResult;
      if (openMode === "internal") {
        if (!browserTarget.parentPanelId) {
          throw new OAuthConnectionError(
            "browser_unavailable",
            "Internal OAuth handoff requires a panel target"
          );
        }
        browserDelivery = emitToBrowserTarget(browserTarget, "browser-panel:open", {
          url: started.authorizeUrl,
          parentPanelId: browserTarget.parentPanelId,
          callerId: ctx.caller.runtime.id,
          callerKind: ctx.caller.runtime.kind,
        });
      } else {
        browserDelivery = emitToBrowserTarget(browserTarget, "external-open:open", openPayload);
      }
      if (!browserDelivery.delivered) {
        throw new OAuthConnectionError(
          "browser_unavailable",
          browserHandoffUnavailableMessage(browserResolution.diagnostics, browserDelivery)
        );
      }
      await transitionOAuthTransaction(tx, "browser_open_requested");
      if (callback) {
        const callbackResult = await abortable(callback.wait, signal, () => callback?.close());
        await receiveOAuthCallback(tx, callbackResult);
      }
      const result = await abortable(tx.wait, signal);
      await transitionOAuthTransaction(tx, "exchanging");
      const token = await exchangeOAuthCode(oauthRequest, result.code, started.codeVerifier);
      await transitionOAuthTransaction(tx, "validating_account");
      const validatedAccountIdentity = await validateOAuthAccountIdentity(
        oauthRequest,
        token.accessToken
      );
      const accountIdentity = {
        ...deriveAccountIdentityFromJwt(token.accessToken, oauthRequest.credential.metadata),
        ...validatedAccountIdentity,
        ...(oauthRequest.credential.accountIdentity ?? {}),
      };
      const duplicate = await findReplacementCandidate(ctx, {
        label: oauthRequest.credential.label,
        audience: oauthRequest.credential.audience,
        metadata: oauthRequest.credential.metadata,
        accountIdentity,
      });
      const stored = await storeCredential(
        ctx,
        {
          label: oauthRequest.credential.label,
          audience: oauthRequest.credential.audience,
          injection: oauthRequest.credential.injection,
          bindings: oauthRequest.credential.bindings,
          material: { type: "bearer-token", token: token.accessToken },
          ...oauthRefreshMaterial({
            refreshToken: token.refreshToken,
            tokenUrl: oauthRequest.flow.tokenUrl,
            clientId: oauthRequest.flow.clientId,
            tokenAuth: oauthRequest.tokenAuth,
            clientConfig: oauthRequest.clientConfig,
          }),
          accountIdentity,
          scopes: grantedOAuthScopes({
            tokenScopes: token.scopes,
            requestedScopes: oauthRequest.flow.scopes,
            declaredScopes: oauthRequest.credential.scopes,
          }),
          expiresAt: token.expiresAt,
          metadata: {
            ...(oauthRequest.credential.metadata ?? {}),
            oauthAuthorizeOrigin: new URL(oauthRequest.flow.authorizeUrl).origin,
            oauthTokenOrigin: new URL(oauthRequest.flow.tokenUrl).origin,
            ...(oauthRequest.flow.revocationUrl
              ? { oauthRevocationUrl: oauthRequest.flow.revocationUrl }
              : {}),
            ...(oauthRequest.flow.accountValidation?.userinfo?.url
              ? {
                  oauthUserinfoOrigin: new URL(oauthRequest.flow.accountValidation.userinfo.url)
                    .origin,
                }
              : {}),
          },
        },
        {
          approvalDecision: duplicate ? undefined : approvalDecision,
          preapprovedUseDecision: approvalDecision,
          replaceCredentialId: duplicate?.id,
          replacementCredentialLabel: duplicate?.label ?? duplicate?.connectionLabel,
        }
      );
      await transitionOAuthTransaction(tx, "stored");
      await transitionOAuthTransaction(tx, "completed");
      oauthTransactions.delete(tx.id);
      return stored;
    } catch (error) {
      if (tx && !["completed", "failed", "expired", "cancelled"].includes(tx.state)) {
        await transitionOAuthTransaction(tx, "failed", errorCodeForOAuthError(error));
      }
      throw error;
    } finally {
      callback?.close();
    }
  }

  async function resolveAuthCodeConnectionRequest(
    request: AuthCodeConnectRequest,
    redirectUri: string
  ): Promise<InternalOAuthConnectionRequest> {
    if (request.flow.clientConfigId) {
      const config = await loadClientConfigForFlow(
        request.flow.clientConfigId,
        "oauth2-auth-code-pkce"
      );
      const clientId = config.fields["clientId"]?.value;
      const clientSecret = config.fields["clientSecret"]?.value;
      const privateKeyPem = config.fields["privateKeyPem"]?.value;
      const keyId = config.fields["keyId"]?.value;
      const keyAlgorithm = config.fields["algorithm"]?.value;
      const clientConfig = {
        configId: request.flow.clientConfigId,
        configVersion: config.currentVersion ?? String(config.updatedAt),
      };
      const tokenAuth = request.tokenAuth ?? (clientSecret ? "client_secret_post" : "none");
      if (!clientId) {
        throw new OAuthConnectionError("client_config_unavailable");
      }
      if (tokenAuth !== "none" && !clientSecret) {
        if (tokenAuth === "private_key_jwt" && privateKeyPem) {
          return {
            flow: {
              authorizeUrl: canonicalUrl(config.authorizeUrl),
              tokenUrl: canonicalUrl(config.tokenUrl),
              clientId,
              privateKeyPem,
              ...(keyId ? { keyId } : {}),
              ...(keyAlgorithm ? { keyAlgorithm } : {}),
              scopes: request.flow.scopes,
              extraAuthorizeParams: request.flow.extraAuthorizeParams,
              allowMissingExpiry: request.flow.allowMissingExpiry,
              persistRefreshToken: request.flow.persistRefreshToken,
              accountValidation: request.flow.accountValidation,
              revocationUrl: request.flow.revocationUrl,
            },
            credential: request.credential,
            redirectUri,
            tokenAuth,
            clientConfig,
          };
        }
        throw new OAuthConnectionError("client_config_unavailable");
      }
      return {
        flow: {
          authorizeUrl: canonicalUrl(config.authorizeUrl),
          tokenUrl: canonicalUrl(config.tokenUrl),
          clientId,
          ...(clientSecret ? { clientSecret } : {}),
          scopes: request.flow.scopes,
          extraAuthorizeParams: request.flow.extraAuthorizeParams,
          allowMissingExpiry: request.flow.allowMissingExpiry,
          persistRefreshToken: request.flow.persistRefreshToken,
          accountValidation: request.flow.accountValidation,
          revocationUrl: request.flow.revocationUrl,
        },
        credential: request.credential,
        redirectUri,
        tokenAuth,
        clientConfig,
      };
    }
    if (request.tokenAuth !== "none") {
      throw new OAuthConnectionError("unsupported_token_auth_method");
    }
    return {
      flow: {
        authorizeUrl: request.flow.authorizeUrl ?? "",
        tokenUrl: request.flow.tokenUrl ?? "",
        clientId: request.flow.clientId ?? "",
        scopes: request.flow.scopes,
        extraAuthorizeParams: request.flow.extraAuthorizeParams,
        allowMissingExpiry: request.flow.allowMissingExpiry,
        persistRefreshToken: request.flow.persistRefreshToken,
        accountValidation: request.flow.accountValidation,
        revocationUrl: request.flow.revocationUrl,
      },
      credential: request.credential,
      redirectUri,
      tokenAuth: request.tokenAuth,
    };
  }

  async function loadClientConfigForFlow(
    configId: string,
    flowType: CredentialFlowType
  ): Promise<ClientConfigRecord> {
    const config = await clientConfigStore.load(configId);
    if (!config || config.status === "deleted" || config.status === "disabled") {
      throw new OAuthConnectionError("client_config_unavailable");
    }
    if (config.flowTypes?.length && !config.flowTypes.includes(flowType)) {
      throw new OAuthConnectionError("client_not_authorized");
    }
    return config;
  }

  async function exchangeOAuthCode(
    request: InternalOAuthConnectionRequest,
    code: string,
    codeVerifier: string | undefined
  ): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
  }> {
    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("code", code);
    if (codeVerifier) {
      body.set("code_verifier", codeVerifier);
    }
    body.set("client_id", request.flow.clientId);
    applyOAuthClientAssertion(body, {
      tokenUrl: request.flow.tokenUrl,
      clientId: request.flow.clientId,
      privateKeyPem: request.flow.privateKeyPem,
      keyId: request.flow.keyId,
      keyAlgorithm: request.flow.keyAlgorithm,
      tokenAuth: request.tokenAuth,
    });
    if (request.flow.clientSecret && request.tokenAuth === "client_secret_post") {
      body.set("client_secret", request.flow.clientSecret);
    }
    body.set("redirect_uri", request.redirectUri);
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (request.flow.clientSecret && request.tokenAuth === "client_secret_basic") {
      headers["authorization"] = basicAuthHeader(request.flow.clientId, request.flow.clientSecret);
    }

    const tokenResponse = await fetch(request.flow.tokenUrl, {
      method: "POST",
      headers,
      body,
    });
    const tokenText = await tokenResponse.text();
    const tokenData = parseJsonObject(tokenText, { strict: tokenResponse.ok });
    if (!tokenResponse.ok) {
      throw oauthConnectionError(
        "token_exchange_failed",
        formatOAuthTokenExchangeError(tokenResponse.status, tokenData, tokenText)
      );
    }
    if (typeof tokenData?.["error"] === "string") {
      throw oauthConnectionError(
        "token_exchange_failed",
        `OAuth token exchange failed: ${tokenData["error"]}`
      );
    }

    return parseBearerTokenResponse(tokenData, {
      allowMissingExpiry: request.flow.allowMissingExpiry,
      persistRefreshToken: request.flow.persistRefreshToken,
    });
  }

  async function exchangeClientCredentialsToken(params: {
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    privateKeyPem?: string;
    keyId?: string;
    keyAlgorithm?: string;
    tokenAuth: "client_secret_post" | "client_secret_basic" | "private_key_jwt";
    scopes?: string[];
    audienceParam?: string;
    resourceParam?: string;
  }): Promise<{ accessToken: string; expiresAt?: number; scopes?: string[] }> {
    const body = new URLSearchParams();
    body.set("grant_type", "client_credentials");
    body.set("client_id", params.clientId);
    applyOAuthClientAssertion(body, params);
    if (params.tokenAuth === "client_secret_post" && params.clientSecret) {
      body.set("client_secret", params.clientSecret);
    }
    if (params.scopes?.length) {
      body.set("scope", params.scopes.join(" "));
    }
    if (params.audienceParam) {
      body.set("audience", params.audienceParam);
    }
    if (params.resourceParam) {
      body.set("resource", params.resourceParam);
    }
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (params.tokenAuth === "client_secret_basic" && params.clientSecret) {
      headers["authorization"] = basicAuthHeader(params.clientId, params.clientSecret);
    }
    const response = await fetch(params.tokenUrl, { method: "POST", headers, body });
    const text = await response.text();
    const data = parseJsonObject(text, { strict: response.ok });
    if (!response.ok || typeof data?.["error"] === "string") {
      throw oauthConnectionError(
        "token_exchange_failed",
        formatOAuthTokenExchangeError(response.status, data, text)
      );
    }
    const parsed = parseBearerTokenResponse(data, { allowMissingExpiry: false });
    return {
      accessToken: parsed.accessToken,
      expiresAt: parsed.expiresAt,
      scopes: parsed.scopes,
    };
  }

  async function exchangeJwtBearerToken(params: {
    tokenUrl: string;
    clientId: string;
    privateKeyPem: string;
    keyId?: string;
    keyAlgorithm?: string;
    issuer: string;
    subject: string;
    audience: string;
    scopes?: string[];
    persistRefreshToken?: boolean;
  }): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
  }> {
    const assertion = signJwtAssertion({
      issuer: params.issuer,
      subject: params.subject,
      audience: params.audience,
      privateKeyPem: params.privateKeyPem,
      keyId: params.keyId,
      keyAlgorithm: params.keyAlgorithm,
    });
    const body = new URLSearchParams();
    body.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer");
    body.set("assertion", assertion);
    body.set("client_id", params.clientId);
    if (params.scopes?.length) {
      body.set("scope", params.scopes.join(" "));
    }
    const response = await fetch(params.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const text = await response.text();
    const data = parseJsonObject(text, { strict: response.ok });
    if (!response.ok || typeof data?.["error"] === "string") {
      throw oauthConnectionError(
        "token_exchange_failed",
        formatOAuthTokenExchangeError(response.status, data, text)
      );
    }
    return parseBearerTokenResponse(data, {
      allowMissingExpiry: false,
      persistRefreshToken: params.persistRefreshToken,
    });
  }

  async function exchangeOAuthToken(params: {
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    privateKeyPem?: string;
    keyId?: string;
    keyAlgorithm?: string;
    tokenAuth: "client_secret_post" | "client_secret_basic" | "private_key_jwt";
    subjectToken: string;
    subjectTokenType: "access_token" | "jwt";
    requestedTokenType?: string;
    scopes?: string[];
    audience?: string;
    resource?: string;
    persistRefreshToken?: boolean;
  }): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
  }> {
    const body = new URLSearchParams();
    body.set("grant_type", "urn:ietf:params:oauth:grant-type:token-exchange");
    body.set("subject_token", params.subjectToken);
    body.set(
      "subject_token_type",
      params.subjectTokenType === "jwt"
        ? "urn:ietf:params:oauth:token-type:jwt"
        : "urn:ietf:params:oauth:token-type:access_token"
    );
    body.set("client_id", params.clientId);
    if (params.requestedTokenType) body.set("requested_token_type", params.requestedTokenType);
    if (params.scopes?.length) body.set("scope", params.scopes.join(" "));
    if (params.audience) body.set("audience", params.audience);
    if (params.resource) body.set("resource", params.resource);
    applyOAuthClientAssertion(body, params);
    if (params.tokenAuth === "client_secret_post" && params.clientSecret) {
      body.set("client_secret", params.clientSecret);
    }
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (params.tokenAuth === "client_secret_basic" && params.clientSecret) {
      headers["authorization"] = basicAuthHeader(params.clientId, params.clientSecret);
    }
    const response = await fetch(params.tokenUrl, { method: "POST", headers, body });
    const text = await response.text();
    const data = parseJsonObject(text, { strict: response.ok });
    if (!response.ok || typeof data?.["error"] === "string") {
      throw oauthConnectionError(
        "token_exchange_failed",
        formatOAuthTokenExchangeError(response.status, data, text)
      );
    }
    return parseBearerTokenResponse(data, {
      allowMissingExpiry: false,
      persistRefreshToken: params.persistRefreshToken,
    });
  }

  async function requestDeviceAuthorization(params: {
    deviceAuthorizationUrl: string;
    clientId: string;
    clientSecret?: string;
    privateKeyPem?: string;
    keyId?: string;
    keyAlgorithm?: string;
    tokenAuth: "none" | "client_secret_post" | "client_secret_basic" | "private_key_jwt";
    scopes?: string[];
    signal?: AbortSignal;
  }): Promise<{
    deviceCode: string;
    userCode?: string;
    verificationUri: string;
    verificationUriComplete?: string;
    intervalSeconds: number;
    expiresInSeconds: number;
  }> {
    const body = new URLSearchParams();
    body.set("client_id", params.clientId);
    if (params.scopes?.length) {
      body.set("scope", params.scopes.join(" "));
    }
    applyOAuthClientAssertion(body, {
      tokenUrl: params.deviceAuthorizationUrl,
      clientId: params.clientId,
      privateKeyPem: params.privateKeyPem,
      keyId: params.keyId,
      keyAlgorithm: params.keyAlgorithm,
      tokenAuth: params.tokenAuth,
    });
    if (params.clientSecret && params.tokenAuth === "client_secret_post") {
      body.set("client_secret", params.clientSecret);
    }
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (params.clientSecret && params.tokenAuth === "client_secret_basic") {
      headers["authorization"] = basicAuthHeader(params.clientId, params.clientSecret);
    }
    const response = await fetch(params.deviceAuthorizationUrl, {
      method: "POST",
      headers,
      body,
      signal: params.signal,
    });
    const text = await response.text();
    const data = parseJsonObject(text, { strict: response.ok });
    if (!response.ok || typeof data?.["error"] === "string") {
      throw oauthConnectionError(
        "device_authorization_failed",
        formatOAuthTokenExchangeError(response.status, data, text)
      );
    }
    const deviceCode = data?.["device_code"];
    const verificationUri = data?.["verification_uri"] ?? data?.["verification_url"];
    if (typeof deviceCode !== "string" || typeof verificationUri !== "string") {
      throw new OAuthConnectionError("invalid_token_response");
    }
    const userCode = data?.["user_code"];
    const verificationUriComplete = data?.["verification_uri_complete"];
    return {
      deviceCode,
      ...(typeof userCode === "string" ? { userCode } : {}),
      verificationUri,
      ...(typeof verificationUriComplete === "string" ? { verificationUriComplete } : {}),
      intervalSeconds: readNumericField(data?.["interval"]) ?? 5,
      expiresInSeconds: readNumericField(data?.["expires_in"]) ?? 900,
    };
  }

  async function pollDeviceToken(params: {
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    privateKeyPem?: string;
    keyId?: string;
    keyAlgorithm?: string;
    tokenAuth: "none" | "client_secret_post" | "client_secret_basic" | "private_key_jwt";
    deviceCode: string;
    intervalSeconds: number;
    expiresInSeconds: number;
    persistRefreshToken?: boolean;
    cancelSignal?: AbortSignal;
  }): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
  }> {
    let intervalMs = Math.max(1, params.intervalSeconds) * 1000;
    const deadline = Date.now() + Math.max(1, params.expiresInSeconds) * 1000;
    while (Date.now() < deadline) {
      if (params.cancelSignal?.aborted) {
        throw new OAuthConnectionError("approval_denied");
      }
      await delay(intervalMs, params.cancelSignal);
      if (params.cancelSignal?.aborted) {
        throw new OAuthConnectionError("approval_denied");
      }
      const body = new URLSearchParams();
      body.set("grant_type", "urn:ietf:params:oauth:grant-type:device_code");
      body.set("device_code", params.deviceCode);
      body.set("client_id", params.clientId);
      applyOAuthClientAssertion(body, params);
      if (params.clientSecret && params.tokenAuth === "client_secret_post") {
        body.set("client_secret", params.clientSecret);
      }
      const headers: Record<string, string> = {
        "content-type": "application/x-www-form-urlencoded",
      };
      if (params.clientSecret && params.tokenAuth === "client_secret_basic") {
        headers["authorization"] = basicAuthHeader(params.clientId, params.clientSecret);
      }
      const response = await fetch(params.tokenUrl, {
        method: "POST",
        headers,
        body,
        signal: params.cancelSignal,
      });
      const text = await response.text();
      const data = parseJsonObject(text, { strict: response.ok });
      const error = data?.["error"];
      if (response.ok && typeof error !== "string") {
        return parseBearerTokenResponse(data, {
          allowMissingExpiry: false,
          persistRefreshToken: params.persistRefreshToken,
        });
      }
      if (error === "authorization_pending") {
        continue;
      }
      if (error === "slow_down") {
        intervalMs += 5_000;
        continue;
      }
      if (error === "access_denied") {
        throw new OAuthConnectionError("approval_denied");
      }
      if (error === "expired_token") {
        throw new OAuthConnectionError("device_code_expired");
      }
      throw oauthConnectionError(
        "token_exchange_failed",
        formatOAuthTokenExchangeError(response.status, data, text)
      );
    }
    throw new OAuthConnectionError("device_code_expired");
  }

  async function exchangeOAuth1RequestToken(params: {
    requestTokenUrl: string;
    consumerKey: string;
    consumerSecret: string;
    callbackUrl: string;
  }): Promise<{ token: string; secret: string }> {
    const url = new URL(params.requestTokenUrl);
    const auth = oauth1AuthorizationHeader({
      method: "POST",
      url,
      consumerKey: params.consumerKey,
      consumerSecret: params.consumerSecret,
      extraOAuthParams: { oauth_callback: params.callbackUrl },
    });
    const response = await fetch(url, { method: "POST", headers: { authorization: auth } });
    const text = await response.text();
    if (!response.ok) {
      throw oauthConnectionError("token_exchange_failed", sanitizeOAuthErrorText(text));
    }
    const data = new URLSearchParams(text);
    const token = data.get("oauth_token");
    const secret = data.get("oauth_token_secret");
    if (!token || !secret) {
      throw new OAuthConnectionError("invalid_token_response");
    }
    return { token, secret };
  }

  async function exchangeOAuth1AccessToken(params: {
    accessTokenUrl: string;
    consumerKey: string;
    consumerSecret: string;
    requestToken: string;
    requestTokenSecret: string;
    verifier: string;
  }): Promise<{ token: string; secret: string }> {
    const url = new URL(params.accessTokenUrl);
    const auth = oauth1AuthorizationHeader({
      method: "POST",
      url,
      consumerKey: params.consumerKey,
      consumerSecret: params.consumerSecret,
      token: params.requestToken,
      tokenSecret: params.requestTokenSecret,
      extraOAuthParams: { oauth_verifier: params.verifier },
    });
    const response = await fetch(url, { method: "POST", headers: { authorization: auth } });
    const text = await response.text();
    if (!response.ok) {
      throw oauthConnectionError("token_exchange_failed", sanitizeOAuthErrorText(text));
    }
    const data = new URLSearchParams(text);
    const token = data.get("oauth_token");
    const secret = data.get("oauth_token_secret");
    if (!token || !secret) {
      throw new OAuthConnectionError("invalid_token_response");
    }
    return { token, secret };
  }

  async function createOAuthTransaction(
    ctx: ServiceContext,
    params: {
      id?: string;
      redirectUri: string;
      redirectStrategy: OAuthConnectionTransaction["redirectStrategy"];
      stateParam: string;
      deliveryCallerId?: string;
      deliveryCallerKind?: BrowserDeliveryCallerKind;
    }
  ): Promise<OAuthConnectionTransaction> {
    const identity = resolveApprovalIdentity(ctx);
    const id = params.id ?? randomUUID();
    let resolve!: OAuthConnectionTransaction["resolve"];
    let reject!: OAuthConnectionTransaction["reject"];
    const wait = new Promise<{ code: string; state: string; url: string }>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    void wait.catch(() => undefined);
    const tx: OAuthConnectionTransaction = {
      id,
      state: "created",
      createdAt: Date.now(),
      expiresAt: Date.now() + PENDING_OAUTH_TTL_MS,
      callerId: ctx.caller.runtime.id,
      callerKind: ctx.caller.runtime.kind,
      repoPath: identity.repoPath,
      effectiveVersion: identity.effectiveVersion,
      stateParam: params.stateParam,
      redirectUri: params.redirectUri,
      redirectStrategy: params.redirectStrategy,
      deliveryCallerId: params.deliveryCallerId,
      deliveryCallerKind: params.deliveryCallerKind,
      callbackUsed: false,
      resolve,
      reject,
      wait,
      timer: setTimeout(() => {
        void transitionOAuthTransaction(tx, "expired", "transaction_expired");
        oauthTransactions.delete(tx.id);
        reject(new OAuthConnectionError("callback_timeout"));
      }, PENDING_OAUTH_TTL_MS),
    };
    oauthTransactions.set(id, tx);
    await transitionOAuthTransaction(tx, "created");
    wait.finally(() => clearTimeout(tx.timer)).catch(() => undefined);
    return tx;
  }

  async function transitionOAuthTransaction(
    tx: OAuthConnectionTransaction,
    to: OAuthConnectionTransactionState,
    errorCode?: OAuthConnectionErrorCode
  ): Promise<void> {
    const from = tx.state;
    if (from === to && to !== "created") {
      return;
    }
    tx.state = to;
    await appendAudit({
      type: "oauth_connection_transaction.transition",
      ts: Date.now(),
      callerId: tx.callerId,
      transactionId: tx.id,
      from: from === to ? undefined : from,
      to,
      errorCode,
    });
  }

  async function receiveOAuthCallback(
    tx: OAuthConnectionTransaction,
    callback: { code?: string | null; state?: string | null; error?: string | null; url: string }
  ): Promise<void> {
    if (
      tx.callbackUsed ||
      tx.state === "callback_received" ||
      tx.state === "exchanging" ||
      tx.state === "completed" ||
      tx.state === "failed" ||
      tx.state === "cancelled" ||
      tx.state === "expired"
    ) {
      await transitionOAuthTransaction(tx, "failed", "transaction_replayed");
      tx.reject(new OAuthConnectionError("transaction_replayed"));
      return;
    }
    if (Date.now() > tx.expiresAt) {
      await transitionOAuthTransaction(tx, "expired", "transaction_expired");
      oauthTransactions.delete(tx.id);
      tx.reject(new OAuthConnectionError("transaction_expired"));
      return;
    }
    if (!callback.state || callback.state !== tx.stateParam) {
      await transitionOAuthTransaction(tx, "failed", "state_mismatch");
      tx.reject(new OAuthConnectionError("state_mismatch"));
      return;
    }
    if (!isExpectedRedirectCallback(tx, callback.url)) {
      await transitionOAuthTransaction(tx, "failed", "redirect_mismatch");
      tx.reject(new OAuthConnectionError("redirect_mismatch"));
      return;
    }
    if (callback.error) {
      await transitionOAuthTransaction(tx, "cancelled", "approval_denied");
      tx.reject(new OAuthConnectionError("approval_denied", callback.error));
      return;
    }
    if (!callback.code) {
      await transitionOAuthTransaction(tx, "failed", "invalid_token_response");
      tx.reject(new OAuthConnectionError("invalid_token_response"));
      return;
    }
    tx.callbackUsed = true;
    await transitionOAuthTransaction(tx, "callback_received");
    tx.resolve({ code: callback.code, state: callback.state, url: callback.url });
  }

  function findOAuthTransactionByState(
    state: string | undefined
  ): OAuthConnectionTransaction | undefined {
    if (!state) return undefined;
    for (const tx of oauthTransactions.values()) {
      if (tx.stateParam === state) return tx;
    }
    return undefined;
  }

  /**
   * Announce a relay-routed transaction to the apex relay over the backhaul.
   * `public` = desktop (the relay pushes {state,code} back down the backhaul);
   * `client-forwarded` = mobile (the app forwards over the pipe — we still
   * register so a failed deep-link renders a truthful landing).
   */
  function registerRelayOAuthIfNeeded(tx: OAuthConnectionTransaction): void {
    if (!deps.relayOAuthRegistrar) return;
    if (tx.redirectStrategy === "public") {
      deps.relayOAuthRegistrar.register(tx.id, "desktop");
    } else if (tx.redirectStrategy === "client-forwarded") {
      deps.relayOAuthRegistrar.register(tx.id, "mobile");
    }
  }

  /**
   * Resolve a desktop OAuth transaction whose callback the relay pushed down the
   * backhaul. Called by the relay backhaul client (NOT via RPC), so it resolves
   * the pending in-memory transaction directly. Unknown/expired ids and non-
   * desktop strategies are ignored (fail closed): the relay landing already
   * responded, and a mismatched strategy means the callback arrived on the wrong
   * path (a mobile tx must forward over the pipe, never the backhaul).
   */
  async function resolveRelayOAuthCallback(frame: {
    transactionId: string;
    state?: string;
    code?: string;
    error?: string;
  }): Promise<void> {
    const tx = oauthTransactions.get(frame.transactionId);
    if (!tx) {
      log.warn("relay OAuth callback for unknown/expired transaction", {
        transactionId: frame.transactionId,
      });
      return;
    }
    if (tx.redirectStrategy !== "public") {
      log.warn("relay OAuth callback on backhaul for a non-desktop transaction; ignoring", {
        transactionId: frame.transactionId,
        redirectStrategy: tx.redirectStrategy,
      });
      return;
    }
    await receiveOAuthCallback(tx, {
      code: frame.code ?? null,
      state: frame.state ?? null,
      error: frame.error ?? null,
      url: tx.redirectUri,
    });
  }

  return {
    connect: connectCredential,
    forwardOAuthCallback,
    cancelOAuth,
    resolveRelayOAuthCallback,
  };
}

async function validateOAuthAccountIdentity(
  request: InternalOAuthConnectionRequest,
  accessToken: string
): Promise<Partial<AccountIdentity>> {
  const spec = request.flow.accountValidation?.userinfo;
  if (!spec) {
    return {};
  }
  const userinfoUrl = canonicalUrl(spec.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OAUTH_USERINFO_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(userinfoUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new OAuthConnectionError(
        "account_validation_failed",
        "OAuth account validation timed out"
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  const data = parseJsonObject(text, { strict: response.ok });
  if (!response.ok || !data) {
    throw new OAuthConnectionError("account_validation_failed", "OAuth account validation failed");
  }
  const identity: Partial<AccountIdentity> = {};
  const idValue = readStringClaim(data, spec.idField ?? "sub");
  const email = readStringClaim(data, spec.emailField ?? "email");
  const username = readStringClaim(data, spec.usernameField ?? "preferred_username");
  const workspaceName = spec.workspaceField
    ? readStringClaim(data, spec.workspaceField)
    : undefined;
  if (idValue) identity.providerUserId = idValue;
  if (email) identity.email = email;
  if (username) identity.username = username;
  if (workspaceName) identity.workspaceName = workspaceName;
  if (!identity.providerUserId && (identity.email || identity.username)) {
    identity.providerUserId = identity.email ?? identity.username;
  }
  if (!identity.providerUserId) {
    throw new OAuthConnectionError(
      "account_validation_failed",
      "OAuth account validation did not return an account identity"
    );
  }
  return identity;
}

interface HostOAuthCallback {
  redirectUri: string;
  wait: Promise<{ code?: string; state: string; url: string; error?: string }>;
  expectState(state: string): void;
  close(): void;
}

async function createLoopbackOAuthCallback(opts: {
  host: string;
  port: number;
  callbackPath: string;
  allowDynamicPortFallback: boolean;
  signal?: AbortSignal;
}): Promise<HostOAuthCallback> {
  try {
    return await bindLoopbackOAuthCallback(
      opts.host,
      opts.port,
      normalizeCallbackPath(opts.callbackPath),
      opts.signal
    );
  } catch (error) {
    if (
      opts.port > 0 &&
      opts.allowDynamicPortFallback &&
      error instanceof Error &&
      /address in use|EADDRINUSE|already in use/i.test(error.message)
    ) {
      return bindLoopbackOAuthCallback(
        opts.host,
        0,
        normalizeCallbackPath(opts.callbackPath),
        opts.signal
      );
    }
    if (error instanceof Error && /address in use|EADDRINUSE|already in use/i.test(error.message)) {
      throw new Error("redirect_unavailable");
    }
    throw error;
  }
}

async function bindLoopbackOAuthCallback(
  host: string,
  port: number,
  callbackPath: string,
  signal?: AbortSignal
): Promise<HostOAuthCallback> {
  let expectedState: string | undefined;
  let settled = false;
  let redirectUri = "";
  let resolve!: (value: { code?: string; state: string; url: string; error?: string }) => void;
  let reject!: (error: Error) => void;
  const wait = new Promise<{ code?: string; state: string; url: string; error?: string }>(
    (res, rej) => {
      resolve = res;
      reject = rej;
    }
  );
  void wait.catch(() => undefined);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", redirectUri);
    if (url.pathname !== callbackPath) {
      respondOAuthCallback(res, 404, "not found");
      return;
    }
    const state = url.searchParams.get("state");
    if (!state || (expectedState && state !== expectedState)) {
      respondOAuthCallback(res, 400, "OAuth state mismatch.");
      if (!settled) {
        settled = true;
        reject(oauthConnectionError("state_mismatch", "state_mismatch"));
      }
      return;
    }
    const providerError = url.searchParams.get("error");
    if (providerError) {
      respondOAuthCallback(res, 400, "The provider denied the connection.");
      if (!settled) {
        settled = true;
        resolve({ state, error: providerError, url: url.toString() });
      }
      return;
    }
    const code = url.searchParams.get("code") ?? url.searchParams.get("oauth_verifier");
    if (!code) {
      respondOAuthCallback(res, 400, "Missing authorization code.");
      if (!settled) {
        settled = true;
        reject(oauthConnectionError("invalid_token_response", "invalid_token_response"));
      }
      return;
    }
    respondOAuthCallback(res, 200, "Connection complete. You can close this window.");
    if (!settled) {
      settled = true;
      resolve({ code, state, url: url.toString() });
    }
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, resolveListen);
  });
  const abort = () => {
    if (settled) return;
    settled = true;
    reject(oauthConnectionError("approval_denied", "Credential connection cancelled"));
    server.close();
  };
  if (signal?.aborted) {
    abort();
  } else {
    signal?.addEventListener("abort", abort, { once: true });
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    signal?.removeEventListener("abort", abort);
    server.close();
    throw new Error("Failed to bind OAuth callback server");
  }
  redirectUri = `http://${host}:${address.port}${callbackPath}`;
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      reject(oauthConnectionError("callback_timeout", "callback_timeout"));
    }
    server.close();
  }, PENDING_OAUTH_TTL_MS);
  wait
    .finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      server.close();
    })
    .catch(() => undefined);
  return {
    redirectUri,
    wait,
    expectState(state: string) {
      expectedState = state;
    },
    close() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      server.close();
    },
  };
}

function normalizeCallbackPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function respondOAuthCallback(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

function isExpectedRedirectCallback(tx: { redirectUri: string }, callbackUrl: string): boolean {
  try {
    const expected = new URL(tx.redirectUri);
    const actual = new URL(callbackUrl);
    return (
      actual.protocol === expected.protocol &&
      actual.host === expected.host &&
      actual.pathname === expected.pathname
    );
  } catch {
    return false;
  }
}

function errorCodeForOAuthError(error: unknown): OAuthConnectionErrorCode {
  if (error instanceof OAuthConnectionError) {
    return error.code;
  }
  if (error instanceof CredentialLifecycleError) {
    return error.code;
  }
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  if (typeof code === "string" && isOAuthConnectionErrorCode(code)) {
    return code;
  }
  return "token_exchange_failed";
}

function isOAuthConnectionErrorCode(value: string): value is OAuthConnectionErrorCode {
  return [
    "unsupported_flow",
    "invalid_connection_spec",
    "approval_denied",
    "browser_unavailable",
    "unsupported_browser_mode",
    "callback_timeout",
    "state_mismatch",
    "redirect_mismatch",
    "token_exchange_failed",
    "invalid_token_response",
    "unsupported_token_auth_method",
    "account_validation_failed",
    "transaction_replayed",
    "transaction_expired",
    "client_config_unavailable",
    "client_not_authorized",
    "device_authorization_failed",
    "device_code_expired",
    "oauth1_signature_failed",
    "session_capture_failed",
    "saml_assertion_failed",
    "unsupported_account_validation",
    "unsupported_injection",
    "ambiguous_credential",
    "credential_conflict",
    "credential_expired_reauth_required",
    "redirect_unavailable",
  ].includes(value);
}

function parseJsonObject(
  text: string,
  opts: { strict?: boolean } = {}
): Record<string, unknown> | null {
  if (!text.trim()) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    if (!opts.strict) {
      return null;
    }
    throw error;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    if (!opts.strict) {
      return null;
    }
    throw new Error("OAuth token exchange returned a non-object JSON response");
  }
  return parsed as Record<string, unknown>;
}

function formatOAuthTokenExchangeError(
  status: number,
  data: Record<string, unknown> | null,
  text: string
): string {
  const details: string[] = [];
  const providerError = data?.["error"];
  const providerDescription = data?.["error_description"];
  if (typeof providerError === "string" && providerError.trim()) {
    details.push(providerError.trim());
  }
  if (typeof providerDescription === "string" && providerDescription.trim()) {
    details.push(providerDescription.trim());
  }
  if (details.length) {
    return `OAuth token exchange failed: ${status} ${details.join(": ")}`;
  }
  const sanitizedText = sanitizeOAuthErrorText(text);
  return sanitizedText
    ? `OAuth token exchange failed: ${status}; response: ${sanitizedText}`
    : `OAuth token exchange failed: ${status}`;
}

function sanitizeOAuthErrorText(text: string): string {
  return text
    .replace(
      /("(?:access_token|refresh_token|id_token|client_secret)"\s*:\s*")[^"]*(")/gi,
      "$1[redacted]$2"
    )
    .replace(/((?:access_token|refresh_token|id_token|client_secret)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
