import { Agent, type Dispatcher } from "undici";
import { resolveNetworkDestination, pinnedConnectionOptions } from "@vibestudio/shared/networkDestination";

export interface HostHttpRequest {
  url: URL;
  method: string;
  headers: HeadersInit;
  body?: BodyInit;
  signal: AbortSignal;
  dispatcher: Dispatcher;
  duplex?: "half";
  /** False when an enclosing idempotent-request policy owns retries. */
  retryPreconnect?: boolean;
  onPreconnectRetry?: () => void;
}

const PRECONNECT_CODES = new Set([
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ECONNREFUSED",
  "ECONNRESET",
  "EADDRNOTAVAIL",
]);
const absent = Symbol("missing error field");
function dataField(value: object, name: string): unknown {
  let current: object | null = value;
  for (let depth = 0; current && depth < 16; depth++, current = Object.getPrototypeOf(current)) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) {
      if (!("value" in descriptor))
        throw new Error("Error accessors cannot prove preconnect failure");
      return descriptor.value;
    }
  }
  return absent;
}

/** A generic fetch-head failure is not proof that a request was never sent. */
export function isProvenPreconnectFailure(error: unknown): boolean {
  const seen = new Set<object>();
  let remaining = 32;
  const inspect = (value: unknown): boolean => {
    if (!(value instanceof Error) || remaining-- <= 0 || seen.has(value)) return false;
    seen.add(value);
    const name = dataField(value, "name");
    if (typeof name !== "string" || !["Error", "TypeError", "AggregateError"].includes(name))
      return false;
    const cause = dataField(value, "cause"),
      errors = dataField(value, "errors");
    const code = dataField(value, "code"),
      syscall = dataField(value, "syscall");
    const children: unknown[] = [];
    if (cause !== absent && cause !== undefined) children.push(cause);
    if (errors !== absent) {
      if (!Array.isArray(errors) || !errors.length) return false;
      children.push(...errors);
    }
    if (children.length) {
      if (
        (code !== absent && !(typeof code === "string" && PRECONNECT_CODES.has(code))) ||
        (syscall !== absent && syscall !== "connect" && syscall !== "getaddrinfo")
      )
        return false;
      return children.every(inspect);
    }
    return (
      typeof code === "string" &&
      ((syscall === "connect" && PRECONNECT_CODES.has(code)) ||
        (syscall === "getaddrinfo" && code === "EAI_AGAIN"))
    );
  };
  try {
    return inspect(error);
  } catch {
    return false;
  }
}

function replayBody(body: BodyInit | undefined): { safe: boolean; body: BodyInit | undefined } {
  if (body == null || typeof body === "string" || body instanceof Blob) return { safe: true, body };
  if (body instanceof ArrayBuffer) return { safe: true, body: body.slice(0) };
  if (ArrayBuffer.isView(body))
    return {
      safe: true,
      body: new Uint8Array(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)),
    };
  if (body instanceof URLSearchParams) return { safe: true, body: new URLSearchParams(body) };
  return { safe: false, body };
}

/** The single host-owned HTTP request primitive used after caller policy checks. */
export async function requestHostHttp(input: HostHttpRequest): Promise<Response> {
  const { signal, dispatcher, method, duplex, onPreconnectRetry } = input;
  signal.throwIfAborted();
  if (
    !["http:", "https:"].includes(input.url.protocol) ||
    input.url.username ||
    input.url.password
  ) {
    throw new Error("Host HTTP requests require an HTTP(S) URL without user information");
  }
  const url = input.url.toString(),
    headers = new Headers(input.headers);
  const replay = replayBody(input.body);
  const retry =
    input.retryPreconnect !== false &&
    process.env["VIBESTUDIO_HTTP_PRECONNECT_RETRY"] !== "0" &&
    replay.safe;
  const options = {
    method,
    headers,
    body: replay.body,
    redirect: "manual",
    dispatcher,
    signal,
    ...(duplex ? { duplex } : {}),
  } as RequestInit & { dispatcher: Dispatcher };
  try {
    return await fetch(url, options);
  } catch (error) {
    if (!retry || signal.aborted || !isProvenPreconnectFailure(error)) throw error;
    onPreconnectRetry?.();
    signal.throwIfAborted();
    // The rejected fetch has settled; no connection/request was established.
    // The retry uses the same authorization, vetted dispatcher, URL and bytes.
    return fetch(url, options);
  }
}

/** Anonymous public reads for trusted host bootstrap inputs, pinned to vetted DNS. */
export async function withPublicHostHttp<T>(
  input: Omit<HostHttpRequest, "dispatcher">,
  consume: (response: Response) => Promise<T>
): Promise<T> {
  const destination = await resolveNetworkDestination(input.url, { kind: "public" }, input.signal);
  const dispatcher = new Agent({
    pipelining: 0,
    headersTimeout: 0,
    bodyTimeout: 0,
    connect: pinnedConnectionOptions(destination),
  });
  let result!: T;
  let failure: unknown;
  let failed = false;
  try {
    const response = await requestHostHttp({ ...input, dispatcher });
    result = await consume(response);
  } catch (error) {
    failed = true;
    failure = error;
  }
  try {
    await dispatcher.destroy();
  } catch (cleanupError) {
    if (failed) {
      throw new AggregateError(
        [failure, cleanupError],
        "Host HTTP request and dispatcher cleanup failed",
        { cause: failure }
      );
    }
    throw cleanupError;
  }
  if (failed) throw failure;
  return result;
}
