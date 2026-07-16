import { type RpcCaller, bytesToBase64, base64ToBytes } from "@vibestudio/rpc";
import type {
  ClientConfigStatus,
  ConfigureClientRequest,
  ConnectCredentialRequest,
  CredentialAccessGrantSummary,
  CredentialAccessSubjectSummary,
  CredentialBinding,
  CredentialBindingUse,
  CredentialGrantResourceHint,
  CredentialInjection,
  DeleteClientConfigRequest,
  GetClientConfigStatusRequest,
  GrantUrlBoundCredentialRequest,
  ManagedCredentialSummary,
  ProxyGitHttpRequest,
  ProxyGitHttpResponse,
  RequestCredentialInputRequest,
  ResolveUrlBoundCredentialRequest,
  StoredCredentialLifecycle,
  StoredCredentialSummary,
  StoreUrlBoundCredentialRequest,
  UrlAudience,
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
  DeleteClientConfigRequest,
  GetClientConfigStatusRequest,
  GrantUrlBoundCredentialRequest,
  ManagedCredentialSummary,
  ProxyGitHttpRequest,
  ProxyGitHttpResponse,
  RequestCredentialInputRequest,
  ResolveUrlBoundCredentialRequest,
  StoredCredentialLifecycle,
  StoredCredentialSummary,
  StoreUrlBoundCredentialRequest,
  UrlAudience,
} from "./types.js";

export {
  credentialLifecycle,
  isOAuthRefreshRecipeComplete,
  isStoredCredentialUsable,
} from "./credentialStatus.js";

