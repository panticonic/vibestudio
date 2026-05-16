import type { RpcCaller } from "@natstack/rpc";
import type {
  ClientConfigStatus,
  ConfigureClientRequest,
  ConnectCredentialRequest,
  DeleteClientConfigRequest,
  GetClientConfigStatusRequest,
  GrantUrlBoundCredentialRequest,
  ProxyGitHttpRequest,
  ProxyGitHttpResponse,
  RequestCredentialInputRequest,
  ResolveUrlBoundCredentialRequest,
  StoredCredentialSummary,
  StoreUrlBoundCredentialRequest,
} from "@natstack/shared/credentials/types";

export type {
  ClientConfigStatus,
  ConfigureClientRequest,
  ConnectCredentialRequest,
  DeleteClientConfigRequest,
  GetClientConfigStatusRequest,
  GrantUrlBoundCredentialRequest,
  ProxyGitHttpRequest,
  ProxyGitHttpResponse,
  RequestCredentialInputRequest,
  ResolveUrlBoundCredentialRequest,
  StoredCredentialSummary,
  StoreUrlBoundCredentialRequest,
} from "@natstack/shared/credentials/types";

export interface CredentialClient {
  store(input: StoreUrlBoundCredentialRequest): Promise<StoredCredentialSummary>;
  connect(input: ConnectCredentialRequest): Promise<StoredCredentialSummary>;
  configureClient(input: ConfigureClientRequest): Promise<ClientConfigStatus>;
  requestCredentialInput(input: RequestCredentialInputRequest): Promise<StoredCredentialSummary>;
  getClientConfigStatus(input: GetClientConfigStatusRequest): Promise<ClientConfigStatus>;
  deleteClientConfig(input: DeleteClientConfigRequest | string): Promise<void>;
  listStoredCredentials(): Promise<StoredCredentialSummary[]>;
  revokeCredential(credentialId: string): Promise<void>;
  grantCredential(input: GrantUrlBoundCredentialRequest): Promise<StoredCredentialSummary>;
  resolveCredential(input: ResolveUrlBoundCredentialRequest): Promise<StoredCredentialSummary | null>;
  fetch(
    url: string | URL,
    init?: RequestInit,
    opts?: { credentialId?: string },
  ): Promise<Response>;
  hookForUrl(
    url: string | URL,
    opts?: { credentialId?: string },
  ): (init?: RequestInit) => Promise<Response>;
  gitHttp(opts?: { credentialId?: string }): GitHttpClient;
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
    async store(input) {
      return rpc.call<StoredCredentialSummary>("main", "credentials.storeCredential", input);
    },
    async connect(input) {
      return rpc.call<StoredCredentialSummary>("main", "credentials.connect", input);
    },
    async configureClient(input) {
      return rpc.call<ClientConfigStatus>("main", "credentials.configureClient", input);
    },
    async requestCredentialInput(input) {
      return rpc.call<StoredCredentialSummary>("main", "credentials.requestCredentialInput", input);
    },
    async getClientConfigStatus(input) {
      return rpc.call<ClientConfigStatus>("main", "credentials.getClientConfigStatus", input);
    },
    async deleteClientConfig(input) {
      const request = typeof input === "string" ? { configId: input } : input;
      await rpc.call<void>("main", "credentials.deleteClientConfig", request);
    },
    async listStoredCredentials() {
      return rpc.call<StoredCredentialSummary[]>("main", "credentials.listStoredCredentials");
    },
    async revokeCredential(credentialId) {
      await rpc.call<void>("main", "credentials.revokeCredential", { credentialId });
    },
    async grantCredential(input) {
      return rpc.call<StoredCredentialSummary>("main", "credentials.grantCredential", input);
    },
    async resolveCredential(input) {
      return rpc.call<StoredCredentialSummary | null>("main", "credentials.resolveCredential", input);
    },
    async fetch(url, init, opts) {
      return proxyFetch(rpc, url, init, opts);
    },
    hookForUrl(url, opts) {
      return (init?: RequestInit) => proxyFetch(rpc, url, init, opts);
    },
    gitHttp(opts) {
      return createGitHttpClient(rpc, opts);
    },
  };
}

