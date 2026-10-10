import type {
  ClientConfigStatus,
  ConfigureClientRequest,
  ConnectCredentialRequest,
  CredentialStoreSummary,
  DeleteClientConfigRequest,
  DeriveUrlBoundCredentialRequest,
  GetClientConfigStatusRequest,
  ManagedCredentialSummary,
  ProxyGitHttpRequest,
  RequestCredentialInputRequest,
  ResolveUrlBoundCredentialRequest,
  StoredCredentialSummary,
  StoreUrlBoundCredentialRequest,
  UrlAudience,
  WebsitePublicationIntent,
  WebsitePublicationProgress,
  WebsitePublicationReceipt,
} from "./types.js";

export type {
  ClientConfigStatus,
  ConfigureClientRequest,
  ConnectCredentialRequest,
  CredentialAccessGrantSummary,
  CredentialAccessSubjectSummary,
  CredentialBinding,
  CredentialBindingUse,
  CredentialGrantResourceHint,
  CredentialInjection,
  CredentialStoreSummary,
  DeleteClientConfigRequest,
  DeriveUrlBoundCredentialRequest,
  GetClientConfigStatusRequest,
  GrantUrlBoundCredentialRequest,
  ManagedCredentialSummary,
  ProxyGitHttpRequest,
  RequestCredentialInputRequest,
  ResolveUrlBoundCredentialRequest,
  StoredCredentialLifecycle,
  StoredCredentialSummary,
  StoreUrlBoundCredentialRequest,
  UrlAudience,
  WebsitePublicationIntent,
  WebsitePublicationPhase,
  WebsitePublicationProgress,
  WebsitePublicationReceipt,
} from "./types.js";

export {
  credentialLifecycle,
  isOAuthRefreshRecipeComplete,
  isStoredCredentialUsable,
} from "./credentialStatus.js";

export interface CredentialClient {
  openWebSocketScope(input: { url: string; credentialId: string }): Promise<{ scopeId: string }>;
  closeWebSocketScope(scopeId: string): Promise<void>;
  store(input: StoreUrlBoundCredentialRequest): Promise<StoredCredentialSummary>;
  connect(input: ConnectCredentialRequest): Promise<StoredCredentialSummary>;
  configureClient(input: ConfigureClientRequest): Promise<ClientConfigStatus>;
  requestCredentialInput(input: RequestCredentialInputRequest): Promise<StoredCredentialSummary>;
  getClientConfigStatus(input: GetClientConfigStatusRequest): Promise<ClientConfigStatus>;
  deleteClientConfig(input: DeleteClientConfigRequest | string): Promise<void>;
  listStoredCredentials(): Promise<StoredCredentialSummary[]>;
  summarizeStoredCredentials(): Promise<CredentialStoreSummary>;
  inspectStoredCredentials(): Promise<ManagedCredentialSummary[]>;
  revokeCredential(credentialId: string): Promise<void>;
  resolveCredential(
    input: ResolveUrlBoundCredentialRequest
  ): Promise<StoredCredentialSummary | null>;
  deriveCredential(input: DeriveUrlBoundCredentialRequest): Promise<StoredCredentialSummary>;
  /**
   * Review one exact publication intent and open or resume its host-journaled
   * operation. Returns the receipt of the last completed phase.
   */
  beginWebsitePublication(
    publication: WebsitePublicationIntent
  ): Promise<WebsitePublicationReceipt>;
  /** Record the next completed phase of an open reviewed publication. */
  recordWebsitePublication(
    publication: WebsitePublicationIntent,
    progress: WebsitePublicationProgress
  ): Promise<WebsitePublicationReceipt>;
  publishFetch(
    publication: WebsitePublicationIntent,
    url: string | URL,
    init?: RequestInit,
    opts?: { credentialId?: string; audiences?: UrlAudience[] }
  ): Promise<Response>;
  fetch(
    url: string | URL,
    init?: RequestInit,
    opts?: { credentialId?: string; audiences?: UrlAudience[] }
  ): Promise<Response>;
  hookForUrl(
    url: string | URL,
    opts?: { credentialId?: string; audiences?: UrlAudience[] }
  ): (init?: RequestInit) => Promise<Response>;
  gitHttp(opts?: {
    /**
     * Omit to resolve a matching credential automatically, pass an id to use
     * that credential, or pass null to make an explicitly anonymous request.
     */
    credentialId?: string | null;
    /**
     * Portable workspace declaration. The host resolves this name and remote
     * coordinate without exposing a concrete credential id to extension state.
     */
    logicalCredential?: { name: string; remoteUrl: string };
    gitIntent?: ProxyGitHttpRequest["gitIntent"];
  }): GitHttpClient;
  forAudience(descriptor: UrlAudienceDescriptor): Promise<UrlCredentialHandle>;
}

export interface UrlAudienceDescriptor {
  audiences: UrlAudience[];
  credentialId?: string;
  label?: string;
}

export interface UrlCredentialHandle {
  credentialId: string;
  fetch(url: string | URL, init?: RequestInit): Promise<Response>;
}

export interface GitHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array | AsyncIterable<Uint8Array>;
}

export interface GitHttpResponse {
  url: string;
  method: string;
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  body: AsyncIterableIterator<Uint8Array>;
}

export interface GitHttpClient {
  request(request: GitHttpRequest): Promise<GitHttpResponse>;
}
