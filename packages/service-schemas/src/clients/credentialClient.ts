import { mainRpcMethods } from "@vibestudio/service-schemas/mainRpc";
import { type RpcCaller, bytesToBase64 } from "@vibestudio/rpc";
import type {} from "../mainRpc.js";
import type {
  CredentialClient,
  UrlAudienceDescriptor,
  GitHttpClient,
  StoredCredentialSummary,
  ProxyGitHttpRequest,
  UrlAudience,
  WebsitePublicationIntent,
} from "@vibestudio/credential-client";
export function createCredentialClient(rpc: RpcCaller): CredentialClient {
  return {
    openWebSocketScope(input) {
      return rpc.call("main", mainRpcMethods["credentials.openWebSocketScope"], [input]);
    },
    async closeWebSocketScope(scopeId) {
      await rpc.call("main", mainRpcMethods["credentials.closeWebSocketScope"], [{ scopeId }]);
    },
    store(input) {
      return rpc.call("main", mainRpcMethods["credentials.storeCredential"], [input]);
    },
    connect(input) {
      return rpc.call("main", mainRpcMethods["credentials.connect"], [input]);
    },
    configureClient(input) {
      return rpc.call("main", mainRpcMethods["credentials.configureClient"], [input]);
    },
    requestCredentialInput(input) {
      return rpc.call("main", mainRpcMethods["credentials.requestCredentialInput"], [input]);
    },
    getClientConfigStatus(input) {
      return rpc.call("main", mainRpcMethods["credentials.getClientConfigStatus"], [input]);
    },
    async deleteClientConfig(input) {
      const request = typeof input === "string" ? { configId: input } : input;
      await rpc.call("main", mainRpcMethods["credentials.deleteClientConfig"], [request]);
    },
    listStoredCredentials() {
      return rpc.call("main", mainRpcMethods["credentials.listStoredCredentials"], []);
    },
    summarizeStoredCredentials() {
      return rpc.call("main", mainRpcMethods["credentials.summarizeStoredCredentials"], []);
    },
    inspectStoredCredentials() {
      return rpc.call("main", mainRpcMethods["credentials.inspectStoredCredentials"], []);
    },
    async revokeCredential(credentialId) {
      await rpc.call("main", mainRpcMethods["credentials.revokeCredential"], [{ credentialId }]);
    },
    resolveCredential(input) {
      return rpc.call("main", mainRpcMethods["credentials.resolveCredential"], [input]);
    },
    deriveCredential(input) {
      return rpc.call("main", mainRpcMethods["credentials.deriveCredential"], [input]);
    },
    beginWebsitePublication(publication) {
      return rpc.call("main", mainRpcMethods["credentials.beginWebsitePublication"], [publication]);
    },
    recordWebsitePublication(publication, progress) {
      return rpc.call("main", mainRpcMethods["credentials.recordWebsitePublication"], [
        publication,
        progress,
      ]);
    },
    publishFetch(publication, url, init, opts) {
      return proxyFetch(rpc, url, init, opts, publication);
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
        fetch: (url, init) =>
          proxyFetch(rpc, url, init, { credentialId, audiences: descriptor.audiences }),
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
  opts?: {
    credentialId?: string | null;
    logicalCredential?: { name: string; remoteUrl: string };
    gitIntent?: ProxyGitHttpRequest["gitIntent"];
  }
): GitHttpClient {
  if (opts?.logicalCredential && opts.credentialId !== undefined) {
    throw new Error("gitHttp accepts either logicalCredential or credentialId, not both");
  }
  return {
    async request(request) {
      const body = request.body ? await collectGitBody(request.body) : undefined;
      const forward = (credentialId: string | null | undefined) =>
        rpc.stream(
          "main",
          mainRpcMethods["credentials.proxyGitHttp"],
          [
            {
              url: request.url,
              method: request.method ?? "GET",
              headers: request.headers ?? {},
              bodyBase64: body ? bytesToBase64(body) : undefined,
              credentialId,
              logicalCredential: opts?.logicalCredential,
              gitIntent: opts?.gitIntent,
            } satisfies ProxyGitHttpRequest,
          ],
          { trafficClass: "bulk" }
        );
      let result = await forward(
        opts?.credentialId === undefined && !opts?.logicalCredential ? null : opts?.credentialId
      );
      if (
        opts?.credentialId === undefined &&
        !opts?.logicalCredential &&
        (result.status === 401 || result.status === 403)
      ) {
        await result.body?.cancel();
        result = await forward(undefined);
      }
      return {
        url: result.url || request.url,
        method: request.method ?? "GET",
        statusCode: result.status,
        statusMessage: result.statusText,
        headers: Object.fromEntries(result.headers.entries()),
        body: (async function* () {
          if (!result.body) return;
          const reader = result.body.getReader();
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) return;
              yield next.value;
            }
          } finally {
            reader.releaseLock();
          }
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
  opts?: { credentialId?: string; audiences?: UrlAudience[] },
  publication?: WebsitePublicationIntent
): Promise<Response> {
  const requestedUrl = url.toString();
  const probe = new Request(requestedUrl, init);
  const headers = Object.fromEntries(probe.headers.entries());
  const encoded = await encodeRequestBody(init?.body, probe);
  const args = {
    url: requestedUrl,
    method: init?.method ?? "GET",
    headers,
    body: encoded.body,
    bodyBase64: encoded.bodyBase64,
    credentialId: opts?.credentialId,
    audiences: opts?.audiences,
  };
  const options = { signal: init?.signal ?? undefined };
  const response = publication
    ? await rpc.stream(
        "main",
        mainRpcMethods["credentials.publishFetch"],
        [args, publication],
        options
      )
    : await rpc.stream("main", mainRpcMethods["credentials.proxyFetch"], [args], options);
  if (!response.url) {
    Object.defineProperty(response, "url", {
      value: requestedUrl,
      writable: false,
      configurable: true,
    });
  }
  return response;
}

async function encodeRequestBody(
  body: BodyInit | null | undefined,
  request?: Request
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
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    return {
      // Read the Request's serialization so the bytes use the same generated
      // multipart boundary already present in its Content-Type header.
      bodyBase64: bytesToBase64(new Uint8Array(await request!.arrayBuffer())),
    };
  }
  throw new TypeError("credentials.fetch does not support streaming request bodies");
}