function createGitHttpClient(rpc: RpcCaller, opts?: { credentialId?: string }): GitHttpClient {
  return {
    async request(request) {
      const body = request.body ? await collectGitBody(request.body) : undefined;
      const result = await rpc.call<ProxyGitHttpResponse>("main", "credentials.proxyGitHttp", {
        url: request.url,
        method: request.method ?? "GET",
        headers: request.headers ?? {},
        bodyBase64: body ? bytesToBase64(body) : undefined,
        credentialId: opts?.credentialId,
      } satisfies ProxyGitHttpRequest);
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
  if (body instanceof Uint8Array) {
    return body;
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) {
    chunks.push(chunk);
  }
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function proxyFetch(
  rpc: RpcCaller,
  url: string | URL,
  init?: RequestInit,
  opts?: { credentialId?: string },
): Promise<Response> {
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  const encoded = await encodeRequestBody(init?.body);
  const requestedUrl = url.toString();
  const args = {
    url: requestedUrl,
    method: init?.method ?? "GET",
    headers,
    body: encoded.body,
    bodyBase64: encoded.bodyBase64,
    credentialId: opts?.credentialId,
  };

  // Streaming path: when the underlying bridge supports it (HTTP RPC
  // transport currently), route through `/rpc/stream` so the response
  // body is a real ReadableStream rather than a base64-buffered blob.
  // This is the path that makes model SSE responses, large `web_fetch`
  // downloads, and progressive UIs work without OOM'ing on a 50 MB
  // PDF or stalling until a multi-minute completion finishes streaming.
  const streamingBridge = rpc as Partial<{
    supportsStreaming?(): boolean;
    streamCall?(
      targetId: string,
      method: string,
      args: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<Response>;
  }>;
  if (
    typeof streamingBridge.supportsStreaming === "function" &&
    streamingBridge.supportsStreaming() &&
    typeof streamingBridge.streamCall === "function"
  ) {
    const wireResponse = await streamingBridge.streamCall(
      "main",
      "credentials.proxyFetch",
      [args],
      { signal: init?.signal ?? undefined },
    );
    return decodeStreamingResponse(wireResponse, requestedUrl, init?.signal);
  }

  // Buffered fallback: bridges without streaming (Electron IPC / WS)
  // use the regular RPC method. The response body is buffered and
  // base64-encoded on the wire but the Response API surface is
  // identical, so callers don't need to branch.
  const result = await rpc.call<{
    status: number;
    statusText: string;
    headerPairs: Array<[string, string]>;
    finalUrl: string;
    bodyBase64: string;
  }>("main", "credentials.proxyFetch", args);
  const bytes = result.bodyBase64 ? base64ToBytes(result.bodyBase64) : new Uint8Array(0);
  return buildResponse(bytes, result);
}

/**
 * Decode the binary-framed streaming response from `POST /rpc/stream`
 * into a `Response` with a true `ReadableStream` body. The decoder
 * forwards `DATA` frames into the stream as they arrive, surfaces
 * `ERROR` frames as stream errors, and closes the stream on `END` or
 * when the underlying HTTP body ends.
 *
 * The returned Promise resolves as soon as the `HEAD` frame is read
 * (so the caller has status/headers immediately); the body keeps
 * draining in the background.
 */
async function decodeStreamingResponse(
  wireResponse: Response,
  requestedUrl: string,
  callerSignal?: AbortSignal | null,
): Promise<Response> {
  const wireBody = wireResponse.body;
  if (!wireBody) {
    throw new Error("Streaming RPC response has no body");
  }

  // Lazy-import the codec so the panel bundle doesn't pull it in unless
  // the panel ever hits the streaming path (which today it doesn't).
  const {
    FRAME_HEAD,
    FRAME_DATA,
    FRAME_END,
    FRAME_ERROR,
    FrameDecoder,
    parseHeadFrame,
    parseErrorFrame,
  } = await import("@natstack/shared/credentials/streamFraming");

  type Head = ReturnType<typeof parseHeadFrame>;
  let resolveHead!: (h: Head | null) => void;
  let rejectHead!: (e: unknown) => void;
  const headPromise = new Promise<Head | null>((resolve, reject) => {
    resolveHead = resolve;
    rejectHead = reject;
  });

  let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let bodyClosed = false;
  let firstFrameSeen = false;

  const closeBody = (): void => {
    if (bodyClosed) return;
    bodyClosed = true;
    bodyController?.close();
  };
  const errorBody = (err: unknown): void => {
    if (bodyClosed) return;
    bodyClosed = true;
    bodyController?.error(err);
  };

  const decoder = new FrameDecoder((type, payload) => {
    firstFrameSeen = true;
    if (type === FRAME_HEAD) {
      try {
        resolveHead(parseHeadFrame(payload));
      } catch (err) {
        rejectHead(err);
      }
      return;
    }
    if (type === FRAME_DATA) {
      // Defensive copy: FrameDecoder slices from an internal buffer that
      // it'll discard, but the buffer view shares the underlying
      // ArrayBuffer until then. Copy to a stable Uint8Array so the
      // consumer can hold the reference safely.
      const copy = new Uint8Array(payload.byteLength);
      copy.set(payload);
      bodyController?.enqueue(copy);
      return;
    }
    if (type === FRAME_END) {
      closeBody();
      return;
    }
    if (type === FRAME_ERROR) {
      let parsed: { status: number; message: string; code?: string };
      try {
        parsed = parseErrorFrame(payload);
      } catch {
        parsed = { status: 502, message: "Streaming proxy fetch error" };
      }
      const error = new Error(parsed.message);
      (error as Error & { code?: string }).code = parsed.code;
      if (firstFrameSeen && bodyController) {
        // Head already emitted — surface as a stream error.
        errorBody(error);
      } else {
        // Head not yet emitted — reject the head promise so the caller
        // sees a thrown error rather than an empty Response.
        rejectHead(error);
      }
      return;
    }
    // Unknown frame type — ignore (forward-compat).
  });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      bodyController = controller;
    },
    cancel() {
      closeBody();
      // Best-effort: cancel the underlying wire body too so the server
      // sees the disconnect and aborts the upstream fetch.
      wireBody.cancel().catch(() => {});
    },
  });

  // Pump the wire body into the decoder in the background. Errors
  // observed mid-stream surface either as an ERROR frame (handled above)
  // or as a stream error on `stream` (if the HTTP body itself fails).
  void (async () => {
    const reader = wireBody.getReader();
    const onAbort = () => {
      reader.cancel().catch(() => {});
    };
    callerSignal?.addEventListener("abort", onAbort);
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          await decoder.push(value);
        }
      }
      if (!bodyClosed) {
        // Clean EOF without an explicit END frame — still treat as
        // success.
        closeBody();
      }
      // If head was never seen, the upstream produced nothing useful.
      // Resolve with null so the outer code can throw a descriptive
      // error.
      resolveHead(null);
    } catch (err) {
      if (firstFrameSeen) {
        errorBody(err);
      } else {
        rejectHead(err);
      }
    } finally {
      callerSignal?.removeEventListener("abort", onAbort);
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
  })();

  const head = await headPromise;
  if (!head) {
    throw new Error("Streaming proxy fetch returned no HEAD frame");
  }

  const response = new Response(stream as BodyInit, {
    status: head.status,
    statusText: head.statusText,
    headers: new Headers(head.headerPairs),
  });
  const finalUrl = head.finalUrl || requestedUrl;
  try {
    Object.defineProperty(response, "url", {
      value: finalUrl,
      writable: false,
      configurable: true,
    });
  } catch {
    // ignore — runtime locked the descriptor
  }
  return response;
}

