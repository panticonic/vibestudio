import { Agent, type Dispatcher } from "undici";
import { resolveNetworkDestination } from "./networkDestination.js";

export interface HostHttpRequest {
  url: URL;
  method: string;
  headers: HeadersInit;
  body?: BodyInit;
  signal: AbortSignal;
  dispatcher: Dispatcher;
}

/** The single host-owned HTTP request primitive used after caller policy checks. */
export function requestHostHttp(input: HostHttpRequest): Promise<Response> {
  input.signal.throwIfAborted();
  if (
    !["http:", "https:"].includes(input.url.protocol) ||
    input.url.username ||
    input.url.password
  ) {
    throw new Error("Host HTTP requests require an HTTP(S) URL without user information");
  }
  return fetch(input.url.toString(), {
    method: input.method,
    headers: input.headers,
    body: input.body,
    redirect: "manual",
    dispatcher: input.dispatcher,
    signal: input.signal,
  } as RequestInit & { dispatcher: Dispatcher });
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
    connect: { lookup: destination.lookup },
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