export interface CredentialClient {
  store(input: StoreUrlBoundCredentialRequest): Promise<StoredCredentialSummary>;
  connect(input: ConnectCredentialRequest): Promise<StoredCredentialSummary>;
  configureClient(input: ConfigureClientRequest): Promise<ClientConfigStatus>;
  requestCredentialInput(input: RequestCredentialInputRequest): Promise<StoredCredentialSummary>;
  getClientConfigStatus(input: GetClientConfigStatusRequest): Promise<ClientConfigStatus>;
  deleteClientConfig(input: DeleteClientConfigRequest | string): Promise<void>;
  listStoredCredentials(): Promise<StoredCredentialSummary[]>;
  inspectStoredCredentials(): Promise<ManagedCredentialSummary[]>;
  revokeCredential(credentialId: string): Promise<void>;
  resolveCredential(
    input: ResolveUrlBoundCredentialRequest
  ): Promise<StoredCredentialSummary | null>;
  fetch(url: string | URL, init?: RequestInit, opts?: { credentialId?: string }): Promise<Response>;
  hookForUrl(
    url: string | URL,
    opts?: { credentialId?: string }
  ): (init?: RequestInit) => Promise<Response>;
  gitHttp(opts?: {
    credentialId?: string;
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

export function createCredentialClient(rpc: RpcCaller): CredentialClient {
  return {
    store(input) {
      return rpc.call<StoredCredentialSummary>("main", "credentials.storeCredential", [input]);
    },
    connect(input) {
      return rpc.call<StoredCredentialSummary>("main", "credentials.connect", [input]);
    },
    configureClient(input) {
      return rpc.call<ClientConfigStatus>("main", "credentials.configureClient", [input]);
    },
    requestCredentialInput(input) {
      return rpc.call<StoredCredentialSummary>("main", "credentials.requestCredentialInput", [
        input,
      ]);
    },
    getClientConfigStatus(input) {
      return rpc.call<ClientConfigStatus>("main", "credentials.getClientConfigStatus", [input]);
    },
    async deleteClientConfig(input) {
      const request = typeof input === "string" ? { configId: input } : input;
      await rpc.call<void>("main", "credentials.deleteClientConfig", [request]);
    },
    listStoredCredentials() {
      return rpc.call<StoredCredentialSummary[]>("main", "credentials.listStoredCredentials", []);
    },
    inspectStoredCredentials() {
      return rpc.call<ManagedCredentialSummary[]>(
        "main",
        "credentials.inspectStoredCredentials",
        []
      );
    },
    async revokeCredential(credentialId) {
      await rpc.call<void>("main", "credentials.revokeCredential", [{ credentialId }]);
    },
    resolveCredential(input) {
      return rpc.call<StoredCredentialSummary | null>("main", "credentials.resolveCredential", [
        input,
      ]);
    },
    fetch(url, init, opts) {
      return proxyFetch(rpc, url, init, opts);
    },
    hookForUrl(url, opts) {
      return (init?: RequestInit) => proxyFetch(rpc, url, init, opts);
    },
    gitHttp(opts) {
      return createGitHttpClient(rpc, opts);
    },
    async forAudience(descriptor) {
      const credential = await resolveByAudienceList(this, descriptor);
      if (!credential) {
        const label = descriptor.label ?? descriptor.audiences[0]?.url ?? "<unknown>";
        const where = descriptor.audiences.map((a) => a.url).join(", ");
        throw new Error(
          `No URL-bound credential found for ${label}. Store one with an audience matching ${where}.`
        );
      }
      const credentialId = credential.id;
      return {
        credentialId,
        fetch: (url, init) => proxyFetch(rpc, url, init, { credentialId }),
      };
    },
  };
}

async function resolveByAudienceList(
  client: Pick<CredentialClient, "resolveCredential">,
  descriptor: UrlAudienceDescriptor
): Promise<StoredCredentialSummary | null> {
  for (const audience of descriptor.audiences) {
    const credential = await client.resolveCredential({
      url: audience.url,
      credentialId: descriptor.credentialId,
    });
    if (credential) return credential;
  }
  return null;
}

export function createGitHttpClient(
  rpc: RpcCaller,
  opts?: { credentialId?: string; gitIntent?: ProxyGitHttpRequest["gitIntent"] }
): GitHttpClient {
  return {
    async request(request) {
      const body = request.body ? await collectGitBody(request.body) : undefined;
      const result = await rpc.call<ProxyGitHttpResponse>("main", "credentials.proxyGitHttp", [
        {
          url: request.url,
          method: request.method ?? "GET",
          headers: request.headers ?? {},
          bodyBase64: body ? bytesToBase64(body) : undefined,
          credentialId: opts?.credentialId,
          gitIntent: opts?.gitIntent,
        } satisfies ProxyGitHttpRequest,
      ]);
      const responseBody = base64ToBytes(result.bodyBase64);
      return {
        url: result.url,
        method: result.method,
        statusCode: result.statusCode,
        statusMessage: result.statusMessage,
        headers: result.headers,
        body: (async function* () {
          yield responseBody;
        })(),
      };
    },
  };
}

async function collectGitBody(body: Uint8Array | AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function proxyFetch(
  rpc: RpcCaller,
  url: string | URL,
  init?: RequestInit,
  opts?: { credentialId?: string }
): Promise<Response> {
  const requestedUrl = url.toString();
  const probe = new Request(requestedUrl, init);
  const headers = Object.fromEntries(probe.headers.entries());
  const encoded = await encodeRequestBody(init?.body);
  const args = {
    url: requestedUrl,
    method: init?.method ?? "GET",
    headers,
    body: encoded.body,
    bodyBase64: encoded.bodyBase64,
    credentialId: opts?.credentialId,
  };
  const response = await rpc.stream("main", "credentials.proxyFetch", [args], {
    signal: init?.signal ?? undefined,
  });
  if (!response.url) {
    try {
      Object.defineProperty(response, "url", {
        value: requestedUrl,
        writable: false,
        configurable: true,
      });
    } catch {
      // Best-effort compatibility with locked Response implementations.
    }
  }
  return response;
}

async function encodeRequestBody(
  body: BodyInit | null | undefined
): Promise<{ body?: string; bodyBase64?: string }> {
  if (body === undefined || body === null) return {};
  if (typeof body === "string") return { body };
  if (body instanceof URLSearchParams) return { body: body.toString() };
  if (body instanceof ArrayBuffer) return { bodyBase64: bytesToBase64(new Uint8Array(body)) };
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return { bodyBase64: bytesToBase64(bytes) };
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return { bodyBase64: bytesToBase64(new Uint8Array(await body.arrayBuffer())) };
  }
  throw new TypeError("credentials.fetch does not support streaming request bodies");
}