/**
 * Build a `Response` that mirrors the upstream response as faithfully as
 * the RPC wire format allows. Specifically:
 *
 * - `new Headers(pairs)` preserves duplicate `Set-Cookie` entries (the
 *   Fetch spec doesn't combine them); `getSetCookie()` on the result
 *   returns the same array the upstream produced.
 * - `response.url` is shadowed onto the instance via `Object.defineProperty`
 *   because the `Response` constructor has no `url` option — the standard
 *   one is normally set by `fetch()`. We surface the post-redirect URL so
 *   callers can resolve relative links against the right base.
 */
function buildResponse(
  bytes: Uint8Array,
  result: {
    status: number;
    statusText: string;
    headerPairs: Array<[string, string]>;
    finalUrl: string;
  },
): Response {
  const response = new Response(bytes as BodyInit, {
    status: result.status,
    statusText: result.statusText,
    headers: new Headers(result.headerPairs),
  });
  if (result.finalUrl) {
    try {
      Object.defineProperty(response, "url", {
        value: result.finalUrl,
        writable: false,
        configurable: true,
      });
    } catch {
      // Some runtimes lock down Response.url's descriptor; if so, leave
      // it as the constructor default (empty string) rather than throw.
    }
  }
  return response;
}

/**
 * Encode a `RequestInit.body` for transport over the `credentials.proxyFetch`
 * RPC. String / URLSearchParams bodies cross the wire as UTF-8 text; binary
 * bodies (Uint8Array, ArrayBuffer, Blob, typed arrays) cross as base64.
 * Streams aren't supported — the RPC has no streaming envelope.
 */
async function encodeRequestBody(
  body: BodyInit | null | undefined,
): Promise<{ body?: string; bodyBase64?: string }> {
  if (body === undefined || body === null) return {};
  if (typeof body === "string") return { body };
  if (body instanceof URLSearchParams) return { body: body.toString() };
  if (body instanceof ArrayBuffer) {
    return { bodyBase64: bytesToBase64(new Uint8Array(body)) };
  }
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return { bodyBase64: bytesToBase64(bytes) };
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return { bodyBase64: bytesToBase64(new Uint8Array(await body.arrayBuffer())) };
  }
  throw new Error(
    "credentials.fetch supports string, URLSearchParams, ArrayBuffer, typed-array, and Blob request bodies",
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
